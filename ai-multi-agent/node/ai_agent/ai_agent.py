"""AI Agent unit (category: ai_agent). Runs a prompt (system + user) from config.

Default is DUMMY: it does not call a real LLM, it echoes the resolved prompts and
returns a placeholder reply so downstream steps have text to reference.

If a key pool is configured (shared.config.AI_AGENT_KEYS, parsed from the
AI_AGENT_KEYS env JSON array) the agent makes a REAL model call instead. Keys are
tried spread-load: a random start index in the pool, then sequential fallback
through the rest. On ANY error for an entry (bad key, network, rate limit, empty
completion) it moves to the next key; if every key fails, or the pool is empty,
it uses the dummy reply, so a run never breaks.

A real success reports done=true on the first attempt (it bypasses the dummy
re-ask simulation); the `stuck` / `simulate_incomplete` presets only affect the
dummy path. The user prompt is the step's rendered promptTemplate (orchestrator
puts it in input["prompt"]); the system prompt comes from config.system_prompt.
Runs on queue:ai_agent.
"""
from __future__ import annotations

import logging
import random
import time
from typing import Any

import httpx

from shared import config as cfg
from shared.celery_app import celery_app
from node.base import run_step

log = logging.getLogger("node.ai_agent")

NAME = "ai_agent"


def _resolve_prompts(input_obj: dict[str, Any], conf: dict[str, Any]) -> tuple[str, str]:
    """system prompt from config; user prompt = rendered template or a config fallback."""
    system_prompt = str(conf.get("system_prompt", "") or "")
    user_prompt = str(input_obj.get("prompt", conf.get("user_prompt", "")) or "")
    return system_prompt, user_prompt


def _dummy_output(input_obj: dict[str, Any], conf: dict[str, Any], attempt: int) -> dict[str, Any]:
    system_prompt, user_prompt = _resolve_prompts(input_obj, conf)
    reply = f"[dummy AI reply] {user_prompt}".strip() if user_prompt else "[dummy AI reply]"
    return {
        "system_prompt": system_prompt,
        "user_prompt": user_prompt,
        "text": reply,
        "provider": "dummy",
        "model": None,
    }


def _call_anthropic(entry: dict[str, Any], system_prompt: str, user_prompt: str) -> str:
    body: dict[str, Any] = {
        "model": entry["model"],
        "max_tokens": cfg.AI_AGENT_MAX_TOKENS,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    if system_prompt:
        body["system"] = system_prompt
    r = httpx.post(
        f"{entry['base_url']}/messages",
        headers={
            "x-api-key": entry["api_key"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json=body,
        timeout=cfg.AI_AGENT_HTTP_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    return "".join(parts).strip()


def _call_openai(entry: dict[str, Any], system_prompt: str, user_prompt: str) -> str:
    """OpenAI Chat Completions shape. Also covers OpenAI-compatible endpoints
    (Groq, OpenRouter, ...) via entry['base_url']."""
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})
    r = httpx.post(
        f"{entry['base_url']}/chat/completions",
        headers={
            "authorization": f"Bearer {entry['api_key']}",
            "content-type": "application/json",
        },
        json={
            "model": entry["model"],
            "messages": messages,
            "max_tokens": cfg.AI_AGENT_MAX_TOKENS,
        },
        timeout=cfg.AI_AGENT_HTTP_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    return str(data["choices"][0]["message"]["content"]).strip()


def _call_entry(entry: dict[str, Any], system_prompt: str, user_prompt: str) -> str:
    if entry["provider"] == "anthropic":
        return _call_anthropic(entry, system_prompt, user_prompt)
    return _call_openai(entry, system_prompt, user_prompt)


def _spread_order(keys: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Random start index, then sequential fallback through the rest (strategy A:
    spread load across the pool without shared cross-worker state)."""
    if len(keys) <= 1:
        return list(keys)
    start = random.randrange(len(keys))
    return keys[start:] + keys[:start]


@celery_app.task(name="node.ai_agent")
def run(payload: dict[str, Any]) -> dict[str, Any]:
    input_obj = payload.get("input", {}) or {}
    conf = payload.get("config", {}) or {}
    system_prompt, user_prompt = _resolve_prompts(input_obj, conf)

    keys = cfg.AI_AGENT_KEYS
    # Real call only when the pool is non-empty AND there is a prompt to send.
    if keys and user_prompt.strip():
        for entry in _spread_order(keys):
            try:
                text = _call_entry(entry, system_prompt, user_prompt)
                if not text:
                    raise ValueError("empty completion")

                def _real_output(_i: dict[str, Any], _c: dict[str, Any], _a: int,
                                 _t: str = text, _e: dict[str, Any] = entry) -> dict[str, Any]:
                    return {
                        "system_prompt": system_prompt,
                        "user_prompt": user_prompt,
                        "text": _t,
                        "provider": _e["provider"],
                        "model": _e["model"],
                    }

                # real success = done on the first attempt (skip the dummy re-ask sim)
                return run_step(NAME, payload, _real_output, always_done=True)
            except Exception as exc:  # bad key / network / rate limit -> next key
                log.warning("ai_agent key failed (%s/%s) -> next: %s",
                            entry["provider"], entry["model"], exc)

    # dummy path: empty pool, empty prompt, or every key failed
    if cfg.AI_AGENT_DELAY_SEC > 0:
        time.sleep(cfg.AI_AGENT_DELAY_SEC)
    return run_step(NAME, payload, _dummy_output)
