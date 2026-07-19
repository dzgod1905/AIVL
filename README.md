# Workflow Builder + AI Multi-Agent (PoC)

Build multi-step workflows where each step is an **AI agent** or an **automation
tool**, pulled from a dynamic catalog merged from two services. An orchestrator
(itself a peer agent) coordinates: it decides the next runnable steps, pushes work
onto per-agent queues (idle workers pull it), runs independent branches in
parallel, persists per-step IO, re-asks agents that report "not done", and pauses
for human-in-the-loop.

## Architecture

```
web (Next.js/Neon)  --SSE-->  orchestrator (FastAPI)
       |  /api/catalog merge          |  Celery tasks -> Redis queues
       v                              v
 automation-server (FastAPI)    6 dummy agents (Celery workers)
```

- **contracts/openapi.yaml** — shared `catalog + invoke + health` contract. Both
  `ai-multi-agent` and `automation-server` implement it, so the web treats agents
  and automation tools identically.
- **automation-server/** — FastAPI dummy: 7 automation tools, `invoke` returns done.
- **ai-multi-agent/** — one package, peers sharing `shared/`:
  - `agents/` — Parser, Planner, Execution, Verification, Report, Self-Healing.
    Each is a Celery task on its own queue. Simulated: reports `done=false` for the
    first N attempts (default 1) then `done=true`; `config.stuck=true` never finishes.
  - `orchestrator/` — FastAPI surface + DAG state machine (`engine.py`). Peer that
    only coordinates; work distribution is pull-based via Redis/Celery.
  - `shared/` — celery app, SQLite (per-step IO JSON), http client, config, schemas.
- **web/** — Next.js App Router + Drizzle + Neon. Builder, run monitor (SSE),
  human-in-the-loop. Stores only workflow definition + run metadata; detailed IO is
  queried from the orchestrator.

## Parallelism

Two levels, both handled by Celery/Redis (no hand-written scheduler):
1. Between different workflows (runs).
2. Between independent steps in one workflow — every step whose `dependsOn` is
   satisfied is dispatched at once.

## Run locally

### 1. Backend (Redis + orchestrator + workers + automation-server)

Requires Docker.

```bash
docker compose up --build
```

Exposes:
- orchestrator API: http://localhost:8001  (`/catalog`, `/agents`, `/health`, `/runs`)
- automation-server: http://localhost:8002  (`/catalog`, `/health`)

Without Docker, use `uv` per Python service:

```bash
# terminal 1: redis (must be running on localhost:6379)
# terminal 2: automation-server
cd automation-server && uv run uvicorn main:app --port 8002
# terminal 3: orchestrator API
cd ai-multi-agent && uv run uvicorn orchestrator.app:app --port 8001
# terminal 4: celery workers (all 6 queues)
cd ai-multi-agent && uv run sh worker.sh
```

**No Redis at all (eager mode).** Set `CELERY_EAGER=1` and the orchestrator runs
agents in-process - no broker, no separate worker terminal. Only 2 servers:

```bash
# terminal 1: automation-server
cd automation-server && uvicorn main:app --host 127.0.0.1 --port 8002
# terminal 2: orchestrator (agents inline)
cd ai-multi-agent && CELERY_EAGER=1 AUTOMATION_SERVER_URL=http://127.0.0.1:8002 \
  uvicorn orchestrator.app:app --host 127.0.0.1 --port 8001
```

Independent branches still dispatch together (visible over SSE); true distributed
parallelism across worker instances needs the Redis + workers setup above.

### 2. Web

```bash
cd web
cp .env.example .env        # set DATABASE_URL to your Neon URL
npm install
npm run db:push             # create tables in Neon
npm run db:seed             # seed 3 demo workflows
npm run dev                 # http://localhost:3000
```

Vercel: set Root Directory = `web`, env vars `DATABASE_URL`, `AI_MULTI_AGENT_URL`,
`AUTOMATION_SERVER_URL`.

## Environment variables

| Service | Vars |
|---------|------|
| ai-multi-agent | `REDIS_URL`, `SQLITE_PATH`, `AUTOMATION_SERVER_URL`, `DEFAULT_SIMULATE_INCOMPLETE`, `DEFAULT_MAX_ATTEMPTS`, `DEFAULT_TIMEOUT_SEC`, `REASK_DELAY_SEC` |
| automation-server | `PORT` |
| web | `DATABASE_URL`, `AI_MULTI_AGENT_URL`, `AUTOMATION_SERVER_URL` |

## Demo (end-to-end)

Seed creates 3 workflows (or build your own at `/builder`):

1. **Demo Linear (human pause)** — Parser -> Planner(`human_involved`) -> Execution.
   Run it: Parser done, Planner done, run stops at `paused_for_human`. The web shows
   Planner input/output. At least one agent reports `done=false` once first (see the
   orchestrator "re-ask" log). Click **Continue** -> Execution runs -> run `done`.
2. **Demo Branch (parallel)** — Execution -> (Verification, Report both depend on
   Execution) -> Self-Healing (depends on both). Verification & Report run in
   parallel; Self-Healing runs only after both are `done`.
3. **Demo Timeout (stuck agent)** — Execution points at a stuck agent -> orchestrator
   re-asks up to `maxAttempts`/`timeoutSec` then sets step + run = `failed` with
   `fail_reason` (no infinite loop).

Run two workflows at once and watch `GET http://localhost:8001/agents` to see agents
dispatched in parallel.

## Quick API test (no web)

```bash
# catalog (6 AI agents)
curl http://localhost:8001/catalog
# automation tools
curl http://localhost:8002/catalog

# start a 2-step run
curl -s -X POST http://localhost:8001/runs -H 'content-type: application/json' -d '{
  "workflowId": "demo",
  "input": {"request": "hello"},
  "steps": [
    {"stepKey":"parser","unitId":"parser","unitType":"ai_agent","source":"ai","dependsOn":[]},
    {"stepKey":"planner","unitId":"planner","unitType":"ai_agent","source":"ai","dependsOn":["parser"],"humanInvolved":true}
  ]
}'
# -> {"runId":"..."}; then:
curl http://localhost:8001/runs/<runId>
curl -N http://localhost:8001/runs/<runId>/events     # SSE
curl -X POST http://localhost:8001/runs/<runId>/resume
```
