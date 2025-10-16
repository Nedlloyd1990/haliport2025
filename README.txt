
Haliport One-to-One v3 — chat + file send (no DB)

- Room is the URL path (e.g., /alpha).
- Auto-connect. Username is your IP (from X-Forwarded-For / remoteAddress).
- Files are relayed peer-to-peer via WebSocket (no server storage).
- Max file size: 10 MB (tweak MAX_FILE in index.html).
- Two users per room.

Run:
npm install
npm start
Open http://localhost:3000/alpha in two tabs/devices.

Render:
Build: npm install
Start: npm start
Enable WebSockets: ON
