# Adding a tool (and category)

How to add a new **tool** (unit) to the `ai-multi-agent` backend, and how a new
**category** falls out of it.

Terms:

- **tool / unit** = one Celery task that runs a workflow step (e.g. `ai_agent`,
  `excel_reader`).
- **category** = the group a tool shows under in the builder UI (e.g. `ai_agent`,
  `parser`). Just a label; every unit still runs through the same Celery path
  (`unitType` stays `"ai_agent"`).

The design is **self-describing**: each tool module carries a `SPEC` dict, and
`node/registry.py` derives everything else from it - the `/catalog` listing,
Celery queue routing, the worker's queue set, the task dispatch map, category
grouping, and the `POST /runs` validation set. So adding a tool is **one new file
plus one line** in the registry. No edits to `orchestrator/app.py`,
`shared/config.py`, `shared/celery_app.py`, `worker.sh`, or the compose files.

---

## Steps

### 1. (New category only) create the package

`node/<category>/__init__.py`:

```python
"""Category: <category> - short description of what this group of tools does."""
```

Reuse the existing package if the category already exists, and skip this step.

### 2. Write the tool

Fastest start: copy `node/_template.py` (an inert, fully commented skeleton) to
`node/<category>/<tool>.py` and fill it in.

`node/<category>/<tool>.py`. Every tool shares the `node.base.run_step` helper,
declares a module-level `SPEC`, and registers a Celery task named `node.<id>`
where `id` equals `NAME` and `SPEC["id"]`.

Two kinds of tool:

- **Code tool** (deterministic, e.g. a parser): finishes on the first attempt,
  pass `always_done=True`.
- **AI-style tool**: may report `done=false` a few times before finishing
  (simulates long-running); leave `always_done` as its default `False`.

Minimal code tool:

```python
"""<Tool name> unit (category: <category>). Describe input/output."""
from __future__ import annotations

from typing import Any

from shared.celery_app import celery_app
from node.base import run_step

NAME = "<tool>"

# Self-describing catalog entry. registry.py derives catalog/routing/queues/task
# map/grouping from this. id MUST equal NAME (and the task suffix node.<id>).
SPEC = {
    "id": NAME,
    "name": "<Display name>",
    "category": "<category>",
    "description": "Shown to the user in the builder.",
    "outputSchema": {"type": "object", "additionalProperties": True},
    "params": [  # user-configurable settings; see "Config params" below
        {"key": "mode", "label": "Mode", "type": "enum",
         "options": ["fast", "full"], "default": "fast", "required": True},
        {"key": "limit", "label": "Row limit", "type": "number", "default": 0},
    ],
}


def _build_output(input_obj: dict[str, Any], conf: dict[str, Any], attempt: int) -> dict[str, Any]:
    # Shape the step's "output". Read input_obj (the input the step received)
    # and conf (the user's per-step config, i.e. the SPEC params above).
    return {"mode": conf.get("mode", "fast"), "result": "..."}


@celery_app.task(name="node.<tool>")
def run(payload: dict[str, Any]) -> dict[str, Any]:
    return run_step(NAME, payload, _build_output, always_done=True)
```

Notes:

- `payload` has `input`, `attempt`, `config`. `run_step` unpacks them and wraps
  the result as `{ input, agent, done, attempt, output }` - you do not set `done`
  yourself.
- Reference implementations: `node/parser/excel_reader.py` (code tool) and
  `node/ai_agent/ai_agent.py` (AI tool with a real key pool).

### 2b. Config params (user settings)

`SPEC["params"]` is a list of descriptors. The builder renders each one
generically (no per-tool UI code) and stores the value in the step's config; the
tool reads it back via `conf.get(key, default)`. Adding a param never touches the
frontend.

Two kinds:

- **required** (`"required": True`): always shown as a fixed row, cannot be
  removed. Seeded with `default` when the step is created.
- **optional** (omit `required`): the user adds it from the **+ Add setting** row
  and can remove it again.

Descriptor fields:

| Field | Meaning |
|-------|---------|
| `key` | config key the tool reads (`conf[key]`). |
| `label` | shown in the builder. |
| `type` | `string` \| `text` \| `number` \| `boolean` \| `enum`. `text` is a multi-line box that accepts `{{step.output}}` variables; `enum` also needs `options`. |
| `default` | value used when the field is absent. |
| `options` | enum only: the allowed values. |
| `placeholder` / `description` | optional UI hints. |

Session input (the chat file/text) is not a param the tool declares blindly: a
tool opts in either with the step's `session` flag or by declaring a source param
the engine recognizes (e.g. `excel_reader`'s required `take_input_from` enum set
to `"session"`). The engine then feeds `session_text` / `file` / `file_b64` into
the step input.

### 3. Register it (the one line)

`node/registry.py`: import the module and append it to `_MODULES`.

```python
from node.<category> import <tool>          # add import

_MODULES: list[ModuleType] = [ai_agent, excel_reader, <tool>]   # append here
```

That is the only edit. `UNITS`, `TASK_BY_AGENT`, `CATEGORIES`, `UNIT_IDS` and
`QUEUES` all rebuild from `SPEC` on import.

### 4. (Optional) nice category label in the UI

A new category already shows up (the builder groups dynamically by `category`).
For a prettier label than the raw id, add it to `CATEGORY_LABEL` in
`web/src/app/builder/page.tsx`:

```ts
const CATEGORY_LABEL: Record<string, string> = {
  ai_agent: "AI Agent",
  parser: "Parser",
  "<category>": "<Nice label>",
};
```

---

## What is derived (and why no other edits)

| Concern | Source | Where |
|---------|--------|-------|
| `/catalog` listing | `SPEC` per tool -> `registry.UNITS` | `orchestrator/app.py` imports `UNITS` |
| Task dispatch (eager) | `registry.TASK_BY_AGENT` | `shared/celery_app.py` eager `send_task` |
| Queue routing | task name `node.<id>` -> `queue:<id>` | dynamic router in `shared/celery_app.py` |
| Worker queue set | `registry.QUEUES` | `worker.sh` (`-Q` derived at start) |
| Worker pool size | `WORKFLOW_CONCURRENCY x SESSION_CONCURRENCY` | `worker.sh` |
| `POST /runs` validation | `registry.UNIT_IDS` | `orchestrator/app.py` |
| Category grouping | `SPEC["category"]` -> `registry.CATEGORIES` | builder groups client-side |

Because routing and queues come from the task name and the registry, a new
`queue:<tool>` is created and consumed automatically - nothing to add to
`config`, compose, or the worker command.

---

## Checklist

Add a **tool** (existing category):

- [ ] Copy `node/_template.py` to `node/<category>/<tool>.py`
- [ ] Set `SPEC` (`id == NAME`), `params`, `_build_output`, and `@celery_app.task(name="node.<tool>")`
- [ ] `node/registry.py`: one import + append to `_MODULES`

Add a **new category** too:

- [ ] the two boxes above
- [ ] `node/<category>/__init__.py` (category docstring)
- [ ] `web/.../builder/page.tsx` `CATEGORY_LABEL` (optional label)

## Quick check

```sh
# eager mode: no Redis / no separate worker needed
CELERY_EAGER=1 uvicorn orchestrator.app:app --port 8001

curl -s localhost:8001/catalog | jq '.[] | {id, category}'   # new tool appears
```

Then in the builder: pick the category -> pick the tool -> run a workflow and
confirm the step `output` is what you expect.
