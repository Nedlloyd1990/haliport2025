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
function uid(){ return (Date.now().toString(36) + Math.random().toString(36).slice(2,8)); }
function now(){ return Date.now(); }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
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
function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }

// ---------- Multer (25 MB) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // NEW: if password OR "noDownload" (view-only), store in vault
    const wantVault = (req.body?.pw && String(req.body.pw).trim().length > 0)
                   || (String(req.body?.noDownload || '') === '1'); // NEW
    cb(null, wantVault ? vaultDir : uploadDir);
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
 *   filePath?: string | null,         // public (uploads)
 *   privatePath?: string | null,      // vault
 *   recalled:false,
 *   expiresAt?: number, timer?: Timeout,
 *   protected?: boolean, salt?: string, pwHash?: string,
 *   unlockedForIP?: string | null,
 *   noDownload?: boolean              // NEW
 * }
 */
const rooms = new Map();
const meta  = new Map();
const reg   = new Map();

// ---------- Static / API routes ----------
app.get('/health', (_req, res) => res.json({ ok:true }));

// public uploads (only for not-protected AND downloads-allowed)
app.use('/uploads', express.static(uploadDir));

// owner-only (always inline-capable)
app.get('/myfile/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.privatePath) return res.status(404).end();
  const ip = getClientIP(req);
  if (ip !== item.ownerIP) return res.status(403).send('Forbidden');
  // NEW: force inline
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(item.file.name)}"`);
  res.sendFile(path.resolve(item.privatePath));
});

// receiver-only after unlock OR for view-only first requester
app.get('/recvfile/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.privatePath) return res.status(404).end();
  const ip = getClientIP(req);
  if (ip !== item.unlockedForIP) return res.status(403).send('Forbidden');
  // NEW: force inline
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(item.file.name)}"`);
  res.sendFile(path.resolve(item.privatePath));
});

// resolve best URL for requester (adds view-only flow)
app.get('/fileurl/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file') return res.status(404).json({ ok:false, error:'Not found' });
  const ip = getClientIP(req);

  // Owner can always see inline via vault if private
  if (ip === item.ownerIP && item.privatePath) {
    return res.json({ ok:true, id, name:item.file.name, mime:item.file.mime, url:`/myfile/${id}` });
  }

  // If public (no password, not recalled, downloads allowed), return public URL
  if (!item.protected && !item.recalled && !item.noDownload && item.filePath) { // CHANGED
    return res.json({ ok:true, id, name:item.file.name, mime:item.file.mime, url:`/uploads/${path.basename(item.filePath)}` });
  }

  // View-only (no password, but noDownload=true) — first requester becomes the allowed IP
  if (!item.protected && item.noDownload && !item.recalled && item.privatePath) { // NEW
    if (!item.unlockedForIP) item.unlockedForIP = ip;        // first clicker is the receiver
    if (ip === item.unlockedForIP) {
      return res.json({ ok:true, id, name:item.file.name, mime:item.file.mime, url:`/recvfile/${id}` });
    }
  }

  // Password-protected — only after unlock
  if (item.protected && item.unlockedForIP && ip === item.unlockedForIP && item.privatePath) {
    return res.json({ ok:true, id, name:item.file.name, mime:item.file.mime, url:`/recvfile/${id}` });
  }

  return res.status(403).json({ ok:false, error:'Not accessible' });
});

// upload (ttl + optional password + noDownload; expects clientId)
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
  const noDownload = String(req.body?.noDownload || '') === '1'; // NEW

  (req.files || []).forEach(f => {
    const id = uid();
    const ts = now();
    const record = {
      id, room, type:'file', ownerIP, ownerId, ts,
      file: { name: f.originalname, savedAs: path.basename(f.filename || f.path), size: f.size, mime: f.mimetype },
      // CHANGED: if noDownload, keep in privatePath even without password
      filePath: (!pwRaw && !noDownload) ? f.path : null,
      privatePath: (pwRaw || noDownload) ? f.path : null,
      recalled:false,
      protected: !!pwRaw,
      salt:null, pwHash:null,
      unlockedForIP:null,
      noDownload
    };
    if (pwRaw) { record.salt = uid(); record.pwHash = sha256(record.salt + '|' + pwRaw); }
    if (ttlSec > 0) { record.expiresAt = ts + ttlSec*1000; scheduleAutoRecall(record); }
    reg.set(id, record);

    const payload = {
      type:'file', id, fromId: ownerId, ts,
      file: {
        name: record.file.name, savedAs: record.file.savedAs, size: record.file.size, mime: record.file.mime,
        url: (!record.protected && !record.noDownload && record.filePath) ? `/uploads/${path.basename(record.filePath)}` : null,
        protected: !!pwRaw,
        noDownload: record.noDownload // NEW
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

// unlock (INCORRECT PASSWORD ⇒ recall is ALREADY implemented)
app.post('/unlock/:id', (req, res) => {
  const id = String(req.params.id || '');
  const pwd = (req.body?.password && String(req.body.password)) || '';
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.protected || item.recalled) {
    return res.status(400).json({ ok:false, error:'Invalid item' });
  }
  const ip = getClientIP(req);
  if (ip === item.ownerIP) return res.status(403).json({ ok:false, error:'Owner does not need to unlock' });

  const ok = (crypto.createHash('sha256').update(item.salt + '|' + pwd).digest('hex') === item.pwHash);
  if (!ok) {
    performRecall(id); // ← this is the “recall if incorrect password” behavior you wanted
    return res.status(403).json({ ok:false, error:'Incorrect password. File was recalled.' });
  }
  item.unlockedForIP = ip;
  sendTo(item.room, (m) => m.ip === ip, { type:'file_unlocked', id, url:`/recvfile/${id}` });
  return res.json({ ok:true });
});

// ---------- Catch-all ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

// ---------- WebSockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const room = roomFromReq(req);
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

  console.log(`[WS] connected: room=${room} id=${clientId} ip=${ip} size=${set.size}`);

  ws.send(JSON.stringify({ type:'welcome', room, yourId: clientId, users: [...set].map(sock => meta.get(sock)?.clientId) }));
  broadcast(room, { type:'presence', users: [...set].map(sock => meta.get(sock)?.clientId) });

  ws.on('message', (buf) => {
    let data; try { data = JSON.parse(buf); } catch { return; }
    const m = meta.get(ws); if (!m) return;

    if (data.type === 'chat') {
      const id = uid();
      const text = String(data.text || '').slice(0, 4000);
      const ts = Date.now();
      reg.set(id, { id, room, type:'chat', ownerIP: m.ip, ownerId: m.clientId, ts, text, recalled:false });
      broadcast(room, { type:'chat', id, fromId: m.clientId, text, ts });
      return;
    }

    if (data.type === 'recall' && data.id) {
      const id = String(data.id);
      const item = reg.get(id);
      if (!item || item.room !== room) return;
      if (item.ownerId !== m.clientId) {
        ws.send(JSON.stringify({ type:'error', message:'Only the sender can recall this item.' }));
        return;
      }
      performRecall(id);
      return;
    }
  });

  ws.on('close', () => {
    const m = meta.get(ws);
    meta.delete(ws);
    const s = rooms.get(room);
    if (s) {
      s.delete(ws);
      if (s.size === 0) rooms.delete(room);
      else broadcast(room, { type:'presence', users: [...s].map(sock => meta.get(sock)?.clientId) });
    }
    console.log(`[WS] closed: room=${room} id=${clientId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on http://localhost:'+PORT);
});
