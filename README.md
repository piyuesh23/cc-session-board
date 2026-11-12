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
- **Tap** a tile to acknowledge it: the pulse stops. **Long press** to hide it until its next event.
- A chime plays on the iPhone when a session newly needs input. Tap the screen once after loading to allow sound.
- The screen dims in quiet hours (23:00 to 07:00 by default) & after 30 minutes with no change. Touch it to wake it for a minute.
- A stale session is dropped from the board after 60 minutes. A blocked one never goes stale.

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

## Configuration

Hub, in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOARD_SECRET` | none, required | Shared secret for `/event` & `/vitals` |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address. Set it to the Pi's Tailscale IP |
| `STALE_MIN` | `10` | Minutes of silence before a tile goes grey |
| `HIDE_MIN` | `60` | Minutes of silence before a tile is dropped |
| `QUIET_HOURS` | `23:00-07:00` | No chime & a dimmed screen, in the iPhone's local time |
| `STATE_FILE` | `data/state.json` | Snapshot so a hub restart keeps the board. Empty disables it |

## Things to know

- **Security:** `/event` & `/vitals` need the secret. `/ack` & `/hide` don't, because the page can't keep a secret. So the hub is only as private as the network it listens on: bind `HOST` to the Tailscale IP & keep it off the LAN.
- **What leaves the laptop:** machine name, project directory name, branch, tool name, the file or command a tool is acting on (120 chars), the notification text & the last assistant message (200 chars). Prompts are never sent.
- **Hooks never block a session:** they run with `async`, the script times out after 2 seconds & always exits 0. If the Pi is off, Claude Code carries on as normal.
- **Tool events are throttled** to one every 5 seconds per session.
- **Laptops sleep & roam:** a closed lid sends no event, so that session's tile goes grey after 10 minutes & drops off after 60. Off the tailnet the hook just gives up quietly; the board catches up on the next event.
- **Idle notifications:** Claude Code sends an idle notification about a minute after a turn ends. The board keeps that session blue instead of turning it amber, otherwise every finished session would chime twice.
- **Live updates use SSE, not a websocket.** It needs no library on the Pi & Safari reconnects on its own.

## Not built yet

This is the "Live" tier of the spec. Still open: the history drawer (the hub already keeps the last 10 events per session), Coolify health in the strip, ntfy push to the main phone, the daily digest, the presence panel & two-way Allow / Deny from the phone.

## Development

```bash
npm test          # 17 tests, hub & state logic
```

- `lib/store.js`: session state & ordering, no I/O.
- `server.js`: HTTP routes, SSE, snapshot file.
- `public/index.html`: the board.
- `hooks/cc_board_hook.py`: the Claude Code hook.
- `scripts/push_vitals.py`, `scripts/simulate.js`: vitals pusher & sample data.
