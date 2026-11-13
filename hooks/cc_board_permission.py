#!/usr/bin/env python3
"""Claude Code PermissionRequest hook -> remote allow / deny through the hub.

Also answers AskUserQuestion: Claude Code routes it through the same prompt,
so the hook sends the questions & options, and a remote answer comes back as
`updatedInput.answers`, the way the terminal dialog would fill it in.

Posts the waiting permission prompt to the hub, then long-polls until someone
answers it remotely or the wait runs out. On an answer it prints the decision
for Claude Code; otherwise it prints nothing, so Claude Code shows its normal
prompt in the terminal. Any error ends the same way: this hook can delay a
prompt, never break a session.

Same config as cc_board_hook.py, plus:
    CC_BOARD_APPROVE_WAIT=120  # seconds to wait for a remote answer; 0 turns it off

Keep the hook's "timeout" in settings.json above this wait, or Claude Code
kills the script first (the hub then expires the request after 15 minutes).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from cc_board_hook import git_branch, load_config, redact, setting, tool_target  # noqa: E402
except Exception:  # noqa: BLE001 - a broken checkout must not break the prompt either
    sys.exit(0)

DEFAULT_WAIT_S = 120
POLL_S = 25  # the hub holds a poll for at most 30s
POST_TIMEOUT_S = 3
DENY_MESSAGE = "Denied from the remote"


def approve_wait():
    """Total seconds to wait for an answer. Anything unparsable gets the default."""
    raw = setting("CC_BOARD_APPROVE_WAIT")
    if raw == "":
        return DEFAULT_WAIT_S
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_WAIT_S


def call(cfg, method, path, body=None, timeout=POST_TIMEOUT_S):
    request = urllib.request.Request(
        cfg["url"].rstrip("/") + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "x-board-secret": cfg["secret"]},
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def questions_of(tool_input):
    """AskUserQuestion's questions, redacted, or None when there are none."""
    raw = tool_input.get("questions") if isinstance(tool_input, dict) else None
    if not isinstance(raw, list) or not raw:
        return None
    out = []
    for q in raw:
        if not isinstance(q, dict) or not isinstance(q.get("options"), list):
            return None
        out.append({
            "question": redact(str(q.get("question") or "")),
            "header": redact(str(q.get("header") or "")),
            "multiSelect": q.get("multiSelect") is True,
            "options": [
                {
                    "label": redact(str(o.get("label") or "")),
                    "description": redact(str(o.get("description") or "")),
                }
                for o in q["options"] if isinstance(o, dict)
            ],
        })
    return out


def build_request(data, cfg):
    cwd = data.get("cwd") or ""
    request = {
        "session_id": data.get("session_id") or "",
        "project": os.path.basename(cwd.rstrip("/")) or "unknown",
        "host": cfg["host"],
        "branch": git_branch(cwd) if cwd else "",
        "tool": data.get("tool_name") or "",
        "target": redact(tool_target(data.get("tool_input"), cwd)),
    }
    questions = questions_of(data.get("tool_input"))
    if questions:
        request["questions"] = questions
    return request


def wait_for_decision(cfg, request_id, wait_s):
    """(state, hub result) with state 'allow' / 'deny', or (None, {}) when nobody answered."""
    deadline = time.monotonic() + wait_s
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, {}
        poll = max(1, min(POLL_S, int(remaining)))
        # The socket timeout sits above the poll so the hub always answers first.
        result = call(cfg, "GET", f"/permission/{request_id}?wait={poll}", timeout=poll + 5)
        state = result.get("state")
        if state in ("allow", "deny"):
            return state, result
        if state != "pending":
            return None, {}  # cancelled or expired on the hub


def answered_input(tool_input, indexes):
    """The tool input with `answers` filled in, keyed by Claude's own question text.

    The hub answers with option indexes per question because it only saw a
    redacted copy. Multi-select labels are joined with ", " as the terminal does.
    None when the answers don't fit the questions, so the terminal asks instead.
    """
    questions = tool_input.get("questions") if isinstance(tool_input, dict) else None
    if not isinstance(questions, list) or not isinstance(indexes, list) or len(indexes) != len(questions):
        return None
    answers = {}
    for q, picked in zip(questions, indexes):
        options = q.get("options") if isinstance(q, dict) else None
        if not isinstance(options, list) or not isinstance(picked, list) or not picked:
            return None
        labels = []
        for n in picked:
            if not isinstance(n, int) or not 0 <= n < len(options) or not isinstance(options[n], dict):
                return None
            labels.append(str(options[n].get("label") or ""))
        answers[str(q.get("question") or "")] = ", ".join(labels)
    return {**tool_input, "answers": answers}


def decision_output(state, result, tool_input=None):
    """The hook's stdout for a remote answer, or None when it can't be used."""
    decision = {"behavior": state}
    if state == "deny":
        decision["message"] = result.get("message") or DENY_MESSAGE
    elif questions_of(tool_input):
        updated = answered_input(tool_input, result.get("answers"))
        if updated is None:
            return None
        decision["updatedInput"] = updated
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}


def main():
    wait_s = approve_wait()
    if wait_s <= 0:
        return
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict) or data.get("hook_event_name") != "PermissionRequest":
        return
    if not data.get("session_id"):
        return

    cfg = load_config()
    if not cfg["url"] or not cfg["secret"]:
        return

    request_id = call(cfg, "POST", "/permission", build_request(data, cfg)).get("id")
    if not request_id:
        return
    state, result = None, {}
    try:
        state, result = wait_for_decision(cfg, request_id, wait_s)
    finally:
        if state is None:
            # Take it off the remote's list: the answer now belongs to the terminal.
            try:
                call(cfg, "POST", f"/permission/{request_id}/cancel", {})
            except Exception:  # noqa: BLE001 - best effort, the hub expires it anyway
                pass
    output = decision_output(state, result, data.get("tool_input")) if state else None
    if output:
        sys.stdout.write(json.dumps(output))
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - a board problem must never break a session
        pass
    sys.exit(0)
