// DuoCall: a tiny two-person chat with audio/video calls.
// One dependency (ws). No database: chat lives in memory and is lost on restart.
// The server serves the static page, checks the shared room password, and relays
// chat messages and WebRTC call signaling between the two people. Audio and video
// travel directly between the browsers (peer-to-peer), never through this server.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT) || 200;

let ROOM_PASSWORD = process.env.ROOM_PASSWORD;
if (!ROOM_PASSWORD) {
  if (process.env.NODE_ENV === 'production') {
    console.error('ROOM_PASSWORD must be set in production.');
    process.exit(1);
  }
  ROOM_PASSWORD = 'letmein';
  console.warn('ROOM_PASSWORD not set; using "letmein" for local testing only.');
}

// ICE servers the browsers use to find a path to each other. STUN is enough on
// most home/office networks; a TURN server is needed when one side is behind a
// strict NAT (some mobile networks). Configure TURN with the env vars below.
const iceServers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
if (process.env.TURN_URLS) {
  iceServers.push({
    urls: process.env.TURN_URLS.split(','),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || ''
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

// ---- room state (in memory) ----
const peers = new Map(); // name -> ws
const history = []; // recent chat messages

const sha = (s) => createHash('sha256').update(String(s)).digest();
const passwordOk = (given) => timingSafeEqual(sha(given), sha(ROOM_PASSWORD));

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function other(name) {
  for (const [n, ws] of peers) if (n !== name) return ws;
  return null;
}
function broadcastPresence() {
  const online = [...peers.keys()];
  for (const ws of peers.values()) send(ws, { type: 'presence', online });
}

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 64 * 1024 });

// Signaling message types relayed untouched to the other person.
const RELAY = new Set(['call', 'accept', 'decline', 'busy', 'hangup', 'offer', 'answer', 'ice', 'typing', 'media']);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let me = null;
  let failed = 0;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (!me) {
      if (msg.type !== 'join') return;
      const name = String(msg.name || '').trim().slice(0, 30);
      if (!name || !passwordOk(msg.password || '')) {
        failed++;
        send(ws, { type: 'join-error', message: 'Wrong name or password.' });
        if (failed >= 5) ws.close();
        return;
      }
      if (!peers.has(name) && peers.size >= 2) {
        send(ws, { type: 'join-error', message: 'This room already has two people.' });
        return;
      }
      // Same name again (page refresh, second tab): the new connection wins.
      const old = peers.get(name);
      if (old) {
        send(old, { type: 'kicked', message: 'You signed in from another tab or device.' });
        old.terminate();
      }
      me = name;
      peers.set(me, ws);
      send(ws, { type: 'joined', name: me, iceServers, history });
      broadcastPresence();
      return;
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 2000);
      if (!text) return;
      const entry = { id: Date.now() + Math.random().toString(36).slice(2, 6), from: me, text, at: new Date().toISOString() };
      history.push(entry);
      if (history.length > HISTORY_LIMIT) history.shift();
      for (const peer of peers.values()) send(peer, { type: 'chat', ...entry });
      return;
    }

    if (RELAY.has(msg.type)) {
      const peer = other(me);
      if (peer) send(peer, { ...msg, from: me });
      else if (msg.type === 'call') send(ws, { type: 'unavailable' });
    }
  });

  ws.on('close', () => {
    if (me && peers.get(me) === ws) {
      peers.delete(me);
      send(other(me), { type: 'hangup', from: me, reason: 'left' });
      broadcastPresence();
    }
  });
});

// Keep connections alive behind proxies and drop dead ones.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`DuoCall listening on port ${PORT}`);
});
