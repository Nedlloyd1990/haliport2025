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
app.use(cors());
app.use(express.json());            // for /unlock and JSON endpoints
app.use(express.static(__dirname)); // serves index.html

// ---------- Dirs ----------
const uploadDir = path.join(__dirname, 'uploads'); // public before recall (non-protected)
const vaultDir  = path.join(__dirname, 'vault');   // private (owner-only & protected files)
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
function sha256(s){ return crypto.createHash('sha256').update(s).digest('hex'); }

// ---------- Multer (25 MB) ----------
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

// ---------- Rooms & Registry ----------
/**
 * reg item:
 * { id, room, type:'chat'|'file', owner, ts,
 *   text?,
 *   file?: { name,savedAs,size,mime },
 *   filePath?: string | null,   // public (uploads)
 *   privatePath?: string | null,// vault
 *   recalled:false,
 *   expiresAt?: number,
 *   timer?: Timeout,
 *   protected?: boolean,
 *   salt?: string,
 *   pwHash?: string,
 *   unlockedFor?: string | null // receiver IP after correct password
 * }
 */
const rooms = new Map(); // room -> Set(ws)
const meta  = new Map(); // ws -> {room, username}
const reg   = new Map(); // id -> item

// Serve index for any GET (room = path)
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Static serving for /uploads (public pre-recall)
app.use('/uploads', express.static(uploadDir));

// Owner-only file (inline view/download allowed)
app.get('/myfile/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.privatePath) return res.status(404).end();
  const ip = getClientIP(req);
  if (ip !== item.owner) return res.status(403).send('Forbidden');
  res.sendFile(path.resolve(item.privatePath)); // inline by default
});

// Receiver-only after unlock
app.get('/recvfile/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.privatePath) return res.status(404).end();
  const ip = getClientIP(req);
  if (ip !== item.unlockedFor) return res.status(403).send('Forbidden');
  res.sendFile(path.resolve(item.privatePath)); // inline by default
});

// --------- Unified "what URL can I view?" helper (for the viewer) ---------
/**
 * Returns the best accessible URL and mime for the requester.
 * - Unprotected & not recalled: /uploads/<name>
 * - Protected & unlocked (receiver): /recvfile/:id
 * - Owner (any time, including recalled): /myfile/:id
 * - Otherwise: 403
 */
app.get('/fileurl/:id', (req, res) => {
  const id = String(req.params.id || '');
  const item = reg.get(id);
  if (!item || item.type !== 'file') return res.status(404).json({ ok:false, error:'Not found' });
  const ip = getClientIP(req);

  // Owner always can view (kept in vault after recall)
  if (ip === item.owner && item.privatePath) {
    return res.json({ ok:true, id, name: item.file.name, mime: item.file.mime, url: `/myfile/${id}` });
  }

  // If not protected, not recalled, still publicly served
  if (!item.protected && !item.recalled && item.filePath) {
    return res.json({ ok:true, id, name: item.file.name, mime: item.file.mime, url: `/uploads/${path.basename(item.filePath)}` });
  }

  // Protected and unlocked for this ip
  if (item.protected && item.unlockedFor && ip === item.unlockedFor && item.privatePath) {
    return res.json({ ok:true, id, name: item.file.name, mime: item.file.mime, url: `/recvfile/${id}` });
  }

  return res.status(403).json({ ok:false, error:'Not accessible' });
});

// ---------- Recall helpers ----------
function moveFileToVault(item){
  if (item.type !== 'file') return;
  if (item.privatePath) return;
  if (!item.filePath) return;
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
function performRecall(id){
  const item = reg.get(id);
  if (!item || item.recalled) return;
  item.recalled = true;
  if (item.timer) { clearTimeout(item.timer); item.timer = undefined; }
  if (item.type === 'file') moveFileToVault(item);
  item.unlockedFor = null;

  sendTo(item.room, (m) => m.username !== item.owner, {
    type: 'recalled',
    id,
    sys: 'This item was recalled by the sender.'
  });
  const ownerNote = { type: 'recalled_owner', id, sys: 'You recalled this. The other person can no longer see it.' };
  if (item.type === 'file' && item.privatePath) ownerNote.newUrl = `/myfile/${id}`;
  sendTo(item.room, (m) => m.username === item.owner, ownerNote);
}
function scheduleAutoRecall(item){
  if (!item.expiresAt) return;
  const delay = clamp(item.expiresAt - now(), 0, 2147483647);
  item.timer = setTimeout(() => performRecall(item.id), delay);
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

    if (data.type === 'chat') {
      const id = uid();
      const text = String(data.text || '').slice(0, 4000);
      const ts = now();
      reg.set(id, { id, room, type:'chat', owner: username, ts, text, recalled:false });
      broadcast(room, { type:'chat', id, from: username, text, ts });
      return;
    }

    if (data.type === 'recall' && data.id) {
      const id = String(data.id);
      const item = reg.get(id);
      if (!item || item.room !== room) return;
      if (item.owner !== username) {
        ws.send(JSON.stringify({ type:'error', message:'Only the sender can recall this item.' }));
        return;
      }
      performRecall(id);
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

// ---------- Upload (TTL + optional password) ----------
app.post('/upload/:room', upload.array('file', 5), (req, res) => {
  const room = (req.params.room || '').trim() || 'chat';
  const set = rooms.get(room);
  if (!set || set.size === 0 || set.size > 2) {
    return res.status(400).json({ ok:false, error:'Room not active or full' });
  }
  const from = getClientIP(req);

  const ttlSec  = clamp(parseInt((req.body?.ttl ?? '0'), 10) || 0, 0, 31*24*3600);
  const pwRaw   = (req.body?.pw && String(req.body.pw).trim()) || '';

  const files = (req.files || []).map(f => {
    const id = uid();
    const ts = now();

    const record = {
      id, room, type:'file', owner: from, ts,
      file: { name: f.originalname, savedAs: path.basename(f.filename || f.path), size: f.size, mime: f.mimetype },
      filePath: pwRaw ? null : f.path,
      privatePath: pwRaw ? f.path : null,
      recalled:false,
      protected: !!pwRaw,
      salt: null, pwHash: null,
      unlockedFor: null
    };

    if (pwRaw) {
      record.salt = uid();
      record.pwHash = sha256(record.salt + '|' + pwRaw);
    }
    if (ttlSec > 0) {
      record.expiresAt = ts + (ttlSec * 1000);
      scheduleAutoRecall(record);
    }

    reg.set(id, record);

    const basePayload = {
      type:'file', id, from, ts,
      file: {
        name: record.file.name,
        savedAs: record.file.savedAs,
        size: record.file.size,
        mime: record.file.mime,
        url: pwRaw ? null : `/uploads/${path.basename(record.filePath)}`,
        protected: !!pwRaw
      }
    };
    if (record.expiresAt) basePayload.expiresAt = record.expiresAt;

    broadcast(room, basePayload);

    // Owner augmentation (direct link if protected, or any time post-recall)
    const ownerAug = { type:'file_owner', id };
    if (record.privatePath) ownerAug.ownerUrl = `/myfile/${id}`;
    sendTo(room, (m) => m.username === from, ownerAug);

    return basePayload.file;
  });

  res.json({ ok:true, files });
});

// ---------- Unlock (receiver) ----------
app.post('/unlock/:id', (req, res) => {
  const id = String(req.params.id || '');
  const pwd = (req.body?.password && String(req.body.password)) || '';
  const item = reg.get(id);
  if (!item || item.type !== 'file' || !item.protected || item.recalled) {
    return res.status(400).json({ ok:false, error:'Invalid item' });
  }
  const ip = getClientIP(req);
  if (ip === item.owner) return res.status(403).json({ ok:false, error:'Owner does not need to unlock' });

  const ok = (crypto.createHash('sha256').update(item.salt + '|' + pwd).digest('hex') === item.pwHash);
  if (!ok) {
    performRecall(id); // wrong password => recall
    return res.status(403).json({ ok:false, error:'Incorrect password. File was recalled.' });
  }

  item.unlockedFor = ip;
  sendTo(item.room, (m) => m.username === ip, { type: 'file_unlocked', id, url: `/recvfile/${id}` });
  return res.json({ ok:true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('1:1 chat with inline viewer, recall, auto-recall, and password-protect is listening on', PORT);
  console.log('Open http://localhost:'+PORT+'/your-room');
});
