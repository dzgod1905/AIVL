"""Tiny in-process pub/sub for SSE. Thread-safe (engine runs on threads)."""
from __future__ import annotations

import queue
import threading
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # run_id -> list of subscriber queues
        self._subs: dict[str, list[queue.Queue]] = {}

    def subscribe(self, run_id: str) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subs.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: str, q: queue.Queue) -> None:
        with self._lock:
            subs = self._subs.get(run_id, [])
            if q in subs:
                subs.remove(q)

    def emit(self, run_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs.get(run_id, []))
        for q in subs:
            q.put(event)


bus = EventBus()
