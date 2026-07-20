# Databases

There are **two separate databases**. They hold different things and never share
a connection.

| DB | Engine | Owner | Holds | Persistence |
|----|--------|-------|-------|-------------|
| web DB | Neon Postgres (cloud) | web (Drizzle) | workflow definitions, sessions, one metadata row per run | Neon cloud |
| orchestrator-db | Postgres in the ai-multi-agent stack (SQLite file as dev fallback) | orchestrator | detailed per-step input/output JSON | Docker volume `orch-db-data` |

The split is deliberate: the web keeps only *what a workflow is* and *that a run
happened*; the heavy per-step IO lives in orchestrator-db, which the web reads on
demand through the orchestrator REST API (`GET /runs/{id}`) rather than storing
itself.

## Web DB (Neon) - schema

Defined in `web/src/db/schema.ts` (Drizzle).

- **workflows** `(id uuid, name, created_at)` - a saved workflow.
- **workflow_steps** `(id, workflow_id, order, step_key, unit_id, unit_type,
  source, prompt_template, api_config jsonb, depends_on jsonb, human_involved,
  max_attempts, timeout_sec)` - the ordered steps of a workflow. `unit_type` is
  `ai_agent | automation_tool`; `depends_on` records which prior steps a prompt
  references (for `{{stepKey.output}}`), not scheduling.
- **sessions** `(id, workflow_id, title, created_at)` - a chat session groups
  runs of one workflow; sessions run independently.
- **workflow_runs** `(id, workflow_id, session_id, orchestrator_run_id, input
  jsonb, status, created_at)` - **one row per run**. `orchestrator_run_id` is the
  pointer into orchestrator-db. `input` is kept so a session's chat history can be
  rebuilt on reload. No per-step IO here.

## orchestrator-db - schema

Defined in `ai-multi-agent/shared/db.py`. Same DDL works on Postgres and SQLite.

- **runs** `(id TEXT pk, workflow_id, status, created_at)` - one row per run.
  `status`: `running | paused_for_human | done | failed`.
- **step_runs** `(id TEXT pk, run_id, step_key, agent, status, input_json,
  output_json, attempts, max_attempts, started_at, done, fail_reason)` - one row
  per step of a run. `input_json` / `output_json` are JSON strings. Indexed by
  `run_id`.

`runs.id` == `workflow_runs.orchestrator_run_id` in the web DB. That is the only
link between the two databases; there is no cross-DB foreign key.

### Postgres vs SQLite

`db.py` chooses the backend at import time: **Postgres** if `ORCH_DATABASE_URL` is
set, otherwise the **SQLite** file at `SQLITE_PATH`. The Docker stacks always set
`ORCH_DATABASE_URL` (to the in-network `orchestrator-db`), so Docker = Postgres.
SQLite is only the zero-config local/eager fallback.

## Inspecting orchestrator-db in Docker

```bash
# from the ai-multi-agent stack directory (or use the root all-in-one file)
docker compose exec orchestrator-db psql -U orch -d orchestrator

#   \dt                                   list tables (runs, step_runs)
#   SELECT id, workflow_id, status FROM runs ORDER BY created_at DESC LIMIT 10;
#   SELECT step_key, agent, status, attempts, done
#     FROM step_runs WHERE run_id = '<run id>' ORDER BY started_at;
#   SELECT output_json FROM step_runs WHERE id = '<step id>';
```

One-liner without opening a shell:

```bash
docker compose exec -T orchestrator-db \
  psql -U orch -d orchestrator -c "SELECT count(*) FROM runs;"
```

### Persistence

- orchestrator-db data lives in the named volume `orch-db-data`.
- `docker compose down` keeps the volume; `docker compose down -v` **deletes** it.
- The web's Neon DB is independent of Docker entirely.

## Injection safety

All orchestrator-db queries are parameterized (`?` placeholders, translated to
`%s` for Postgres). The only dynamic SQL is the partial `UPDATE` in `upsert_step`,
which builds its `SET` clause from a fixed set of literal column names and binds
every value - no user data reaches the SQL text. The web DB uses Drizzle's
parameterized query builder. Neither path concatenates user input into SQL.
