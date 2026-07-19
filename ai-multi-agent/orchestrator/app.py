"""Orchestrator FastAPI surface (spec mục 6a) + shared contract (mục 4).

Endpoints:
  POST /runs                 create + start a workflow run
  GET  /runs/{id}            run status + per-step input/output (from SQLite)
  POST /runs/{id}/resume     continue after human review
  GET  /runs/{id}/events     SSE stream of status updates
  GET  /catalog              list the 6 AI agents (contract mục 4)
  GET  /agents               busy/idle per agent (observability)
  POST /invoke, GET /invoke/{runId}   single-unit invoke (contract parity)
  GET  /health
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from shared import config, db
from shared.schemas import CreateRunRequest, InvokeRequest, StepSpec
from orchestrator.engine import engine, R_DONE, R_FAILED
from orchestrator.events import bus

app = FastAPI(title="ai-multi-agent orchestrator", version="0.1.0")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


# ---- catalog (6 AI agents) ------------------------------------------------

_AGENT_META = {
    "parser": "Parse raw request into structured form",
    "planner": "Build a step-by-step plan from parsed input",
    "execution": "Execute the planned actions",
    "verification": "Verify execution results",
    "report": "Produce a report from results",
    "self_healing": "Detect and recover from failures",
}


def _catalog() -> list[dict[str, Any]]:
    out = []
    for name, desc in _AGENT_META.items():
        out.append({
            "id": name,
            "name": name.replace("_", " ").title(),
            "type": "ai_agent",
            "description": desc,
            "inputSchema": {"type": "object", "additionalProperties": True},
            "outputSchema": {"type": "object", "additionalProperties": True},
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
    run_id = engine.create_run(req)
    return {"runId": run_id}


@app.get("/runs/{run_id}")
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


# ---- single-unit invoke (contract parity with automation-server) ----------

def _single_step_run(unit_id: str, input_obj: dict[str, Any],
                     cfg: dict[str, Any] | None) -> str:
    step = StepSpec(
        stepKey=unit_id,
        unitId=unit_id,
        unitType="ai_agent",
        source="ai",
        config=cfg or {},
    )
    req = CreateRunRequest(input=input_obj, steps=[step])
    return engine.create_run(req)


@app.post("/invoke")
def invoke(req: InvokeRequest):
    if req.unitId not in _AGENT_META:
        raise HTTPException(status_code=404, detail=f"unknown unitId: {req.unitId}")
    run_id = _single_step_run(req.unitId, req.input, req.config)
    return {"runId": run_id}


@app.get("/invoke/{run_id}")
def invoke_result(run_id: str):
    run = engine.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="unknown runId")
    steps = db.get_steps(run_id)
    step = steps[0] if steps else None
    status_map = {"running": "running", "paused_for_human": "running",
                  "done": "done", "failed": "failed"}
    return {
        "status": status_map.get(run.status, run.status),
        "input": step["input"] if step else None,
        "output": step["output"] if step else None,
        "done": run.status == R_DONE,
    }
