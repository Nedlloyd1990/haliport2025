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
app.use(express.static(__dirname)); // serves index.html

// ---------- Dirs ----------
const uploadDir = path.join(__dirname, 'uploads'); // public before recall
const vaultDir  = path.join(__dirname, 'vault');   // private after recall (owner-only)
for (const d of [uploadDir, vaultDir]) if (!fs.existsSync(d)) fs.mkdirSync(d);

// ---------- Utils ----------
function uid(){ return (Date.now().toString(36) + Math.random().toString(36).slice(2,8)); }
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
function broadcast(room, payload){
  const set = rooms.get(room);
  if (!set) return;
  const s = JSON.stringify(payload);
  for (const ws of set) { try { ws.send(s); } catch {} }
}
function sendTo(room, predicate, payload){
  const set = rooms.get(room);
  if (!set) return;
  const s = JSON.stringify(payload);
  for (const ws of set) {
    const m = meta.get(ws);
    if (m && predicate(m)) { try { ws.send(s); } catch {} }
  }
}

// ---------- Multer (25 MB) ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-()+\s]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- Rooms & Registry ----------
const rooms = new Map(); // room -> Set(ws)
const meta  = new Map(); // ws -> {room, username}
const reg   = new Map(); // id -> { id, room, type, owner, ts, text?, file?, filePath?, privatePath?, recalled:false, expireAt?:number }
const timers = new Map(); // id -> timeout

// Serve index for any GET (room = path)
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Public files before recall
app.use('/uploads', express.static(uploadDir));

// Gated serving for owner-only files after recall
app.get('/myfile/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.privatePath) return res.status(404).end();
  const ip = getClientIP(req);
  if (ip !== item.owner) return res.status(403).send('Forbidden');
  res.sendFile(path.resolve(item.privatePath));
});

// ---------- Core recall helper ----------
function performRecall(item, note = 'This item was recalled by the sender.') {
  if (!item || item.recalled) return;

  // If file: move to vault and kill public URL
  if (item.type === 'file' && item.filePath && !item.privatePath) {
    try {
      const dest = path.join(vaultDir, path.basename(item.filePath));
      fs.renameSync(item.filePath, dest);
      item.privatePath = dest;
      item.filePath = null;
    } catch {
      try { fs.unlinkSync(item.filePath); } catch {}
      item.privatePath = null;
      item.filePath = null;
    }
  }

  item.recalled = true;
  // clear timer if any
  const t = timers.get(item.id);
  if (t) { clearTimeout(t); timers.delete(item.id); }

  // Receiver view: tombstone + system line; hide original
  sendTo(item.room, (m) => m.username !== item.owner, {
    type: 'recalled',
    id: item.id,
    sys: note
  });

  // Sender view: keep original, add system line; if file, update to gated URL
  const ownerNote = { type: 'recalled_owner', id: item.id, sys: 'You recalled this. The other person can no longer see it.' };
  if (item.type === 'file' && item.privatePath) {
    ownerNote.newUrl = `/myfile/${item.id}`;
  }
  sendTo(item.room, (m) => m.username === item.owner, ownerNote);
}

// ---------- WebSockets ----------
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

    // ---- chat ----
    if (data.type === 'chat') {
      const id = uid();
      const text = String(data.text || '').slice(0, 4000);
      const ts = Date.now();
      reg.set(id, { id, room, type:'chat', owner: username, ts, text, recalled:false });
      broadcast(room, { type:'chat', id, from: username, text, ts });
      return;
    }

    // ---- manual recall ----
    if (data.type === 'recall' && data.id) {
      const id = String(data.id);
      const item = reg.get(id);
      if (!item || item.room !== room) return;
      if (item.owner !== username) {
        ws.send(JSON.stringify({ type:'error', message:'Only the sender can recall this item.' }));
        return;
      }
      performRecall(item, 'This item was recalled by the sender.');
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

// ---------- Upload endpoint with auto-recall ----------
app.post('/upload/:room', upload.array('file', 5), (req, res) => {
  const room = (req.params.room || '').trim() || 'chat';
  const set = rooms.get(room);
  if (!set || set.size === 0 || set.size > 2) {
    return res.status(400).json({ ok:false, error:'Room not active or full' });
  }
  const from = getClientIP(req);

  // Multer puts non-file fields into req.body
  // expect optional expireMs (single number for all files in this request)
  let expireMs = 0;
  if (req.body && req.body.expireMs) {
    const n = parseInt(String(req.body.expireMs), 10);
    if (!Number.isNaN(n) && n > 0) expireMs = Math.min(n, 1000 * 60 * 60 * 24 * 365); // clamp to <=1y
  }

  const now = Date.now();

  const files = (req.files || []).map(f => {
    const id = uid();
    const ts = now;
    const record = {
      id, room, type:'file', owner: from, ts,
      file: { name: f.originalname, savedAs: path.basename(f.path), size: f.size, mime: f.mimetype },
      filePath: f.path, privatePath: null, recalled:false
    };
    if (expireMs > 0) record.expireAt = ts + expireMs;
    reg.set(id, record);

    // schedule auto recall if needed
    if (record.expireAt) {
      const delay = Math.max(0, record.expireAt - Date.now());
      const t = setTimeout(() => performRecall(record, 'This item was auto-recalled by the sender.'), delay);
      timers.set(id, t);
    }

    const payload = {
      type:'file', id, from, ts,
      file: {
        name: f.originalname,
        savedAs: path.basename(f.path),
        size: f.size,
        mime: f.mimetype,
        url: `/uploads/${path.basename(f.path)}`
      },
      expireAt: record.expireAt || null
    };
    broadcast(room, payload);
    return payload.file;
  });

  res.json({ ok:true, files, expireAt: expireMs ? now + expireMs : null });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('1:1 chat with uploads, manual & auto recall listening on', PORT);
  console.log('Open http://localhost:'+PORT+'/your-room');
});
