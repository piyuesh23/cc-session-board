#!/usr/bin/env python3
"""Push devbox CPU & RAM to the hub. Linux only (reads /proc).

    python3 push_vitals.py            # one sample
    python3 push_vitals.py --loop 30  # one sample every 30 s

Uses the same config as the hook: CC_BOARD_URL & CC_BOARD_SECRET from the
environment or ~/.config/cc-board/env.
"""

import json
import os
import socket
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from cc_board_hook import load_config  # noqa: E402


def cpu_times():
    with open("/proc/stat", encoding="utf-8") as fh:
        fields = [int(x) for x in fh.readline().split()[1:]]
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    return idle, sum(fields)


def cpu_percent(interval=0.5):
    idle1, total1 = cpu_times()
    time.sleep(interval)
    idle2, total2 = cpu_times()
    span = total2 - total1
    return 0.0 if span <= 0 else 100.0 * (1 - (idle2 - idle1) / span)


def ram_gb():
    info = {}
    with open("/proc/meminfo", encoding="utf-8") as fh:
        for line in fh:
            key, value = line.split(":", 1)
            info[key] = int(value.split()[0])  # kB
    total = info["MemTotal"]
    used = total - info.get("MemAvailable", info.get("MemFree", 0))
    return used / 1048576, total / 1048576


def push(cfg):
    used, total = ram_gb()
    body = {
        "host": socket.gethostname(),
        "cpu": round(cpu_percent(), 1),
        "ram_used_gb": round(used, 1),
        "ram_total_gb": round(total, 1),
    }
    request = urllib.request.Request(
        cfg["url"].rstrip("/") + "/vitals",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "x-board-secret": cfg["secret"]},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=3).read()


def main():
    cfg = load_config()
    if not cfg["url"] or not cfg["secret"]:
        sys.exit("CC_BOARD_URL & CC_BOARD_SECRET are not set")
    every = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--loop" else 0
    while True:
        try:
            push(cfg)
        except OSError as err:
            print(f"push failed: {err}", file=sys.stderr)
            if not every:
                sys.exit(1)
        if not every:
            return
        time.sleep(every)


if __name__ == "__main__":
    main()
