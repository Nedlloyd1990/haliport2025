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
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// ---------- Dirs ----------
const uploadDir = path.join(__dirname, 'uploads');
const vaultDir  = path.join(__dirname, 'vault');
for (const d of [uploadDir, vaultDir]) if (!fs.existsSync(d)) fs.mkdirSync(d);

// ---------- Utils ----------
const uid    = () => (Date.now().toString(36) + Math.random().toString(36).slice(2,8));
const now    = () => Date.now();
const clamp  = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
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
    const u = new URL(typeof reqOrUrlString === 'string' ? reqOrUrlString : (reqOrUrlString.url || ''), 'http://x');
    const q = (u.searchParams.get('room') || '').trim();
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
const roomsWS  = new Map();  // room -> Set(ws)
const metaWS   = new Map();  // ws -> { room, ip, clientId }
const sseRooms = new Map();  // room -> Set(res)
const reg      = new Map();  // id -> item

// Polling event buffer: room -> { nextSeq:number, events: Array<{seq:number, data:any}> }
const roomBuffers = new Map();
function roomBuf(room){
  let b = roomBuffers.get(room);
  if (!b) { b = { nextSeq: 1, events: [] }; roomBuffers.set(room, b); }
  return b;
}
function pushEvent(room, payload){
  // WS + SSE broadcast
  const s = JSON.stringify(payload);

  const set = roomsWS.get(room);
  if (set) for (const ws of set) { try { ws.send(s); } catch {} }

  const sseSet = sseRooms.get(room);
  if (sseSet) for (const res of sseSet) { try { res.write(`data: ${s}\n\n`); } catch {} }

  // Polling buffer
  const buf = roomBuf(room);
  buf.events.push({ seq: buf.nextSeq++, data: payload });
  // trim old
  if (buf.events.length > 1000) buf.events.splice(0, buf.events.length - 1000);
}
function broadcast(room, payload){ pushEvent(room, payload); }
function sendTo(room, predicate, payload){
  const s = JSON.stringify(payload);

  // WS targeted
  const set = roomsWS.get(room);
  if (set) {
    for (const ws of set) {
      const m = metaWS.get(ws);
      if (m && predicate(m)) { try { ws.send(s); } catch {} }
    }
  }

  // SSE broadcast (no identity filtering)
  const sseSet = sseRooms.get(room);
  if (sseSet) for (const res of sseSet) { try { res.write(`data: ${s}\n\n`); } catch {} }

  // Polling: just push; clients decide what to do
  pushEvent(room, payload);
}

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok:true }));

// ---------- Static / public ----------
app.use('/uploads', express.static(uploadDir));

// ---------- Viewer helpers ----------
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

// ---------- Upload ----------
app.post('/upload/:room', upload.array('file', 5), (req, res) => {
  const room = (req.params.room || '').trim() || 'chat';

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

// ---------- Unlock ----------
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
  broadcast(item.room, { type:'file_unlocked', id, url:`/recvfile/${id}` });
  return res.json({ ok:true });
});

// ---------- SSE (fallback) ----------
app.get('/sse', (req, res) => {
  const room = getRoom(req);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const set = sseRooms.get(room) || new Set();
  sseRooms.set(room, set);
  set.add(res);

  res.write(`data: ${JSON.stringify({ type:'welcome', room, yourId:null, users: [] })}\n\n`);

  // keep alive
  const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(ka);
    set.delete(res);
    if (set.size === 0) sseRooms.delete(room);
  });
});

// ---------- Polling (last-resort transport) ----------
app.get('/poll', (req, res) => {
  const room = getRoom(req);
  const after = parseInt(String(req.query.after ?? '0'), 10) || 0;
  const buf = roomBuf(room);
  const events = buf.events.filter(e => e.seq > after);
  res.json({ ok:true, events, next: buf.nextSeq });
});

// Used by polling transport to send events
app.post('/push', (req, res) => {
  const { room, type } = req.body || {};
  if (!room || !type) return res.status(400).json({ ok:false, error:'Missing room/type' });

  if (type === 'chat') {
    const { fromId, text } = req.body;
    const id = uid(); const ts = now();
    reg.set(id, { id, room, type:'chat', ownerIP:'poll', ownerId: fromId || null, ts, text: String(text||'').slice(0,4000), recalled:false });
    broadcast(room, { type:'chat', id, fromId: fromId || null, text: String(text||''), ts });
    return res.json({ ok:true });
  }
  if (type === 'recall') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    performRecall(String(id));
    return res.json({ ok:true });
  }
  return res.status(400).json({ ok:false, error:'Unsupported type' });
});

// ---------- App ----------
app.get('/health', (_req,res)=>res.json({ok:true}));
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

  broadcast(item.room, { type:'recalled', id, sys:'This item was recalled by the sender.' });
  const ownerNote = { type:'recalled_owner', id, sys:'You recalled this. The other person can no longer see it.' };
  if (item.type === 'file' && item.privatePath) ownerNote.newUrl = `/myfile/${id}`;
  broadcast(item.room, ownerNote);
}
function scheduleAutoRecall(item){
  if (!item.expiresAt) return;
  const delay = clamp(item.expiresAt - now(), 0, 2147483647);
  item.timer = setTimeout(() => performRecall(item.id), delay);
}

// ---------- Server + WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const room = getRoom(req.url);
  const ip = getClientIP(req);
  const clientId = uid();

  const set = roomsWS.get(room) || new Set();
  if (set.size >= 2) {
    ws.send(JSON.stringify({ type:'room_full', message:'This private room already has two people.' }));
    ws.close(4001, 'room full');
    return;
  }
  set.add(ws);
  roomsWS.set(room, set);
  metaWS.set(ws, { room, ip, clientId });

  console.log(`[WS] connected room=${room} id=${clientId} ip=${ip} size=${set.size}`);
  ws.send(JSON.stringify({ type:'welcome', room, yourId: clientId, users: [...set].map(sock => metaWS.get(sock)?.clientId) }));
  const users = [...set].map(sock => metaWS.get(sock)?.clientId);
  for (const sock of set) { try { sock.send(JSON.stringify({ type:'presence', users })); } catch {} }

  ws.on('message', (buf) => {
    let data; try { data = JSON.parse(buf); } catch { return; }
    const m = metaWS.get(ws); if (!m) return;

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
    metaWS.delete(ws);
    const s = roomsWS.get(room);
    if (s) {
      s.delete(ws);
      if (s.size === 0) roomsWS.delete(room);
      else {
        const users = [...s].map(sock => metaWS.get(sock)?.clientId);
        for (const sock of s) { try { sock.send(JSON.stringify({ type:'presence', users })); } catch {} }
      }
    }
    console.log(`[WS] closed room=${room} id=${clientId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Listening on http://localhost:'+PORT);
  console.log('WebSocket:  ws://localhost:'+PORT+'/ws?room=<room>');
  console.log('SSE:        GET  /sse?room=<room>');
  console.log('Polling:    GET  /poll?room=<room>&after=<seq>');
});
