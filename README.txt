
Haliport One-to-One (No DB) — anyone with the URL can join a private room.

How it works
------------
- A "room" is just a name in the URL: https://YOUR.onrender.com/?room=team-47
- Each room allows exactly TWO people.
- No database or login. Everything is in memory; if the server restarts, history is gone.

Files
-----
- package.json  : start script + deps
- server.js     : Express + ws WebSocket room server
- index.html    : UI with name + room + chat

Run locally
-----------
npm install
npm start
Open http://localhost:3000/ and enter a room + your name

Deploy on Render
----------------
- New → Web Service → connect repo
- Build Command: npm install
- Start Command: npm start
- Enable WebSockets: ON
- (No environment variables needed)
- After deploy, share: https://YOUR.onrender.com/?room=ANYTHING
