#!/usr/bin/env sh
# Start one Celery worker subscribing to every unit queue.
#
# Queues are DERIVED from the registry (registry.QUEUES), so a new tool is picked
# up with no edit here. Pool size = WORKFLOW_CONCURRENCY x SESSION_CONCURRENCY so
# the worker never bottlenecks the orchestrator's two concurrency gates (each
# active run uses at most one task slot at a time).
set -e

QUEUES=$(python -c "from node.registry import QUEUES; print(','.join(QUEUES))")
POOL=$(( ${WORKFLOW_CONCURRENCY:-1} * ${SESSION_CONCURRENCY:-1} ))

exec celery -A shared.celery_app.celery_app worker \
  -Q "$QUEUES" \
  --concurrency "$POOL" \
  --loglevel info
