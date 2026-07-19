"""Dummy automation-server. Implements the shared contract (contracts/openapi.yaml).

Same catalog+invoke surface as ai-multi-agent so the web treats automation tools
and AI agents identically. No real logic: invoke returns done=true after a small
simulated delay.
"""
from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="automation-server (dummy)", version="0.1.0")

# ---- catalog seed ---------------------------------------------------------

_TOOLS = [
    ("can_adapter", "CAN Adapter", "Send/receive CAN bus frames"),
    ("lin_tool", "LIN Tool", "LIN bus master/slave simulation"),
    ("someip_eth", "SOME/IP Ethernet", "Automotive Ethernet SOME/IP messaging"),
    ("hmi_touch", "HMI (Touch/Swipe)", "Simulate touch and swipe gestures on HMI"),
    ("battery_onoff", "Battery ON/OFF", "Toggle vehicle battery power"),
    ("usb_control", "USB Control", "Plug/unplug and control USB devices"),
    ("screenshot_record", "Screenshot/Record", "Capture screenshot or record screen"),
]


def _catalog() -> list[dict[str, Any]]:
    items = []
    for tid, name, desc in _TOOLS:
        items.append(
            {
                "id": tid,
                "name": name,
                "type": "automation_tool",
                "description": desc,
                "inputSchema": {
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "additionalProperties": True,
                },
                "outputSchema": {
                    "type": "object",
                    "properties": {"result": {"type": "string"}},
                    "additionalProperties": True,
                },
                "configurable": True,
            }
        )
    return items


_CATALOG_IDS = {t[0] for t in _TOOLS}

# ---- invoke store (in-memory) --------------------------------------------

# runId -> state dict
_RUNS: dict[str, dict[str, Any]] = {}


class InvokeRequest(BaseModel):
    unitId: str
    input: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] | None = None


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/catalog")
def catalog():
    return _catalog()


@app.post("/invoke")
def invoke(req: InvokeRequest):
    if req.unitId not in _CATALOG_IDS:
        raise HTTPException(status_code=404, detail=f"unknown unitId: {req.unitId}")
    run_id = uuid.uuid4().hex
    # Dummy: complete immediately (record created_at so poll can fake a short delay).
    _RUNS[run_id] = {
        "unitId": req.unitId,
        "input": req.input,
        "config": req.config or {},
        "created_at": time.time(),
    }
    return {"runId": run_id}


@app.get("/invoke/{run_id}")
def invoke_result(run_id: str):
    st = _RUNS.get(run_id)
    if st is None:
        raise HTTPException(status_code=404, detail="unknown runId")
    # Simulate ~0.5s of "running" then done.
    elapsed = time.time() - st["created_at"]
    if elapsed < 0.5:
        return {"status": "running", "input": st["input"], "output": None, "done": False}
    return {
        "status": "done",
        "input": st["input"],
        "output": {
            "result": f"{st['unitId']} executed",
            "tool": st["unitId"],
            "echo": st["input"],
        },
        "done": True,
    }
