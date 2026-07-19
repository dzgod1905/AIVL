"""Orchestrator engine: DAG state machine + pull-based dispatch loop.

Key ideas (spec mục 6a / 8):
- A step is *runnable* when ALL steps in its dependsOn are `done`. Each dispatch
  round finds EVERY runnable step and dispatches them at once -> independent
  branches run in parallel.
- Work distribution to agents is NOT hand-written here. The orchestrator only
  pushes a Celery task onto the agent's queue (agents.<name> -> queue:<name>);
  whichever idle worker pulls it does the work. Worker concurrency simulates the
  number of instances per agent.
- If an agent reports done=false, the orchestrator re-asks (re-dispatch with
  attempt+1) after a short delay, bounded by maxAttempts AND timeoutSec. On
  breach: step=failed (fail_reason max_attempts_exceeded / timeout), run=failed.
- If a finished step has humanInvolved=true: run -> paused_for_human and NO new
  dispatch happens (even for other parallel branches) until /resume.
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
        """Main per-run loop: repeatedly dispatch all runnable steps."""
        try:
            while True:
                with run.cond:
                    if run.status in (R_DONE, R_FAILED):
                        return
                    if run.status == R_PAUSED:
                        # wait until resume
                        run.cond.wait_for(lambda: run.status != R_PAUSED, timeout=1.0)
                        continue

                    # terminal check
                    statuses = run.step_status
                    if all(s == DONE for s in statuses.values()):
                        run.status = R_DONE
                        db.set_run_status(run.id, R_DONE)
                        self._emit(run, {"type": "run_status", "status": R_DONE})
                        return
                    if any(s == FAILED for s in statuses.values()):
                        run.status = R_FAILED
                        db.set_run_status(run.id, R_FAILED)
                        self._emit(run, {"type": "run_status", "status": R_FAILED})
                        return

                    runnable = self._find_runnable(run)
                    for sk in runnable:
                        run.step_status[sk] = RUNNING
                        run.inflight.add(sk)
                        threading.Thread(
                            target=self._execute_step, args=(run, sk), daemon=True
                        ).start()

                    if not runnable and not run.inflight:
                        # nothing runnable and nothing running -> deadlock guard
                        run.status = R_FAILED
                        db.set_run_status(run.id, R_FAILED)
                        self._emit(run, {"type": "run_status", "status": R_FAILED,
                                         "reason": "no_runnable_steps"})
                        return

                    # wait for a step to finish (or pause/resume) then re-evaluate
                    run.cond.wait(timeout=1.0)
        except Exception as exc:  # pragma: no cover - safety net
            log.exception("schedule loop crashed: %s", exc)
            with run.cond:
                run.status = R_FAILED
                db.set_run_status(run.id, R_FAILED)
            self._emit(run, {"type": "run_status", "status": R_FAILED, "reason": str(exc)})

    def _find_runnable(self, run: Run) -> list[str]:
        """All pending steps whose deps are all done. Caller holds run.lock."""
        out = []
        for sk, spec in run.steps.items():
            if run.step_status[sk] != PENDING:
                continue
            if all(run.step_status.get(d) == DONE for d in spec.dependsOn):
                out.append(sk)
        return out

    # ---- step execution ---------------------------------------------------

    def _build_input(self, run: Run, spec: StepSpec) -> dict[str, Any]:
        """Build a step's input: initial input + contextMapping + rendered prompt."""
        step_input: dict[str, Any] = dict(run.initial_input)

        # contextMapping: "<targetField>" -> "<depStepKey>.output[.path]"
        for target, ref in spec.contextMapping.items():
            step_input[target] = self._resolve_ref(run, ref)

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
                    ar: AsyncResult = celery_app.send_task(f"agents.{agent}", args=[payload])
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


# ---- cycle detection (used by web on save; exposed for reuse) -------------

def has_cycle(steps: list[dict[str, Any]]) -> bool:
    """steps: list of {stepKey, dependsOn:[...]}. Returns True if a cycle exists."""
    graph = {s["stepKey"]: list(s.get("dependsOn", [])) for s in steps}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {k: WHITE for k in graph}

    def dfs(node: str) -> bool:
        color[node] = GRAY
        for dep in graph.get(node, []):
            if dep not in color:
                continue
            if color[dep] == GRAY:
                return True
            if color[dep] == WHITE and dfs(dep):
                return True
        color[node] = BLACK
        return False

    return any(color[n] == WHITE and dfs(n) for n in graph)
