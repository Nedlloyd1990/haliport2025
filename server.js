import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ---------- Dirs ----------
const uploadDir = path.join(__dirname, 'uploads');
const vaultDir  = path.join(__dirname, 'vault');
for (const d of [uploadDir, vaultDir]) if (!fs.existsSync(d)) fs.mkdirSync(d);

// ---------- Utils ----------
const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2,8));
const now = () => Date.now();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function getClientIP(req) {
  const xf = req.headers['x-forwarded-for'];
  let ip = Array.isArray(xf) ? xf[0] : (xf || req.socket?.remoteAddress || '');
  if (typeof ip !== 'string') ip = String(ip || '');
  ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:','');
  return ip || 'unknown';
}
function getRoom(reqOrUrlString) {
  try {
    // Works for both HTTP requests and raw URL strings from the WS upgrade
    const u = new URL(typeof reqOrUrlString === 'string' ? reqOrUrlString : (reqOrUrlString.url || ''), 'http://x');
    const q = (u.searchParams.get('room') || '').trim();
    // fallback: take path segment (but we prefer ?room=)
    const p = u.pathname.replace(/^\/+|\/+$/g,'');
    return q || p || 'chat';
  } catch { return 'chat'; }
}

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const toVault = (req.body?.pw && String(req.body.pw).trim().length > 0);
    cb(null, toVault ? vaultDir : uploadDir);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-()+\s]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- State ----------
/**
 * reg item:
 * { id, room, type:'chat'|'file', ownerIP, ownerId, ts,
 *   text?,
 *   file?: { name,savedAs,size,mime },
 *   filePath?: string | null,   // public (uploads)
 *   privatePath?: string | null,// vault
 *   recalled:false,
 *   expiresAt?: number, timer?: Timeout,
 *   protected?: boolean, salt?: string, pwHash?: string,
 *   unlockedForIP?: string | null
 * }
 */
const rooms = new Map(); // room -> Set(ws)
const meta  = new Map(); // ws -> {room, ip, clientId}
const reg   = new Map(); // id -> item

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok:true }));

// ---------- Static / API (before catch-all) ----------
app.use('/uploads', express.static(uploadDir));

app.get('/myfile/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.privatePath) return res.status(404).end();
  const ip = getClientIP(req);
  if (ip !== item.ownerIP) return res.status(403).send('Forbidden');
  res.sendFile(path.resolve(item.privatePath));
});

app.get('/recvfile/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.privatePath) return res.status(404).end();
  const ip = getClientIP(req);
  if (ip !== item.unlockedForIP) return res.status(403).send('Forbidden');
  res.sendFile(path.resolve(item.privatePath));
});

app.get('/fileurl/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file') return res.status(404).json({ ok:false, error:'Not found' });
  const ip = getClientIP(req);

  if (ip === item.ownerIP && item.privatePath) {
    return res.json({ ok:true, id, name:item.file.name, mime:item.file.mime, url:`/myfile/${id}` });
  }
  if (!item.protected && !item.recalled && item.filePath) {
    return res.json({ ok:true, id, name:item.file.name, mime:item.file.mime, url:`/uploads/${path.basename(item.filePath)}` });
  }
  if (item.protected && item.unlockedForIP && ip === item.unlockedForIP && item.privatePath) {
    return res.json({ ok:true, id, name:item.file.name, mime:item.file.mime, url:`/recvfile/${id}` });
  }
  return res.status(403).json({ ok:false, error:'Not accessible' });
});

app.post('/upload/:room', upload.array('file', 5), (req, res) => {
  const room = (req.params.room || '').trim() || 'chat';
  const set = rooms.get(room);
  if (!set || set.size === 0 || set.size > 2) {
    return res.status(400).json({ ok:false, error:'Room not active or full' });
  }
  const ownerIP = getClientIP(req);
  const ownerId = (req.body?.clientId && String(req.body.clientId)) || null;

  const ttlSec = clamp(parseInt((req.body?.ttl ?? '0'), 10) || 0, 0, 31*24*3600);
  const pwRaw  = (req.body?.pw && String(req.body.pw).trim()) || '';

  (req.files || []).forEach(f => {
    const id = uid();
    const ts = now();
    const record = {
      id, room, type:'file', ownerIP, ownerId, ts,
      file: { name: f.originalname, savedAs: path.basename(f.filename || f.path), size: f.size, mime: f.mimetype },
      filePath: pwRaw ? null : f.path,
      privatePath: pwRaw ? f.path : null,
      recalled:false,
      protected: !!pwRaw,
      salt:null, pwHash:null,
      unlockedForIP:null
    };
    if (pwRaw) { record.salt = uid(); record.pwHash = sha256(record.salt + '|' + pwRaw); }
    if (ttlSec > 0) { record.expiresAt = ts + ttlSec*1000; scheduleAutoRecall(record); }
    reg.set(id, record);

    const payload = {
      type:'file', id, fromId: ownerId, ts,
      file: {
        name: record.file.name, savedAs: record.file.savedAs, size: record.file.size, mime: record.file.mime,
        url: pwRaw ? null : `/uploads/${path.basename(record.filePath)}`,
        protected: !!pwRaw
      }
    };
    if (record.expiresAt) payload.expiresAt = record.expiresAt;

    broadcast(room, payload);

    const ownerAug = { type:'file_owner', id };
    if (record.privatePath) ownerAug.ownerUrl = `/myfile/${id}`;
    sendTo(room, (m) => m.clientId === ownerId, ownerAug);
  });

  res.json({ ok:true });
});

app.post('/unlock/:id', (req, res) => {
  const id = String(req.params.id || '');
  const pwd = (req.body?.password && String(req.body.password)) || '';
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.protected || item.recalled) {
    return res.status(400).json({ ok:false, error:'Invalid item' });
  }
  const ip = getClientIP(req);
  if (ip === item.ownerIP) return res.status(403).json({ ok:false, error:'Owner does not need to unlock' });

  const ok = (sha256(item.salt + '|' + pwd) === item.pwHash);
  if (!ok) {
    performRecall(id);
    return res.status(403).json({ ok:false, error:'Incorrect password. File was recalled.' });
  }
  item.unlockedForIP = ip;
  sendTo(item.room, (m) => m.ip === ip, { type:'file_unlocked', id, url:`/recvfile/${id}` });
  return res.json({ ok:true });
});

// ---------- Catch-all (serve app) ----------
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- Recall helpers ----------
function moveFileToVault(item){
  if (item.type !== 'file' || item.privatePath || !item.filePath) return;
  try {
    const dest = path.join(vaultDir, path.basename(item.filePath));
    fs.renameSync(item.filePath, dest);
    item.privatePath = dest; item.filePath = null;
  } catch {
    try { fs.unlinkSync(item.filePath); } catch {}
    item.privatePath = null; item.filePath = null;
  }
}
function performRecall(id){
  const item = reg.get(id);
  if (!item || item.recalled) return;
  item.recalled = true;
  if (item.timer) { clearTimeout(item.timer); item.timer = undefined; }
  if (item.type === 'file') moveFileToVault(item);
  item.unlockedForIP = null;

  sendTo(item.room, (m) => m.clientId !== item.ownerId, { type:'recalled', id, sys:'This item was recalled by the sender.' });
  const ownerNote = { type:'recalled_owner', id, sys:'You recalled this. The other person can no longer see it.' };
  if (item.type === 'file' && item.privatePath) ownerNote.newUrl = `/myfile/${id}`;
  sendTo(item.room, (m) => m.clientId === item.ownerId, ownerNote);
}
function scheduleAutoRecall(item){
  if (!item.expiresAt) return;
  const delay = clamp(item.expiresAt - now(), 0, 2147483647);
  item.timer = setTimeout(() => performRecall(item.id), delay);
}

// ---------- Server + WebSocket at /ws ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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

wss.on('connection', (ws, req) => {
  const room = getRoom(req.url);
  const ip = getClientIP(req);
  const clientId = uid();

  const set = rooms.get(room) || new Set();
  if (set.size >= 2) {
    ws.send(JSON.stringify({ type:'room_full', message:'This private room already has two people.' }));
    ws.close(4001, 'room full');
    return;
  }
  set.add(ws);
  rooms.set(room, set);
  meta.set(ws, { room, ip, clientId });

  console.log(`[WS] connected room=${room} id=${clientId} ip=${ip} size=${set.size}`);
  ws.send(JSON.stringify({ type:'welcome', room, yourId: clientId, users: [...set].map(sock => meta.get(sock)?.clientId) }));
  broadcast(room, { type:'presence', users: [...set].map(sock => meta.get(sock)?.clientId) });

  ws.on('message', (buf) => {
    let data; try { data = JSON.parse(buf); } catch { return; }
    const m = meta.get(ws); if (!m) return;

    if (data.type === 'chat') {
      const id = uid(); const ts = now();
      reg.set(id, { id, room, type:'chat', ownerIP: m.ip, ownerId: m.clientId, ts, text: String(data.text||'').slice(0,4000), recalled:false });
      broadcast(room, { type:'chat', id, fromId: m.clientId, text: String(data.text||''), ts });
      return;
    }
    if (data.type === 'recall' && data.id) {
      const item = reg.get(String(data.id));
      if (!item || item.room !== room) return;
      if (item.ownerId !== m.clientId) { ws.send(JSON.stringify({ type:'error', message:'Only the sender can recall this item.' })); return; }
      performRecall(item.id); return;
    }
  });

  ws.on('close', () => {
    meta.delete(ws);
    const s = rooms.get(room);
    if (s) {
      s.delete(ws);
      if (s.size === 0) rooms.delete(room);
      else broadcast(room, { type:'presence', users: [...s].map(sock => meta.get(sock)?.clientId) });
    }
    console.log(`[WS] closed room=${room} id=${clientId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Listening on http://localhost:'+PORT);
  console.log('Open two tabs like: http://localhost:'+PORT+'/my-room');
  console.log('Sockets at /ws?room=<room>');
});
