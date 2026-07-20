"""Orchestrator engine: sequential per-run executor + pull-based dispatch.

Key ideas:
- Within ONE run, steps execute strictly in listed order (sequential). A step
  starts only after the previous step is `done`; steps in a run never overlap.
  `dependsOn` is NOT a scheduler input here - it only tells the builder which
  prior-step outputs a step references (for {{stepKey.output}} variables).
- Concurrency is BETWEEN runs, not within one: each run has its own loop thread,
  and different runs sit at different steps at the same time. The Celery worker
  pool multiplexes those steps - an idle worker pulls the next task off the
  agent's queue (node.<name> -> queue:<name>). That cross-run multiplexing IS the
  "scheduler".
- If an agent reports done=false, the orchestrator re-asks (re-dispatch with
  attempt+1) after a short delay, bounded by maxAttempts AND timeoutSec. On
  breach: step=failed (fail_reason max_attempts_exceeded / timeout), run=failed.
- If a finished step has humanInvolved=true: run -> paused_for_human and the run
  waits (no next step) until /resume.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any

from celery.result import AsyncResult

from shared import config, db
from shared.celery_app import celery_app
from shared.clients import automation_invoke
from shared.schemas import CreateRunRequest, StepSpec
from orchestrator.events import bus

log = logging.getLogger("orchestrator.engine")

# step statuses
PENDING, RUNNING, DONE, FAILED = "pending", "running", "done", "failed"
# run statuses
R_RUNNING, R_PAUSED, R_DONE, R_FAILED = "running", "paused_for_human", "done", "failed"


class Run:
    def __init__(self, run_id: str, req: CreateRunRequest):
        self.id = run_id
        self.workflow_id = req.workflowId
        self.initial_input = req.input
        self.steps: dict[str, StepSpec] = {s.stepKey: s for s in req.steps}
        # execution order = the order steps arrive in (web sends them ordered).
        self.order: list[str] = [s.stepKey for s in req.steps]
        self.status = R_RUNNING
        self.step_status: dict[str, str] = {k: PENDING for k in self.steps}
        self.step_output: dict[str, Any] = {}
        self.step_input: dict[str, Any] = {}
        self.step_attempts: dict[str, int] = {k: 0 for k in self.steps}
        self.step_fail_reason: dict[str, str] = {}
        self.step_ids: dict[str, str] = {k: uuid.uuid4().hex for k in self.steps}
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.resume_event = threading.Event()
        self.inflight: set[str] = set()  # step keys currently dispatched


class Engine:
    def __init__(self) -> None:
        self.runs: dict[str, Run] = {}
        self._lock = threading.Lock()
        # agent name -> count of in-flight tasks (busy if > 0)
        self.agent_inflight: dict[str, int] = {a: 0 for a in config.AGENTS}
        self._agent_lock = threading.Lock()

    # ---- agent busy/idle bookkeeping -------------------------------------

    def _agent_mark(self, agent: str, delta: int) -> None:
        if agent not in self.agent_inflight:
            return
        with self._agent_lock:
            self.agent_inflight[agent] = max(0, self.agent_inflight[agent] + delta)

    def agents_status(self) -> list[dict[str, Any]]:
        with self._agent_lock:
            return [
                {"agent": a, "inflight": n, "state": "busy" if n > 0 else "idle"}
                for a, n in self.agent_inflight.items()
            ]

    # ---- run lifecycle ----------------------------------------------------

    def create_run(self, req: CreateRunRequest) -> str:
        run_id = uuid.uuid4().hex
        run = Run(run_id, req)
        with self._lock:
            self.runs[run_id] = run
        db.create_run(run_id, run.workflow_id, R_RUNNING)
        t = threading.Thread(target=self._schedule_loop, args=(run,), daemon=True)
        t.start()
        return run_id

    def get_run(self, run_id: str) -> Run | None:
        return self.runs.get(run_id)

    def resume(self, run_id: str) -> bool:
        run = self.runs.get(run_id)
        if run is None:
            return False
        with run.cond:
            if run.status != R_PAUSED:
                return False
            run.status = R_RUNNING
            db.set_run_status(run_id, R_RUNNING)
            run.resume_event.set()
            run.cond.notify_all()
        self._emit(run, {"type": "run_status", "status": R_RUNNING})
        return True

    # ---- scheduling -------------------------------------------------------

    def _schedule_loop(self, run: Run) -> None:
        """Per-run loop: execute steps one at a time, in listed order.

        Sequential by design - the next step starts only after the current one is
        `done`. Parallelism lives BETWEEN runs (many loops + the worker pool), not
        inside a single run.
        """
        try:
            for step_key in run.order:
                with run.cond:
                    if run.status == R_FAILED:
                        return
                    run.step_status[step_key] = RUNNING
                    run.inflight.add(step_key)

                # runs to completion (blocks): sets DONE/FAILED, re-asks, and may
                # flip the run to paused_for_human at the end.
                self._execute_step(run, step_key)

                with run.cond:
                    if run.step_status[step_key] == FAILED:
                        run.status = R_FAILED
                        db.set_run_status(run.id, R_FAILED)
                        self._emit(run, {"type": "run_status", "status": R_FAILED})
                        return
                    # human review pause: hold here until /resume before the next step
                    run.cond.wait_for(lambda: run.status != R_PAUSED)

            with run.cond:
                run.status = R_DONE
                db.set_run_status(run.id, R_DONE)
            self._emit(run, {"type": "run_status", "status": R_DONE})
        except Exception as exc:  # pragma: no cover - safety net
            log.exception("run loop crashed: %s", exc)
            with run.cond:
                run.status = R_FAILED
                db.set_run_status(run.id, R_FAILED)
            self._emit(run, {"type": "run_status", "status": R_FAILED, "reason": str(exc)})

    # ---- step execution ---------------------------------------------------

    def _build_input(self, run: Run, spec: StepSpec) -> dict[str, Any]:
        """Build a step's input: initial input + rendered prompt.

        Because steps run in order, any {{stepKey.output}} a prompt references
        belongs to an already-finished earlier step, so it resolves here.
        """
        step_input: dict[str, Any] = dict(run.initial_input)

        # promptTemplate rendering (ai_agent only): replace {{stepKey.output}}
        if spec.promptTemplate and spec.unitType == "ai_agent":
            step_input["prompt"] = self._render_prompt(run, spec.promptTemplate)

        return step_input

    def _resolve_ref(self, run: Run, ref: str) -> Any:
        # ref like "parser.output" or "parser.output.summary".
        # step_output[dep] IS the step's output, so a leading "output" segment
        # refers to that root and is skipped rather than indexed into.
        parts = ref.split(".")
        dep = parts[0]
        val: Any = run.step_output.get(dep)
        rest = parts[1:]
        if rest and rest[0] == "output":
            rest = rest[1:]
        for p in rest:
            if isinstance(val, dict):
                val = val.get(p)
            else:
                val = None
                break
        return val

    def _render_prompt(self, run: Run, template: str) -> str:
        import re

        def repl(m: "re.Match[str]") -> str:
            expr = m.group(1).strip()
            val = self._resolve_ref(run, expr)
            return str(val) if val is not None else ""

        return re.sub(r"\{\{\s*([^}]+?)\s*\}\}", repl, template)

    def _execute_step(self, run: Run, step_key: str) -> None:
        spec = run.steps[step_key]
        step_id = run.step_ids[step_key]
        with run.cond:
            step_input = self._build_input(run, spec)
            run.step_input[step_key] = step_input

        agent = spec.unitId  # for ai_agent, unitId == agent name (parser, ...)
        is_automation = spec.unitType == "automation_tool"

        db.upsert_step(step_id, run.id, step_key, agent, RUNNING,
                       input_obj=step_input, max_attempts=spec.maxAttempts,
                       started_at=time.time())
        self._emit(run, {"type": "step_status", "stepKey": step_key, "status": RUNNING})

        start = time.monotonic()
        attempt = 0
        output: Any = None
        done = False
        fail_reason: str | None = None

        while True:
            attempt += 1
            with run.cond:
                run.step_attempts[step_key] = attempt

            if is_automation:
                res = automation_invoke(agent, step_input, spec.config,
                                        timeout_sec=spec.timeoutSec)
                done = bool(res.get("done"))
                output = res.get("output")
            else:
                self._agent_mark(agent, +1)
                try:
                    payload = {"input": step_input, "attempt": attempt, "config": spec.config}
                    ar: AsyncResult = celery_app.send_task(f"node.{agent}", args=[payload])
                    res = ar.get(timeout=max(1, spec.timeoutSec), propagate=True)
                    done = bool(res.get("done"))
                    output = res.get("output")
                except Exception as exc:
                    log.warning("agent %s task error: %s", agent, exc)
                    done = False
                    output = {"error": str(exc)}
                finally:
                    self._agent_mark(agent, -1)

            if done:
                break

            # not done -> re-ask, bounded by maxAttempts and timeoutSec
            elapsed = time.monotonic() - start
            log.info("agent %s reported done=false (run=%s step=%s attempt=%s) -> re-ask",
                     agent, run.id, step_key, attempt)
            self._emit(run, {"type": "step_reask", "stepKey": step_key,
                             "attempt": attempt, "agent": agent})

            if attempt >= spec.maxAttempts:
                fail_reason = "max_attempts_exceeded"
                break
            if elapsed >= spec.timeoutSec:
                fail_reason = "timeout"
                break
            time.sleep(config.REASK_DELAY_SEC)

        # ---- finalize step ----
        with run.cond:
            run.inflight.discard(step_key)
            run.step_attempts[step_key] = attempt

            if not done:
                run.step_status[step_key] = FAILED
                run.step_fail_reason[step_key] = fail_reason or "failed"
                db.upsert_step(step_id, run.id, step_key, agent, FAILED,
                               output_obj=output, attempts=attempt, done=False,
                               fail_reason=fail_reason)
                self._emit(run, {"type": "step_status", "stepKey": step_key,
                                 "status": FAILED, "fail_reason": fail_reason})
                run.cond.notify_all()
                return

            run.step_status[step_key] = DONE
            run.step_output[step_key] = output
            db.upsert_step(step_id, run.id, step_key, agent, DONE,
                           output_obj=output, attempts=attempt, done=True)
            self._emit(run, {"type": "step_status", "stepKey": step_key,
                             "status": DONE, "output": output})

            # human-in-the-loop: pause the WHOLE run (no new dispatch) until resume
            if spec.humanInvolved:
                run.status = R_PAUSED
                run.resume_event.clear()
                db.set_run_status(run.id, R_PAUSED)
                self._emit(run, {"type": "run_status", "status": R_PAUSED,
                                 "pausedStep": step_key})

            run.cond.notify_all()

    # ---- helpers ----------------------------------------------------------

    def _emit(self, run: Run, event: dict[str, Any]) -> None:
        bus.emit(run.id, event)


engine = Engine()
