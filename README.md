# DuoCall

A tiny private chat with **audio and video calls** for exactly **two people**.

- **No database.** Chat history lives in server memory (last 200 messages) and is cleared on restart.
- **Light:** one dependency (`ws`), plain HTML/CSS/JS, no build step. About 80 KB of code.
- **Calls are peer-to-peer (WebRTC).** Audio and video go directly between the two browsers; the server only relays chat and call setup messages.
- One shared **room password**. Only two people can be in the room at a time.
- Works in Chrome, Edge, Firefox and Safari, on desktop and phone.

## Features

- Text chat with timestamps, typing indicator, online status
- Audio call and video call, with accept/decline, ringing, 45-second no-answer timeout
- Mute, camera on/off, front/back camera switch (phones), call timer
- Call log in the chat ("Video call · 03:12", "Missed audio call")
- Light and dark mode, mobile friendly

## Run locally

Requires Node.js 18 or newer.

**Windows:** double-click `run.bat`, or run `run.bat mypassword` to set the room password. It opens <http://localhost:3000>.

**Any OS:**

```bash
npm install
npm start          # room password defaults to "letmein" locally
```

Set your own password:

```bash
# PowerShell
$env:ROOM_PASSWORD="mypassword"; npm start
# cmd
set ROOM_PASSWORD=mypassword && npm start
# macOS / Linux
ROOM_PASSWORD=mypassword npm start
```

To try it alone, open <http://localhost:3000> in two different browsers (or one normal and one private window) and sign in with two different names.

> Browsers only allow camera and microphone on **HTTPS** or **localhost**. A phone opening `http://192.168.x.x:3000` can chat but not call. Deploy it (below) to test calls on phones.

## Deploy on Render (free)

1. Push this folder to a GitHub repository.
2. In the [Render dashboard](https://dashboard.render.com): **New + → Blueprint**, connect the repository.
3. Render reads `render.yaml`. Enter a **ROOM_PASSWORD** when asked, then click **Apply**.
4. Wait for "Your service is live", then open the `https://….onrender.com` URL on both devices.

Manual alternative: **New + → Web Service**, Language **Node**, Build Command `npm ci --omit=dev`, Start Command `node server.js`, Health Check Path `/health`, Instance Type **Free**, environment variables `NODE_ENV=production` and `ROOM_PASSWORD=<your password>`.

Free-plan notes: the service sleeps after 15 minutes without visitors (first visit then takes about a minute), and a restart clears the chat history. Calls are unaffected because media goes peer-to-peer.

## Deploy with Docker (any VPS, AWS, etc.)

```bash
docker build -t duocall .
docker run -d --name duocall --restart unless-stopped -p 3000:3000 \
  -e ROOM_PASSWORD=mypassword duocall
```

Put it behind HTTPS (calls need it). The simplest way is Caddy, which gets a free certificate automatically:

```bash
docker run -d --name caddy --restart unless-stopped --network host -v caddy_data:/data caddy:2 \
  caddy reverse-proxy --from your.domain.com --to localhost:3000
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROOM_PASSWORD` | `letmein` (local only) | Shared password. **Required** when `NODE_ENV=production`. |
| `PORT` | `3000` | Port to listen on (Render sets this automatically). |
| `HISTORY_LIMIT` | `200` | Messages kept in memory. |
| `STUN_URLS` | Google public STUN | Comma-separated STUN servers. |
| `TURN_URLS` | none | Comma-separated TURN servers, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349` |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | none | TURN login. |

### When do I need TURN?

Calls connect directly between the two devices using STUN, which works on most home, office and Wi-Fi networks. If one person is on a strict network (some mobile carriers, corporate firewalls), the call shows **"Could not connect the call"**. Then add a TURN server, which relays the media: use a hosted TURN provider (e.g. Metered, Twilio, Cloudflare) or run your own [coturn](https://github.com/coturn/coturn), and set the `TURN_*` variables.

## How it works

```
Browser A  ── WebSocket (chat + call setup) ──  server.js  ── WebSocket ──  Browser B
    └────────────── audio / video (WebRTC, peer-to-peer) ──────────────────────┘
```

- `server.js` serves `public/`, checks the room password, allows at most two names, and relays messages. `GET /health` returns `{"status":"ok"}`.
- `public/app.js` handles the chat UI and the WebRTC call (offer/answer/ICE over the WebSocket).

## Files

```
server.js         HTTP + WebSocket server (no framework)
public/           index.html, style.css, app.js, favicon.svg
Dockerfile        production image (Node 22 Alpine)
render.yaml       Render Blueprint
run.bat           one-click local start on Windows
```

## Security notes

Built for two people who trust each other. The shared password keeps strangers out, and a wrong password 5 times closes the connection. Use a strong password, always deploy behind HTTPS, and note that signing in with the same name from a new device signs the old one out.
