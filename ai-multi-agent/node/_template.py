"""TEMPLATE - copy this file to add a new tool. It is INERT: nothing imports it,
so it registers no task until you wire it into node/registry.py.

How to use:
  1. Copy to node/<category>/<tool>.py. Reuse an existing category package
     (parser, ai_agent, ...) or create a new one with a node/<category>/__init__.py
     docstring.
  2. Rename NAME to your tool id (lowercase; it is the Celery task suffix).
  3. Fill in SPEC (name / category / description / params) and _build_output.
  4. Register it in node/registry.py: import the module and append it to _MODULES
     (one line). Everything else - the /catalog listing, queue routing, the
     worker's queue set, the task dispatch map, category grouping and the
     POST /runs validation set - is DERIVED from SPEC, so no other file is edited.
     See docs/adding-a-tool.md.

Two kinds of tool, chosen by the run_step `always_done` flag at the bottom:
  - Code tool (deterministic parser/transform): finishes on the first attempt ->
    always_done=True. Reference: node/parser/excel_reader.py.
  - AI-style tool (may need a few tries): reports done=false a bounded number of
    times before done=true -> leave always_done at its default False. The
    orchestrator re-asks until done, capped by the step's maxAttempts/timeoutSec.
    Reference: node/ai_agent/ai_agent.py.
"""
from __future__ import annotations

from typing import Any

from shared.celery_app import celery_app
from node.base import run_step

# Tool id. MUST equal SPEC["id"] and the Celery task suffix (node.<NAME>).
NAME = "template"

# Self-describing catalog entry. node/registry.py derives every other table from
# this dict, so SPEC is the ONLY thing you author for a new tool.
SPEC = {
    "id": NAME,
    "name": "Template Tool",            # display name in the builder
    "category": "example",              # builder grouping (reuse "parser"/"ai_agent" or a new label)
    "description": "What this tool does, shown to the user in the builder.",
    "outputSchema": {"type": "object", "additionalProperties": True},
    # User-configurable settings. The builder renders each descriptor generically
    # (no per-tool UI code), reading/writing payload["config"][key]. Two kinds:
    #   required=True  -> always shown, not removable (a fixed row seeded with
    #                     `default` when the step is created).
    #   required unset -> optional; the user adds it via "+ Add setting" and can
    #                     remove it again.
    # Descriptor fields:
    #   key          config key the tool reads (payload["config"][key]).
    #   label        shown in the builder.
    #   type         "string" | "text" | "number" | "boolean" | "enum".
    #                "text" renders a multi-line box and accepts {{step.output}}
    #                variables; "enum" also needs an "options" list.
    #   default      value used when the field is absent.
    #   options      enum only: the allowed values.
    #   placeholder  optional input hint.
    #   description  optional help line under the field.
    "params": [
        {
            "key": "mode",
            "label": "Mode",
            "type": "enum",
            "options": ["fast", "full"],
            "default": "fast",
            "required": True,
            "description": "A required setting: always shown, cannot be removed.",
        },
        {
            "key": "limit",
            "label": "Row limit",
            "type": "number",
            "default": 0,
            "placeholder": "0 = no limit",
            "description": "An optional setting: added via + Add setting.",
        },
    ],
}


def _build_output(input_obj: dict[str, Any], conf: dict[str, Any], attempt: int) -> dict[str, Any]:
    """Shape this step's `output` (any JSON-serializable dict).

    input_obj : the input the step received. Session inputs (the chat file/text)
                are opt-in per step: a tool that wants them declares a source
                param the engine recognizes (e.g. take_input_from="session") or
                the step enables the `session` flag; input_obj then carries
                session_text / file / file_b64. {{stepKey.output}} variables are
                resolved upstream before the task runs.
    conf      : the user's per-step config (the SPEC params above). Read with
                conf.get(key, default).
    attempt   : 1-based attempt counter (only grows for AI-style re-asks).
    """
    mode = str(conf.get("mode", "fast") or "fast")
    limit = int(conf.get("limit", 0) or 0)
    return {"mode": mode, "limit": limit, "result": "replace me"}


@celery_app.task(name="node.template")      # name MUST be node.<NAME>
def run(payload: dict[str, Any]) -> dict[str, Any]:
    # always_done=True for a deterministic code tool; remove it for an AI-style
    # tool that may report done=false before finishing.
    return run_step(NAME, payload, _build_output, always_done=True)
