import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(__dirname)); // serves index.html, /uploads/*, etc.

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// ---- Utils ----
function uid() { return (Date.now().toString(36) + Math.random().toString(36).slice(2,8)); }
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
  } catch { return 'chat'; }
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

// ---- Multer (25 MB per file) ----
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-()+\s]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ---- Rooms & Message Registry ----
const rooms = new Map();            // roomId -> Set(ws)
const meta  = new Map();            // ws -> {room, username}
const registry = new Map();         // msgId -> {id, room, type, owner, filePath?}

// Serve index for any GET (room = path)
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- WebSockets ----
wss.on('connection', (ws, req) => {
  const room = roomFromReq(req);
  const username = getClientIP(req);

  const set = rooms.get(room) || new Set();
  if (set.size >= 2) {
    ws.send(JSON.stringify({ type:'room_full', message:'This private room already has two people.' }));
    ws.close(4001, 'room full');
    return;
  }

  set.add(ws);
  rooms.set(room, set);
  meta.set(ws, { room, username });

  ws.send(JSON.stringify({ type:'welcome', room, yourName: username, users: listUsers(room) }));
  broadcast(room, { type:'presence', users: listUsers(room) });

  ws.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf); } catch { return; }

    // ---- Send text message ----
    if (data.type === 'chat') {
      const id = uid();
      const text = String(data.text || '').slice(0, 4000);
      const msg = { type:'chat', id, from: username, text, ts: Date.now() };
      registry.set(id, { id, room, type:'chat', owner: username });
      broadcast(room, msg);
      return;
    }

    // ---- Recall (delete) message/attachment ----
    if (data.type === 'recall' && data.id) {
      const entry = registry.get(String(data.id));
      if (!entry || entry.room !== room) return;

      // Only owner can recall
      if (entry.owner !== username) {
        ws.send(JSON.stringify({ type:'error', message:'Only the sender can recall this item.' }));
        return;
      }

      // If it’s a file, delete it
      if (entry.type === 'file' && entry.filePath) {
        try { fs.unlinkSync(entry.filePath); } catch {}
      }

      registry.delete(entry.id);
      broadcast(room, { type:'recalled', id: entry.id });
      return;
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

// ---- Uploads HTTP endpoint ----
app.post('/upload/:room', upload.array('file', 5), (req, res) => {
  const room = (req.params.room || '').trim() || 'chat';
  const set = rooms.get(room);
  if (!set || set.size === 0 || set.size > 2) {
    return res.status(400).json({ ok:false, error:'Room not active or full' });
  }
  const from = getClientIP(req);

  const files = (req.files || []).map(f => {
    const id = uid();
    const rec = {
      id,
      room,
      type: 'file',
      owner: from,
      filePath: f.path
    };
    registry.set(id, rec);

    const payload = {
      type: 'file',
      id,
      from,
      ts: Date.now(),
      file: {
        name: f.originalname,
        savedAs: path.basename(f.path),
        size: f.size,
        mime: f.mimetype,
        url: `/uploads/${path.basename(f.path)}`
      }
    };
    broadcast(room, payload);
    return payload.file;
  });

  res.json({ ok:true, files });
});

app.use('/uploads', express.static(uploadDir));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('1:1 chat with recall & file transfer listening on', PORT);
  console.log('Open http://localhost:'+PORT+'/your-room');
});
