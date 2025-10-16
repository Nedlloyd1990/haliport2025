import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(__dirname)); // serves index.html and assets

// Serve index.html for any path (so /abc becomes a room called "abc")
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Room + presence (in-memory)
const rooms = new Map(); // roomId -> Set(ws)
const meta  = new Map(); // ws -> {room, username}

function getClientIP(req) {
  const xf = req.headers['x-forwarded-for'];
  let ip = Array.isArray(xf) ? xf[0] : (xf || req.socket?.remoteAddress || '');
  if (typeof ip !== 'string') ip = String(ip || '');
  ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:','');
  return ip || 'unknown';
}

function roomFromReq(req) {
  try {
    const url = new URL(req.url, 'http://placeholder');
    const p = decodeURIComponent(url.pathname || '/').replace(/^\/+|\/+$/g, '');
    return p || 'chat';
  } catch {
    return 'chat';
  }
}

function listUsers(room) {
  const set = rooms.get(room);
  if (!set) return [];
  return [...set].map(c => meta.get(c)?.username).filter(Boolean);
}

function broadcast(room, obj) {
  const set = rooms.get(room);
  if (!set) return;
  const s = JSON.stringify(obj);
  for (const client of set) {
    try { client.send(s); } catch {}
  }
}

wss.on('connection', (ws, req) => {
  const room = roomFromReq(req);
  const username = getClientIP(req);

  // 1:1 policy: max two clients per room
  const set = rooms.get(room) || new Set();
  if (set.size >= 2) {
    ws.send(JSON.stringify({ type:'room_full', message:'This private room already has two people.' }));
    ws.close(4001, 'room full');
    return;
  }

  set.add(ws);
  rooms.set(room, set);
  meta.set(ws, { room, username });

  // Welcome + presence
  ws.send(JSON.stringify({ type:'welcome', room, yourName: username, users: listUsers(room) }));
  broadcast(room, { type:'presence', users: listUsers(room) });

  ws.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf); } catch { return; }
    if (data.type === 'chat') {
      const text = String(data.text || '').slice(0, 4000);
      const msg = { type:'chat', from: username, text, ts: Date.now() };
      broadcast(room, msg);
    }
  });

  ws.on('close', () => {
    meta.delete(ws);
    const s = rooms.get(room);
    if (!s) return;
    s.delete(ws);
    if (s.size === 0) rooms.delete(room);
    else broadcast(room, { type:'presence', users: listUsers(room) });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('1:1 chat server listening on', PORT);
  console.log('Open http://localhost:'+PORT+'/your-room to start chatting');
});
