"""SQLite persistence for orchestrator runs + step IO (JSON).

Separate from the web's Neon DB. Stores the detailed per-step input/output that
the web deliberately does NOT keep, so the web queries it via GET /runs/{id}.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from shared import config

_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(config.SQLITE_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db() -> None:
    with _lock, _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                workflow_id TEXT,
                status TEXT NOT NULL,
                created_at REAL NOT NULL
            );
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
                started_at REAL,
                done INTEGER NOT NULL DEFAULT 0,
                fail_reason TEXT
            );
            """
        )


# ---- runs -----------------------------------------------------------------

def create_run(run_id: str, workflow_id: str | None, status: str) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO runs (id, workflow_id, status, created_at) VALUES (?,?,?,?)",
            (run_id, workflow_id, status, time.time()),
        )


def set_run_status(run_id: str, status: str) -> None:
    with _lock, _conn() as conn:
        conn.execute("UPDATE runs SET status=? WHERE id=?", (status, run_id))


def get_run(run_id: str) -> dict[str, Any] | None:
    with _lock, _conn() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
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
    with _lock, _conn() as conn:
        existing = conn.execute(
            "SELECT id FROM step_runs WHERE id=?", (step_id,)
        ).fetchone()
        if existing is None:
            conn.execute(
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
        # Build partial update.
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
        conn.execute(f"UPDATE step_runs SET {', '.join(fields)} WHERE id=?", vals)


def get_steps(run_id: str) -> list[dict[str, Any]]:
    with _lock, _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM step_runs WHERE run_id=? ORDER BY started_at", (run_id,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["input"] = json.loads(d["input_json"]) if d["input_json"] else None
        d["output"] = json.loads(d["output_json"]) if d["output_json"] else None
        d["done"] = bool(d["done"])
        out.append(d)
    return out
