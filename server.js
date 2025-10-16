
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
app.use(express.static(__dirname));

// health endpoint
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// Serve SPA for any other path
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = http.createServer(app);
// IMPORTANT: fixed WS path to avoid wildcard route conflicts
const wss = new WebSocketServer({ server, path: '/ws' });

// Keep-alive pings
setInterval(() => { wss.clients.forEach(ws => { try { ws.ping(); } catch {} }); }, 25000);

// In-memory rooms
const rooms = new Map(); // id -> Set(ws)
const meta  = new Map(); // ws -> {room, username}

function getClientIP(req) {
  const xf = req.headers['x-forwarded-for'];
  let ip = Array.isArray(xf) ? xf[0] : (xf || req.socket?.remoteAddress || '');
  ip = String(ip || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}
function roomFromReq(req) {
  // Room is derived from HTTP Referer path or ?room=... header fallback
  const ref = req.headers['referer'] || '/';
  try {
    const url = new URL(ref);
    const p = (url.pathname || '/').replace(/^\/+|\/+$/g, '');
    return p || 'chat';
  } catch {
    return 'chat';
  }
}
function users(room){ const set = rooms.get(room); return set ? [...set].map(c=>meta.get(c)?.username).filter(Boolean) : []; }
function broadcast(room, obj, exclude) {
  const set = rooms.get(room); if (!set) return;
  const s = JSON.stringify(obj);
  for (const ws of set) if (ws !== exclude) try{ ws.send(s); }catch{}
}

wss.on('connection', (ws, req) => {
  const room = roomFromReq(req);
  const username = getClientIP(req);

  const set = rooms.get(room) || new Set();
  if (set.size >= 2) { ws.send(JSON.stringify({type:'room_full'})); ws.close(4001,'full'); return; }
  set.add(ws); rooms.set(room,set); meta.set(ws,{room,username});

  ws.send(JSON.stringify({type:'welcome', room, yourName:username, users: users(room)}));
  broadcast(room,{type:'presence', users: users(room)}, ws);

  ws.on('message', buf => {
    let data; try{ data = JSON.parse(buf); }catch{ return; }
    const info = meta.get(ws); if (!info) return;
    const {room, username} = info;

    if (data.type === 'chat') {
      broadcast(room, {type:'chat', from:username, text:String(data.text||'').slice(0,4000), ts:Date.now()}, null);
    } else if (['file_meta','file_chunk','file_done','file_abort'].includes(data.type)) {
      data.from = username;
      broadcast(room, data, ws);
    }
  });

  ws.on('close', ()=>{
    meta.delete(ws);
    const set = rooms.get(room);
    if (!set) return;
    set.delete(ws);
    if (set.size===0) rooms.delete(room);
    else broadcast(room,{type:'presence', users: users(room)}, null);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('1:1 chat + files (v3.2) on', PORT));
