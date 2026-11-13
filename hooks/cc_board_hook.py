#!/usr/bin/env python3
"""Claude Code hook -> cc-session-board hub.

Reads the hook JSON on stdin, posts a small event to the hub and exits 0.
It never blocks or fails a Claude Code session: any error is swallowed.

Works on macOS & Linux with the Python 3 standard library only.

Config comes from the environment, or from ~/.config/cc-board/env:
    CC_BOARD_URL=http://<pi-tailscale-ip>:8787
    CC_BOARD_SECRET=<same value as BOARD_SECRET on the hub>
    CC_BOARD_HOST=mac          # optional label for this machine on the board
"""

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

EVENTS = {
    "SessionStart": "session_start",
    "SessionEnd": "session_end",
    "UserPromptSubmit": "prompt",
    "PreToolUse": "tool",
    "PostToolUse": "tool",
    "Notification": "notification",
    "Stop": "stop",
}

TOOL_THROTTLE_S = 5
POST_TIMEOUT_S = 2

# Tool targets & messages are stored in plain text on the hub, so anything that
# looks like a credential is masked before it leaves the laptop.
SENSITIVE_KEY = r"[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key)[A-Za-z0-9_.-]*"
REDACTIONS = [
    # --password foo, --token=foo
    (re.compile(r"(?i)(--?(?:password|passwd|token|secret|api[_-]?key)(?:[=\s]+))(\S+)"), r"\1***"),
    # Authorization: Bearer xxx, Basic xxx
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 ***"),
    # KEY=value, KEY: value, ?key=value, "key": "value" (a scheme word is not the value)
    (re.compile(r"(?i)\b(" + SENSITIVE_KEY + r")([\"']?\s*[=:]\s*[\"']?)(?!(?:bearer|basic)\b|\*\*\*)([^\s\"'&;]+)"), r"\1\2***"),
    # user:pass@host in URLs
    (re.compile(r"(://[^\s/@:]+):[^\s/@]+@"), r"\1:***@"),
    # Well-known key shapes: OpenAI, GitHub, Slack, AWS, JWT
    (re.compile(r"\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[a-z]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?)\b"), "***"),
    # Any long opaque blob with both letters & digits (hex, base64, random keys)
    (re.compile(r"\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b"), "***"),
]


def redact(text):
    """Mask anything that looks like a credential."""
    if not isinstance(text, str) or not text:
        return text
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def env_file():
    """KEY=value pairs from ~/.config/cc-board/env, or {} when there is none."""
    values = {}
    path = os.path.expanduser("~/.config/cc-board/env")
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    return values


def setting(name, file_values=None):
    """The environment wins over the env file, so one session can override it."""
    value = os.environ.get(name, "")
    if value:
        return value
    if file_values is None:
        file_values = env_file()
    return file_values.get(name, "")


def load_config():
    values = env_file()
    cfg = {
        "url": setting("CC_BOARD_URL", values),
        "secret": setting("CC_BOARD_SECRET", values),
        "host": setting("CC_BOARD_HOST", values),
    }
    if not cfg["host"]:
        # "Piyueshs-MacBook-Pro.local" -> "Piyueshs-MacBook-Pro"
        cfg["host"] = socket.gethostname().split(".")[0]
    return cfg


def git_branch(cwd):
    """Current branch, or the short commit when HEAD is detached. Empty outside a repo."""
    for args in (["branch", "--show-current"], ["rev-parse", "--short", "HEAD"]):
        try:
            out = subprocess.run(
                ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=1,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    return ""


def tool_target(tool_input, cwd):
    """One short line saying what the tool is acting on."""
    if not isinstance(tool_input, dict):
        return ""
    for key in ("file_path", "notebook_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return os.path.relpath(value, cwd) if cwd and os.path.isabs(value) else value
    for key in ("command", "pattern", "url", "query", "description"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return " ".join(value.split())[:120]
    return ""


def throttled(session_id):
    """True when this session posted a tool event in the last few seconds."""
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id)[:64] or "unknown"
    stamp = os.path.join(tempfile.gettempdir(), f"cc-board-{safe}.stamp")
    now = time.time()
    try:
        if now - os.path.getmtime(stamp) < TOOL_THROTTLE_S:
            return True
    except OSError:
        pass
    try:
        with open(stamp, "w", encoding="utf-8"):
            pass
    except OSError:
        pass
    return False


def build_event(data):
    event = EVENTS.get(data.get("hook_event_name"))
    session_id = data.get("session_id")
    if not event or not session_id:
        return None

    cwd = data.get("cwd") or ""
    payload = {
        "session_id": session_id,
        "event": event,
        "project": os.path.basename(cwd.rstrip("/")) or "unknown",
    }

    if event == "session_end":
        return payload

    if event == "tool":
        if throttled(session_id):
            return None
        payload["tool"] = data.get("tool_name") or ""
        payload["target"] = redact(tool_target(data.get("tool_input"), cwd))
    elif event == "notification":
        payload["message"] = redact(data.get("message") or "")
        payload["notification_type"] = data.get("notification_type") or ""
    elif event == "stop":
        payload["message"] = redact(data.get("last_assistant_message") or "")

    if cwd:
        payload["branch"] = git_branch(cwd)
    return payload


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict):
        return

    cfg = load_config()
    if not cfg["url"] or not cfg["secret"]:
        return

    payload = build_event(data)
    if payload is None:
        return
    payload["host"] = cfg["host"]

    request = urllib.request.Request(
        cfg["url"].rstrip("/") + "/event",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "x-board-secret": cfg["secret"]},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=POST_TIMEOUT_S).read()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - a board problem must never break a session
        pass
    sys.exit(0)
