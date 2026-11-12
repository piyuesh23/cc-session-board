#!/usr/bin/env bash
# Claude Code status line wrapper. Hands the status line JSON to the usage
# pusher in the background, then runs your real status line command with the
# same JSON on stdin, so its output is unchanged.
#
#   "statusLine": { "type": "command",
#                   "command": "~/cc-session-board/hooks/cc_board_statusline.sh bash ~/.claude/statusline-command.sh" }
#
# With no arguments it prints nothing, which is fine if you had no status line.

input=$(cat)
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

printf '%s' "$input" | python3 "$here/cc_board_usage.py" >/dev/null 2>&1 &
disown 2>/dev/null

if [ "$#" -gt 0 ]; then
  printf '%s' "$input" | "$@"
fi
