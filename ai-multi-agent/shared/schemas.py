"""Pydantic models mirroring the shared contract + orchestrator run API."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---- orchestrator run API (mục 6a) ---------------------------------------
# NB: the /catalog response is built as plain dicts in app.py (it carries an
# extra `category` field the builder groups by), so there is no Unit model here.

class StepSpec(BaseModel):
    stepKey: str
    unitId: str
    unitType: Literal["ai_agent", "automation_tool"]
    source: Literal["ai", "automation"]
    promptTemplate: str | None = None
    # dependsOn is NOT a scheduler input (steps run in order). It records which
    # prior steps a prompt references, for {{stepKey.output}} variable resolution.
    dependsOn: list[str] = Field(default_factory=list)
    humanInvolved: bool = False
    maxAttempts: int = 5
    timeoutSec: int = 30
    # Optional per-step agent behavior knobs (dummy simulation).
    config: dict[str, Any] = Field(default_factory=dict)


class CreateRunRequest(BaseModel):
    workflowId: str | None = None
    input: dict[str, Any] = Field(default_factory=dict)
    steps: list[StepSpec]


class StepView(BaseModel):
    stepKey: str
    status: str
    input: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    done: bool = False
    attempts: int = 0
    fail_reason: str | None = None


class RunView(BaseModel):
    status: str
    steps: list[StepView]
