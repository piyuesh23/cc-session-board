# cc-session-board

A status board for Claude Code sessions. I run several sessions across projects at the same time & kept missing the moment one of them stopped to ask me something. This puts every session on a spare iPhone sitting at my desk, in landscape, with the blocked one first & in amber.

## At a glance

- **Hook** (each laptop, macOS or Linux): a small Python script that Claude Code calls on session events. It posts one JSON event per call to the hub.
- **Hub** (Raspberry Pi 4): a single Node process with no dependencies. It keeps the latest state per session & pushes changes to the board.
- **Board** (iPhone 12 mini): one static HTML page served by the hub, opened full-screen in Safari.

Everything talks over Tailscale. Nothing is exposed to the internet. Sessions from all laptops land on the same board, each tile tagged with its machine.

```
Mac     \
         >  Claude Code hooks  ->  POST /event  ->  hub on the Pi  ->  /live (SSE)  ->  iPhone
Fedora  /
```

## What the board shows

| State | Colour | When |
| --- | --- | --- |
| NEEDS INPUT | Amber, pulsing | A permission prompt or a question is waiting on you |
| WORKING | Green | A prompt was submitted or a tool just ran |
| DONE | Blue | The turn finished |
| STALE | Grey | No events for 10 minutes |

- Order is blocked, working, done, stale. Within a state, the longest wait comes first.
- The big number on each tile is the time spent in the current state.
- The foot of each tile names the machine the session is on, so I know which laptop to go to.
- The left strip has the clock & a count of waiting sessions. CPU & RAM of one Linux box show up there too if you run the vitals pusher.
- **Claude subscription usage** (Pro, Max & Ultra plans) sits in the strip as two bars, the 5-hour window & the week, with the share used & the time until each resets. Green below 50% used, amber from 50%, red from 85% (where Claude Code itself starts warning). The bars fade when the last report is over an hour old, & say "reset" once a window has rolled over.
- **Tap** a tile to acknowledge it: the pulse stops. **Long press** to hide it until its next event.
- A chime plays on the iPhone when a session newly needs input. Tap the screen once after loading to allow sound.
- The screen dims in quiet hours (23:00 to 07:00 by default) & after 30 minutes with no change. Touch it to wake it for a minute.
- A stale session is dropped from the board after 60 minutes. A blocked one never goes stale, but is dropped after 24 hours of silence.

## Setup

### 1. Hub on the Pi

Needs Node 18 or later.

```bash
git clone <this repo> ~/cc-session-board && cd ~/cc-session-board
cp .env.example .env        # set BOARD_SECRET (openssl rand -hex 24)
set -a && . ./.env && set +a && npm start
```

To check the layout before wiring any hooks:

```bash
BOARD_SECRET=<secret> npm run simulate
```

To keep it running, edit the user & paths in `deploy/cc-board-hub.service`, then:

```bash
sudo cp deploy/cc-board-hub.service /etc/systemd/system/
sudo systemctl enable --now cc-board-hub
```

### 2. Hooks on each laptop

Repeat this on every machine that runs Claude Code. Needs Python 3 only, which Fedora ships & macOS has once the Xcode command line tools are installed. The laptop must be on the tailnet to reach the Pi.

```bash
git clone <this repo> ~/cc-session-board
mkdir -p ~/.config/cc-board && chmod 700 ~/.config/cc-board
cat > ~/.config/cc-board/env <<'EOF'
CC_BOARD_URL=http://<pi-tailscale-ip>:8787
CC_BOARD_SECRET=<same value as BOARD_SECRET>
CC_BOARD_HOST=mac
EOF
chmod 600 ~/.config/cc-board/env
```

`CC_BOARD_HOST` is the label shown on the tiles (`mac`, `fedora`). Leave it out & the machine's hostname is used.

Merge the `hooks` block from `hooks/settings.example.json` into `~/.claude/settings.json`. Sessions started after that will show up on the board.

For the subscription usage bars, also set `statusLine` as in `hooks/settings.example.json`. Claude Code only exposes the 5-hour & weekly limits to the status line command, so `hooks/cc_board_statusline.sh` reads them from there, posts them to the hub in the background & then runs whatever status line you already had (pass that command as its arguments; leave them out if you had none). Your status line output does not change. Do this on one laptop or all of them: the numbers are per account, so every laptop reports the same ones & the latest report wins.

Optional, to answer permission prompts remotely (see [Remote allow / deny](#remote-allow--deny)): the `PermissionRequest` entry in `hooks/settings.example.json` runs `hooks/cc_board_permission.py`. Leave it out, or set `CC_BOARD_APPROVE_WAIT=0` in `~/.config/cc-board/env`, to keep every prompt in the terminal.

Optional, for CPU & RAM of one always-on Linux box (e.g. the devbox) in the left strip. It reads `/proc`, so it doesn't run on macOS:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/cc-board-vitals.service ~/.config/systemd/user/
systemctl --user enable --now cc-board-vitals
```

### 3. iPhone

1. Open `http://<pi-tailscale-ip>:8787` in Safari, then Share > Add to Home Screen. Launch it from the home screen for full-screen.
2. Settings > Display & Brightness > Auto-Lock > Never.
3. Turn the phone on its side on the stand. Enable Guided Access (Settings > Accessibility) & start it with a triple click so a stray tap can't leave the page.
4. Keep the ring switch on. iOS mutes web audio when the phone is on silent.

The 12 mini has no always-on display mode, so this is a normal screen that stays lit. The page shifts by a few pixels every 3 minutes to protect the OLED.

## Remote allow / deny

Waiting prompts can be answered from the board itself or from anything else that holds a key (in my case also a voice assistant). That covers both kinds of "Claude is waiting on you":

- **Permission prompts:** the amber tile shows **Allow** / **Deny**.
- **Questions** (`AskUserQuestion`, when Claude offers options to choose from): the tile shows the question & one button per option. Multi-select questions toggle, then **Send**; several questions step through one at a time. **Skip** tells Claude you'd rather answer in the terminal.

**Pairing the board:** set `APPROVE_SECRET` on the hub, then on the phone tap **Pair to answer** (it appears in the strip while a prompt is waiting) & paste the key, or open the board once as `http://<pi>:8787/#key=<APPROVE_SECRET>`. The key is kept in that browser's local storage. On iOS a home-screen app has its own storage, so pair from inside the app with the button. An unpaired board looks & works exactly as before. If the hub rejects the key, the board forgets it & shows the button again.

`APPROVE_SECRET` is narrower than `BOARD_SECRET`: it can only list & answer prompts, not post events, open prompts or poll them. So the phone never holds the key the laptops use. It still lets whoever has it run tools on your laptops, so treat the phone like a key.

1. Claude Code is about to ask for permission & runs the `PermissionRequest` hook. `cc_board_permission.py` posts the tool & its target (redacted, as for the board) to the hub. The tile turns amber straight away.
2. The hook long-polls the hub for up to `CC_BOARD_APPROVE_WAIT` seconds (default 120).
3. The board (or another remote) reads `GET /permissions` & answers with `POST /permission/<id>/decide`.
4. Allow runs the tool. For a question, the hook fills in `answers` the way the terminal dialog would, keyed by Claude's original question text (the hub only sees the redacted copy, so it answers with option positions & the hook maps them back). Deny tells Claude it was denied (with the remote's message if it sent one). No answer in time, or any error, & the hook cancels its request & prints nothing, so Claude Code asks in the terminal as usual.

**The trade-off:** the Claude Code hooks docs say this hook runs when Claude Code is *about to* ask, i.e. before the prompt is shown, & a hook's decision replaces the prompt. They don't spell out whether the terminal prompt shows while the hook is still running, so expect that for up to `CC_BOARD_APPROVE_WAIT` seconds there is nothing to answer at the laptop; the usual prompt appears once the remote wait runs out. Keep the wait short if you are often at the laptop. The hook's `timeout` in `settings.json` (180) must stay above the wait or Claude Code kills the script first; the hub then drops the orphaned request after 15 minutes. In sessions that can't show a prompt at all (e.g. background subagents in `-p` mode), no remote answer means Claude Code denies the call. A remote allow does not override your deny or ask rules: Claude Code still applies them.

Routes, all needing `x-board-secret`. `GET /permissions` & `decide` take `BOARD_SECRET` or `APPROVE_SECRET`; the rest only `BOARD_SECRET`:

| Route | Body / query | Response |
| --- | --- | --- |
| `POST /permission` | `{session_id, project, host, branch, tool, target}` | `{ok, id}` |
| `GET /permission/<id>?wait=<s>` | holds up to `min(wait, 30)` seconds | `{ok, state: pending \| allow \| deny \| cancelled, message?}`, 404 if unknown |
| `GET /permissions` | | `{ok, pending: [{id, session_id, project, host, branch, tool, target, questions?, createdAt}]}`, oldest first. `questions` only for `AskUserQuestion`: `[{question, header, multiSelect, options: [{label, description}]}]` |
| `POST /permission/<id>/decide` | `{decision: allow \| deny, message?, answers?}`. Allowing a question needs `answers`: one entry per question, a label, or a list of labels for multi-select | 200, 400 bad decision or answers, 404 unknown, 409 already decided or cancelled |
| `POST /permission/<id>/cancel` | | 200, 404 unknown |

Requests live in memory only: a pending one expires after 15 minutes, a decided one is dropped a minute later, & a hub restart forgets them all (the waiting hook then falls back to the terminal). The board payload carries only a `permissions` count, never the prompts.

## Configuration

Hub, in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOARD_SECRET` | none, required | Shared secret for `/event`, `/vitals`, `/usage` & the `/permission` routes |
| `APPROVE_SECRET` | none | Key for answering prompts from the board (list & decide only). Unset means the board can't answer |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address. `tailscale` resolves the Pi's Tailscale IP at startup; the default warns because it listens on every interface |
| `STALE_MIN` | `10` | Minutes of silence before a tile goes grey |
| `HIDE_MIN` | `60` | Minutes of silence before a tile is dropped |
| `BLOCKED_MAX_H` | `24` | Hours of silence before a blocked tile is dropped |
| `QUIET_HOURS` | `23:00-07:00` | No chime & a dimmed screen, in the iPhone's local time |
| `STATE_FILE` | `data/state.json` | Snapshot so a hub restart keeps the board. Empty disables it |

Hooks, in the environment or `~/.config/cc-board/env`: `CC_BOARD_URL`, `CC_BOARD_SECRET`, `CC_BOARD_HOST` (see setup) and `CC_BOARD_APPROVE_WAIT`, the seconds the permission hook waits for a remote answer (default `120`, `0` turns it off).

## Things to know

- **Security:** `/event`, `/vitals`, `/usage` & every `/permission` route need the secret (`GET /permissions` & `decide` also take `APPROVE_SECRET`). Approval is never open like `/ack`: an answer lets a tool run on a laptop, so being on the network isn't enough. The open board payload carries only a count of waiting prompts; the prompts & their options are fetched with the key. Everything the page uses doesn't, because the page can't keep a secret: `/sessions` & `/live` (which carry tool targets & the last assistant message) and `/ack` & `/hide`. So the hub is only as private as the network it listens on: set `HOST=tailscale` (or the Tailscale IP) & keep it off the LAN. The hub prints a warning at startup when it listens on every interface.
- **What leaves the laptop:** machine name, project directory name, branch, tool name, the file or command a tool is acting on (120 chars), the notification text & the last assistant message (200 chars), & from the status line only the two usage percentages & their reset times. Prompts are never sent. Anything that looks like a credential in those strings (`TOKEN=…`, `Bearer …`, `user:pass@`, `--password …`, known key shapes, long random blobs) is masked with `***` by the hook before it is sent, because the hub keeps them in plain text.
- **Hooks never block a session:** they run with `async`, the script times out after 2 seconds & always exits 0. If the Pi is off, Claude Code carries on as normal. The one exception is the permission hook, which by design holds the prompt for up to `CC_BOARD_APPROVE_WAIT` seconds; it too always exits 0, & if the Pi is off it gives up at once.
- **Tool events are throttled** to one every 5 seconds per session. Usage is sent when the numbers change, or every 5 minutes otherwise.
- **Usage can lag:** Claude Code refreshes the status line after each assistant message, so the bars are current while you work & freeze when every session is idle (they fade after an hour). They appear only once a session has had its first reply, & only on claude.ai subscription plans, not API keys.
- **Laptops sleep & roam:** a closed lid sends no event, so that session's tile goes grey after 10 minutes & drops off after 60. Off the tailnet the hook just gives up quietly; the board catches up on the next event.
- **Idle notifications:** Claude Code sends an idle notification about a minute after a turn ends. The board keeps that session blue instead of turning it amber, otherwise every finished session would chime twice. An `auth_success` notification is informational too & leaves the tile as it is; any other notification type counts as a question.
- **Live updates use SSE, not a websocket.** It needs no library on the Pi & Safari reconnects on its own when it notices a drop. iOS often doesn't notice (a suspended home screen app, a Wi-Fi or Tailscale reconnect), so the hub pings every 15 seconds & the page starts over, fetching the board first, after 40 seconds of silence or whenever it becomes visible or comes back online. The "Hub offline" pill shows while that happens.

## Not built yet

This is the "Live" tier of the spec. Still open: the history drawer (the hub already keeps the last 10 events per session), Coolify health in the strip, ntfy push to the main phone, the daily digest & the presence panel. Remote allow / deny & answering questions work from the board once it is paired.

## Development

```bash
npm test          # hub, state logic & the Python hook (needs python3)
```

- `lib/store.js`: session state & ordering, no I/O.
- `server.js`: HTTP routes, SSE, snapshot file.
- `public/index.html`: the board.
- `lib/permissions.js`: pending permission prompts & their answers, no I/O.
- `hooks/cc_board_hook.py`: the Claude Code hook.
- `hooks/cc_board_permission.py`: the `PermissionRequest` hook for remote allow / deny.
- `hooks/cc_board_statusline.sh` + `hooks/cc_board_usage.py`: status line wrapper that forwards the subscription usage.
- `scripts/push_vitals.py`, `scripts/simulate.js`: vitals pusher & sample data.
