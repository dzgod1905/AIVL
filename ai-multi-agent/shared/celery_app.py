"""Celery app: Redis broker + backend, one queue per agent.

Task routing sends each agent's task to its own queue (queue:parser, ...). Workers
subscribe to those queues; an idle worker pulls the next task. This IS the
"give work to a free agent" mechanism (pull-based) - the orchestrator never picks
an agent instance itself.
"""
from __future__ import annotations

import os

from celery import Celery
from kombu import Queue

from shared import config

celery_app = Celery(
    "ai_multi_agent",
    broker=config.REDIS_URL,
    backend=config.REDIS_URL,
    include=["node.registry"],
)

# One named queue per unit.
celery_app.conf.task_queues = [Queue(q) for q in config.AGENTS.values()]

# Route each unit task name (node.<name>) to its queue.
celery_app.conf.task_routes = {
    f"node.{name}": {"queue": queue} for name, queue in config.AGENTS.items()
}

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    result_expires=3600,
)

# ---- eager fallback (no Redis / no separate workers) ----------------------
# Set CELERY_EAGER=1 to run agents in-process, dispatched inline by the
# orchestrator. Lets the whole backend run with just the two FastAPI servers
# (no broker). Real distributed mode = leave it unset and run Redis + workers.
if os.getenv("CELERY_EAGER") == "1":
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    def _local_send_task(name, args=None, **kwargs):
        # task_always_eager does not cover send_task(), so route by name to the
        # registered task and run it synchronously via .apply().
        from node.registry import TASK_BY_AGENT  # lazy: avoids import cycle

        agent = name.split(".")[-1]
        # unknown unitId (e.g. an old seeded workflow) -> generic ai_agent task
        task = TASK_BY_AGENT.get(agent) or TASK_BY_AGENT["ai_agent"]
        return task.apply(args=args or [])

    celery_app.send_task = _local_send_task  # type: ignore[method-assign]
