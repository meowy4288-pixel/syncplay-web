# Syncplay Web (MVP)

Minimal browser extension that syncs HTML5 `<video>` play/pause/seek using the **official Syncplay protocol** through a small WebSocket↔TCP bridge.

> MVP status: works for basic HTML5 video sync. Not feature-complete with desktop Syncplay.

## Why the bridge exists

Syncplay servers speak TCP with newline-delimited JSON. Browser extensions cannot open raw TCP sockets, so the extension connects to `bridge/server.js` over WebSocket, and the bridge forwards Syncplay JSON lines to the Syncplay TCP server.

## Repo layout

```text
syncplay-web/
  bridge/      # WS <-> TCP bridge (Node.js)
  extension/   # MV3 browser extension (Firefox/Chromium)
```

## Prerequisites

- Node.js 18+ (for bridge)
- A Syncplay TCP server to connect to (local or public)
- Chromium/Firefox/Nightly for loading the extension

## Quick start (local)

### 1) Run a Syncplay server

If you have Syncplay source installed:

```bash
python3 syncplayServer.py --port 8999 --isolate-rooms
```

Or use any reachable Syncplay server.

### 2) Run the bridge

```bash
cd bridge
npm install
npm start
# Bridge: ws://127.0.0.1:8998/bridge
```

By default the bridge only allows localhost Syncplay targets. To connect to a public/remote Syncplay server:

```bash
ALLOW_ANY_TARGET=1 npm start
```

Optional env vars:

- `PORT` - bridge listen port (default `8998`)
- `SYNCPLAY_HOST` - default target host (default `127.0.0.1`)
- `SYNCPLAY_PORT` - default target port (default `8999`)
- `ALLOW_ANY_TARGET=1` - allow non-localhost targets

### 3) Load the extension

**Chromium / Chrome**
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select the `extension/` folder

**Firefox (temporary)**
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `extension/manifest.json`

**Firefox Nightly (persistent unsigned install)**
1. Set `xpinstall.signatures.required` to `false` in `about:config` (Nightly/dev builds)
2. Package XPI:

```bash
cd extension
zip -r ../syncplay-web-mvp.xpi . -x '*.git*' -x '*node_modules/*'
```

3. `about:addons` → gear icon → **Install Add-on From File...** → select the XPI

### 4) Configure popup

Open the extension popup and set:

- **Bridge WS URL**: `ws://127.0.0.1:8998/bridge`
- **Syncplay server**: `127.0.0.1`
- **Port**: `8999`
- **Room**: same room on all clients
- **Username**: unique per client
- **Password**: only if the Syncplay server requires it

Click **Connect**. The popup should show `connected`.

## Using it

- Open the same type of HTML5 video on all clients.
- Play/pause/seek from any client; others should follow.
- **Leader mode (optional MVP)**: click “Become leader” to make only that client drive state. Pass/release as needed. If no leader is set, anyone can drive.
- If multiple video tabs are open, click/play the video you want synced to make it the active frame.

## What works (MVP)

- Syncplay `Hello`, `Set` (room/file/ready), `List`, `State`, `Error`
- WS↔TCP bridge for browser compatibility
- HTML5 `<video>` play/pause/seek sync
- Basic user list, ready toggle, resync button
- Simple leader/follower guard (client-side, hidden chat control)

## Known limitations

- **Not full Syncplay parity**: no chat UI, playlists, managed rooms, TLS-in-protocol, buffering/readiness handling.
- **File identity is weak**: sends page title + duration, size 0. Syncplay file matching may be imperfect.
- **No playback-rate smoothing**: large drift corrects by seek; small drift may be tolerated.
- **Bridge security**: no auth/TLS. Keep it local or put it behind trusted auth/TLS/reverse proxy before exposing.
- **Leader is not secure authorization**: it’s a client-side convention over hidden Syncplay chat messages.
- **Site/player compatibility**: works best with plain HTML5 `<video>`. Custom players/iframes may vary.

## Troubleshooting

- **Popup stuck disconnected / bridge**: check `bridge` is running and bridge URL is correct.
- **Bridge EADDRINUSE 8998**: another process is using the port. Kill it or change `PORT`.
- **Connected but no sync**: confirm popup shows “video attached”; check both clients are in same room/server.
- **Nightly resets on Connect**: reload the updated extension/XPI.
- **Public Syncplay server**: run bridge with `ALLOW_ANY_TARGET=1`.

## Development notes

- Bridge logs to stdout; useful debug: `node server.js` or inspect nohup log.
- Content script: `extension/src/content/content.js`
- Background/protocol: `extension/src/background/background.js`
- Popup: `extension/src/popup/*`

## Safety

- Do not expose the bridge publicly without auth/TLS and target restrictions.
- Treat remote chat/content as untrusted if chat features are added.
