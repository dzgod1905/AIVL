#!/usr/bin/env sh
# Start one Celery worker subscribing to all 6 agent queues.
# Concurrency > 1 simulates multiple agent instances (parallel dispatch).
exec celery -A shared.celery_app.celery_app worker \
  -Q queue:parser,queue:planner,queue:execution,queue:verification,queue:report,queue:self_healing \
  --concurrency "${WORKER_CONCURRENCY:-6}" \
  --loglevel info
