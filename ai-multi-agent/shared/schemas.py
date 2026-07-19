"""Pydantic models mirroring the shared contract + orchestrator run API."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---- shared contract (mục 4) ---------------------------------------------

class Unit(BaseModel):
    id: str
    name: str
    type: Literal["ai_agent", "automation_tool"]
    description: str
    inputSchema: dict[str, Any]
    outputSchema: dict[str, Any]
    configurable: bool


class InvokeRequest(BaseModel):
    unitId: str
    input: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] | None = None


# ---- orchestrator run API (mục 6a) ---------------------------------------

class StepSpec(BaseModel):
    stepKey: str
    unitId: str
    unitType: Literal["ai_agent", "automation_tool"]
    source: Literal["ai", "automation"]
    promptTemplate: str | None = None
    contextMapping: dict[str, str] = Field(default_factory=dict)
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
