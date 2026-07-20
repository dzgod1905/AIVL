"""HTTP client to automation-server (for steps that are automation tools)."""
from __future__ import annotations

import time
from typing import Any

import httpx

from shared import config


def _auth_headers() -> dict[str, str]:
    """Bearer header for automation-server. Empty token => no header (dev)."""
    tok = config.AUTOMATION_API_TOKEN
    return {"Authorization": f"Bearer {tok}"} if tok else {}


def automation_invoke(unit_id: str, input_obj: dict[str, Any], cfg: dict[str, Any] | None = None,
                      timeout_sec: float = 30.0) -> dict[str, Any]:
    """Invoke an automation tool and poll until done or timeout.

    Returns the final result dict: { status, input, output, done }.
    """
    base = config.AUTOMATION_SERVER_URL.rstrip("/")
    with httpx.Client(timeout=10.0, headers=_auth_headers()) as client:
        r = client.post(f"{base}/invoke", json={"unitId": unit_id, "input": input_obj, "config": cfg or {}})
        r.raise_for_status()
        run_id = r.json()["runId"]

        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            pr = client.get(f"{base}/invoke/{run_id}")
            pr.raise_for_status()
            data = pr.json()
            if data.get("done"):
                return data
            time.sleep(0.25)
        return {"status": "failed", "input": input_obj, "output": None, "done": False}
