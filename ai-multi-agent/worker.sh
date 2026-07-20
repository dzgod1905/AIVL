#!/usr/bin/env sh
# Start one Celery worker subscribing to every unit queue.
# Concurrency > 1 simulates multiple unit instances (parallel dispatch).
exec celery -A shared.celery_app.celery_app worker \
  -Q queue:ai_agent,queue:excel_reader \
  --concurrency "${WORKER_CONCURRENCY:-6}" \
  --loglevel info
