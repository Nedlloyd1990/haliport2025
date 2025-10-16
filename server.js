
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

// Serve index.html for any path (room = path)
app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
  const p = (new URL(req.url, 'http://x')).pathname.replace(/^\/+|\/+$/g,'');
  return p || 'chat';
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

    // Relay supported message types
    if (data.type === 'chat') {
      broadcast(room, {type:'chat', from:username, text:String(data.text||'').slice(0,4000), ts:Date.now()}, null);
    } else if (data.type === 'file_meta' || data.type === 'file_chunk' || data.type === 'file_done' || data.type === 'file_abort') {
      data.from = username; // tag sender
      broadcast(room, data, ws); // send to the other peer only
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
server.listen(PORT, ()=> console.log('1:1 chat + files on', PORT));
