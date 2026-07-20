"""Node units, split into category subpackages.

  node/
    base.py            shared run_step behavior (dummy done/re-ask logic)
    registry.py        task name -> celery task + category grouping
    ai_agent/          category "ai_agent": prompt runners
    parser/            category "parser": code tools that parse data

Each unit is a Celery task named node.<unitId> routed to queue:<unitId>.
"""
