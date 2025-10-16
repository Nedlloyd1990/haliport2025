
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';

// ====== Config ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/haliport';

// ====== DB ======
await mongoose.connect(MONGODB_URI, { dbName: 'haliport' });

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ====== App / HTTP ======
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html + login.html by default

// Simple login endpoint: upsert user and return a JWT
app.post('/login', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'username required' });
    }
    const uname = username.trim();
    await User.updateOne({ username: uname }, { $setOnInsert: { username: uname } }, { upsert: true });
    const token = jwt.sign({ username: uname }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: uname });
  } catch (e) {
    console.error('Login error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

const server = http.createServer(app);

// ====== WebSocket ======
const wss = new WebSocketServer({ server });

// In-memory presence (for demo). In production you’d persist.
const clients = new Map(); // ws -> { username }
function broadcastUserList() {
  const list = [...clients.values()].map(c => c.username);
  // Build [{username, online:true}]
  const payload = {
    type: 'userList',
    users: list.map(u => ({ username: u, online: true }))
  };
  for (const ws of clients.keys()) {
    safeSend(ws, payload);
  }
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

wss.on('connection', (ws) => {
  // client should immediately send {type:'auth', username}
  ws.on('message', async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.type === 'auth') {
      const { username } = data;
      if (!username) return;
      // Optional: verify JWT if you pass it (not required for demo)
      clients.set(ws, { username });
      broadcastUserList();
      return;
    }

    // Relay helpers
    const relay = (predicate, payloadBuilder) => {
      for (const [client, meta] of clients.entries()) {
        if (predicate(meta)) {
          safeSend(client, payloadBuilder(meta));
        }
      }
    };

    // Request connection
    if (data.type === 'requestConnection') {
      const from = clients.get(ws)?.username;
      if (!from) return;
      const target = data.target;
      relay(m => m.username === target, () => ({ type:'connectionRequest', from }));
      return;
    }

    // Connection response
    if (data.type === 'connectionResponse') {
      const from = clients.get(ws)?.username;
      if (!from) return;
      const target = data.target;
      relay(m => m.username === target, () => ({ type:'connectionResponse', from, accept: !!data.accept }));
      return;
    }

    // Text chat
    if (data.type === 'chat') {
      const from = clients.get(ws)?.username;
      if (!from) return;
      const { target, text } = data;
      relay(m => m.username === target, () => ({ type:'chat', from, text }));
      return;
    }

    // File meta transfer (demo relays metadata only)
    if (data.type === 'fileTransfer') {
      const from = clients.get(ws)?.username;
      if (!from) return;
      const { target, fileName, fileType, fileSize, fileId } = data;
      relay(m => m.username === target, () => ({ type:'fileTransfer', from, fileName, fileType, fileSize, fileId }));
      return;
    }

    // File downloaded ack
    if (data.type === 'fileDownloaded') {
      const from = clients.get(ws)?.username;
      if (!from) return;
      const { target, fileId } = data;
      relay(m => m.username === target, () => ({ type:'fileDownloaded', fileId, downloadedTime: new Date().toISOString() }));
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastUserList();
  });
});

server.listen(PORT, () => {
  console.log('Haliport server listening on', PORT);
});
