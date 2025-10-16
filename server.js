
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
app.use(express.static(__dirname)); // serves index.html

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Very simple room server:
 * - Clients send: {type:'join', room, username}
 * - Then send:    {type:'chat', text}
 * - We keep everything in memory (no DB). When server restarts, history is lost.
 * - "1:1" policy: only TWO people can be in a room at once. A 3rd gets rejected.
 */
const rooms = new Map(); // roomId -> Set(ws)
const meta  = new Map(); // ws -> {room, username}

function broadcast(room, obj) {
  const set = rooms.get(room);
  if (!set) return;
  for (const client of set) {
    try { client.send(JSON.stringify(obj)); } catch {}
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf); } catch { return; }

    if (data.type === 'join') {
      const { room, username } = data;
      if (!room || !username) return;

      const set = rooms.get(room) || new Set();
      if (set.size >= 2) {
        ws.send(JSON.stringify({ type:'room_full', message:'This private room already has two people.' }));
        ws.close(4001, 'room full');
        return;
      }

      set.add(ws);
      rooms.set(room, set);
      meta.set(ws, { room, username });

      ws.send(JSON.stringify({ type:'joined', room, users: [...set].map(c => meta.get(c)?.username).filter(Boolean) }));
      broadcast(room, { type:'presence', users: [...set].map(c => meta.get(c)?.username).filter(Boolean) });
      return;
    }

    if (data.type === 'chat') {
      const info = meta.get(ws);
      if (!info) return;
      const { room, username } = info;
      const msg = { type:'chat', from: username, text: String(data.text||'').slice(0, 2000), ts: Date.now() };
      broadcast(room, msg);
      return;
    }
  });

  ws.on('close', () => {
    const info = meta.get(ws);
    if (!info) return;
    const { room } = info;
    meta.delete(ws);
    const set = rooms.get(room);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) rooms.delete(room);
    else broadcast(room, { type:'presence', users: [...set].map(c => meta.get(c)?.username).filter(Boolean) });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('One-to-one chat server listening on', PORT);
  console.log('Open http://localhost:'+PORT+'/ in your browser');
});
