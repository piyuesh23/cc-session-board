#!/usr/bin/env python3
"""Claude Code status line -> cc-session-board hub: subscription usage.

Reads the status line JSON on stdin and posts its rate_limits (the 5-hour &
7-day windows Claude Code shows in /usage) to the hub. Nothing else in the
JSON is sent. Silent & exit 0 whatever happens, so the status line never
suffers. Same config as the hook: CC_BOARD_URL, CC_BOARD_SECRET, CC_BOARD_HOST.

Wired through cc_board_statusline.sh, which also runs your real status line.
"""

import json
import os
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cc_board_hook import load_config  # noqa: E402

WINDOWS = ("five_hour", "seven_day")
REPEAT_EVERY_S = 300   # unchanged numbers are re-sent this often so the hub knows they are current
POST_TIMEOUT_S = 2


def build_payload(data):
    limits = data.get("rate_limits") if isinstance(data, dict) else None
    if not isinstance(limits, dict):
        return None
    payload = {}
    for name in WINDOWS:
        window = limits.get(name)
        if not isinstance(window, dict):
            continue
        used, resets = window.get("used_percentage"), window.get("resets_at")
        if isinstance(used, (int, float)) and isinstance(resets, (int, float)):
            payload[name] = {"used_percentage": used, "resets_at": resets}
    return payload or None


def already_sent(payload):
    """True when the same numbers went out recently. Remembers this payload otherwise."""
    stamp = os.path.join(tempfile.gettempdir(), "cc-board-usage.json")
    now = time.time()
    try:
        with open(stamp, encoding="utf-8") as fh:
            last = json.load(fh)
        if last.get("payload") == payload and now - float(last.get("at", 0)) < REPEAT_EVERY_S:
            return True
    except (OSError, ValueError):
        pass
    try:
        with open(stamp, "w", encoding="utf-8") as fh:
            json.dump({"at": now, "payload": payload}, fh)
    except OSError:
        pass
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    cfg = load_config()
    if not cfg["url"] or not cfg["secret"]:
        return
    payload = build_payload(data)
    if payload is None or already_sent(payload):
        return
    payload["host"] = cfg["host"]
    request = urllib.request.Request(
        cfg["url"].rstrip("/") + "/usage",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "x-board-secret": cfg["secret"]},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=POST_TIMEOUT_S).read()


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - a board problem must never break the status line
        if os.environ.get("CC_BOARD_DEBUG"):
            print(f"cc_board_usage: {type(err).__name__}: {err}", file=sys.stderr)
    sys.exit(0)
