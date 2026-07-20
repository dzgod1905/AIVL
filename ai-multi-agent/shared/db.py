"""Persistence for orchestrator runs + step IO (JSON).

Two backends, same interface:
  - Postgres (psycopg3 + pool) when ORCH_DATABASE_URL is set. Use a local
    Postgres OR a separate Neon project -- just point the URL at it. This DB is
    deliberately SEPARATE from the web's Neon DB (which keeps only 1 row per run).
  - SQLite (file, WAL) as the zero-config fallback for local dev / eager mode.

Stores the detailed per-step input/output that the web does NOT keep, so the web
queries it via the orchestrator REST API (GET /runs/{id}).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from shared import config

_BACKEND = "postgres" if config.ORCH_DATABASE_URL else "sqlite"

# SQLite writes are serialized through this lock (a new connection per call has
# no shared cache; the lock prevents "database is locked" under WAL). Postgres
# handles its own concurrency, so the lock is unused there.
_lock = threading.Lock()

# Lazily-opened Postgres connection pool (network cost -> reuse connections).
_pool: Any = None
_pool_lock = threading.Lock()


# ---- backend plumbing -----------------------------------------------------

def _pg_pool() -> Any:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from psycopg.rows import dict_row
                from psycopg_pool import ConnectionPool

                _pool = ConnectionPool(
                    config.ORCH_DATABASE_URL,
                    min_size=1,
                    max_size=10,
                    kwargs={"row_factory": dict_row},
                    open=True,
                )
    return _pool


def _sqlite_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(config.SQLITE_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


@contextmanager
def _session() -> Iterator[Any]:
    """Yield a connection; commit on success, roll back on error.

    Rows from either backend support both row["col"] and dict(row).
    """
    if _BACKEND == "postgres":
        with _pg_pool().connection() as conn:  # pool commits/rolls back + returns conn
            yield conn
    else:
        with _lock:
            conn = _sqlite_conn()
            try:
                with conn:  # commits on clean exit, rolls back on exception
                    yield conn
            finally:
                conn.close()


def _run(conn: Any, sql: str, params: tuple = ()) -> Any:
    """Execute one statement. SQL is written with '?' placeholders; translated
    to '%s' for Postgres. Returns a cursor for fetchone()/fetchall()."""
    if _BACKEND == "postgres":
        cur = conn.cursor()
        cur.execute(sql.replace("?", "%s"), params)
        return cur
    return conn.execute(sql, params)


# ---- schema ---------------------------------------------------------------

# DOUBLE PRECISION / INTEGER are accepted by both SQLite (type affinity) and
# Postgres, so one DDL set works for both. `done` is 0/1 in both backends.
_DDL = [
    """
    CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT,
        status TEXT NOT NULL,
        created_at DOUBLE PRECISION NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS step_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        started_at DOUBLE PRECISION,
        done INTEGER NOT NULL DEFAULT 0,
        fail_reason TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_step_runs_run_id ON step_runs (run_id)",
]


def init_db() -> None:
    with _session() as conn:
        for stmt in _DDL:
            _run(conn, stmt)


# ---- runs -----------------------------------------------------------------

def create_run(run_id: str, workflow_id: str | None, status: str) -> None:
    with _session() as conn:
        _run(
            conn,
            "INSERT INTO runs (id, workflow_id, status, created_at) VALUES (?,?,?,?)",
            (run_id, workflow_id, status, time.time()),
        )


def set_run_status(run_id: str, status: str) -> None:
    with _session() as conn:
        _run(conn, "UPDATE runs SET status=? WHERE id=?", (status, run_id))


def get_run(run_id: str) -> dict[str, Any] | None:
    with _session() as conn:
        row = _run(conn, "SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        return dict(row) if row else None


# ---- step_runs ------------------------------------------------------------

def upsert_step(
    step_id: str,
    run_id: str,
    step_key: str,
    agent: str,
    status: str,
    *,
    input_obj: Any = None,
    output_obj: Any = None,
    attempts: int | None = None,
    max_attempts: int | None = None,
    started_at: float | None = None,
    done: bool | None = None,
    fail_reason: str | None = None,
) -> None:
    with _session() as conn:
        existing = _run(
            conn, "SELECT id FROM step_runs WHERE id=?", (step_id,)
        ).fetchone()
        if existing is None:
            _run(
                conn,
                """INSERT INTO step_runs
                   (id, run_id, step_key, agent, status, input_json, output_json,
                    attempts, max_attempts, started_at, done, fail_reason)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    step_id,
                    run_id,
                    step_key,
                    agent,
                    status,
                    json.dumps(input_obj) if input_obj is not None else None,
                    json.dumps(output_obj) if output_obj is not None else None,
                    attempts or 0,
                    max_attempts if max_attempts is not None else config.DEFAULT_MAX_ATTEMPTS,
                    started_at,
                    1 if done else 0,
                    fail_reason,
                ),
            )
            return
        # Build partial update (only touch provided fields).
        fields: list[str] = ["status=?"]
        vals: list[Any] = [status]
        if input_obj is not None:
            fields.append("input_json=?")
            vals.append(json.dumps(input_obj))
        if output_obj is not None:
            fields.append("output_json=?")
            vals.append(json.dumps(output_obj))
        if attempts is not None:
            fields.append("attempts=?")
            vals.append(attempts)
        if max_attempts is not None:
            fields.append("max_attempts=?")
            vals.append(max_attempts)
        if started_at is not None:
            fields.append("started_at=?")
            vals.append(started_at)
        if done is not None:
            fields.append("done=?")
            vals.append(1 if done else 0)
        if fail_reason is not None:
            fields.append("fail_reason=?")
            vals.append(fail_reason)
        vals.append(step_id)
        _run(conn, f"UPDATE step_runs SET {', '.join(fields)} WHERE id=?", tuple(vals))


def get_steps(run_id: str) -> list[dict[str, Any]]:
    with _session() as conn:
        rows = _run(
            conn,
            "SELECT * FROM step_runs WHERE run_id=? ORDER BY started_at",
            (run_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["input"] = json.loads(d["input_json"]) if d["input_json"] else None
        d["output"] = json.loads(d["output_json"]) if d["output_json"] else None
        d["done"] = bool(d["done"])
        out.append(d)
    return out
