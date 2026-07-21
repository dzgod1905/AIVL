"""Orchestrator FastAPI surface (spec mục 6a) + shared contract (mục 4).

Endpoints:
  POST /runs                 create + start a workflow run
  GET  /runs/{id}            run status + per-step input/output (from SQLite)
  POST /runs/{id}/resume     continue after human review
  GET  /runs/{id}/events     SSE stream of status updates
  GET  /catalog              list the AI/parser units (contract mục 4)
  GET  /agents               busy/idle per agent (observability)
  GET  /health
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from shared import config, db
from shared.schemas import CreateRunRequest, RunView
from orchestrator.engine import engine, R_DONE, R_FAILED
from orchestrator.events import bus
from node.registry import UNITS, UNIT_IDS

log = logging.getLogger("orchestrator.app")


def _require_token(request: Request) -> None:
    """Bearer-token gate applied to every route except /health.

    Empty API_TOKEN disables the check (local dev). When set, callers must send
    `Authorization: Bearer <token>`; compared in constant time.
    """
    if request.url.path == "/health":
        return
    expected = config.API_TOKEN
    if not expected:
        return  # auth disabled (dev only)
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if not hmac.compare_digest(auth[7:], expected):
        raise HTTPException(status_code=403, detail="invalid token")


app = FastAPI(
    title="ai-multi-agent orchestrator",
    version="0.1.0",
    dependencies=[Depends(_require_token)],
)

if not config.API_TOKEN:
    log.warning("ORCH_API_TOKEN is empty: orchestrator auth DISABLED (dev only). "
                "Set ORCH_API_TOKEN before any multi-machine deployment.")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


# ---- catalog (units grouped by category) ----------------------------------
# Every unit runs through the same Celery/agent path (type stays "ai_agent").
# `category` groups them in the builder: "ai_agent" (prompt runner) vs "parser"
# (code tools that parse data). The unit list comes from node/registry.py (each
# tool's SPEC); adding a tool needs no edit here. See docs/adding-a-tool.md.


def _catalog() -> list[dict[str, Any]]:
    out = []
    for u in UNITS:
        out.append({
            "id": u["id"],
            "name": u["name"],
            "type": "ai_agent",
            "category": u["category"],
            "description": u["description"],
            "inputSchema": {"type": "object", "additionalProperties": True},
            "outputSchema": u["outputSchema"],
            "params": u.get("params", []),
            "configurable": True,
        })
    return out


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/catalog")
def catalog():
    return _catalog()


@app.get("/agents")
def agents():
    return engine.agents_status()


# ---- workflow runs --------------------------------------------------------

@app.post("/runs")
def create_run(req: CreateRunRequest):
    # Validate every ai_agent step's unitId. The engine dispatches non-automation
    # steps via send_task(f"node.{unitId}"); an unknown unitId would be an
    # attacker-controlled task name. automation_tool units are validated remotely
    # by automation-server on /invoke.
    for s in req.steps:
        if s.unitType == "ai_agent" and s.unitId not in UNIT_IDS:
            raise HTTPException(status_code=400,
                                detail=f"unknown ai_agent unitId: {s.unitId}")
    run_id = engine.create_run(req)
    return {"runId": run_id}


@app.get("/runs/{run_id}", response_model=RunView)
def get_run(run_id: str):
    run = engine.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="unknown runId")
    steps = db.get_steps(run_id)
    step_views = [
        {
            "stepKey": s["step_key"],
            "status": s["status"],
            "input": s["input"],
            "output": s["output"],
            "done": s["done"],
            "attempts": s["attempts"],
            "fail_reason": s["fail_reason"],
        }
        for s in steps
    ]
    return {"status": run.status, "steps": step_views}


@app.post("/runs/{run_id}/resume")
def resume_run(run_id: str):
    ok = engine.resume(run_id)
    if not ok:
        raise HTTPException(status_code=409, detail="run not paused_for_human or unknown")
    return {"ok": True}


@app.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request):
    run = engine.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="unknown runId")

    q = bus.subscribe(run_id)

    async def gen():
        try:
            # initial snapshot
            snapshot = {"type": "snapshot", "status": run.status,
                        "steps": {k: v for k, v in run.step_status.items()}}
            yield f"data: {json.dumps(snapshot)}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.to_thread(q.get, True, 1.0)
                except Exception:
                    # timeout -> heartbeat, then re-check terminal state
                    yield ": keepalive\n\n"
                    if run.status in (R_DONE, R_FAILED):
                        break
                    continue
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") == "run_status" and event.get("status") in (R_DONE, R_FAILED):
                    break
        finally:
            bus.unsubscribe(run_id, q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
