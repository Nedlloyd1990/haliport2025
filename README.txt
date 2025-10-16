
Haliport • One-to-one Messenger (Render + MongoDB Atlas)

Files:
- package.json  -> node scripts + dependencies
- server.js      -> Express + WebSocket (ws) + MongoDB + JWT login
- login.html     -> username -> POST /login -> token -> redirect to index
- index.html     -> WhatsApp-like UI; connects to same-origin WebSocket

Local run (dev):
1) Install Node 18+
2) In one terminal:
   set MONGODB_URI=mongodb://127.0.0.1:27017/haliport
   set JWT_SECRET=dev-change-me
   npm install
   npm start
3) Open http://localhost:3000/login.html

Deploy (Render):
- Create a Web Service from this folder/repo.
- Enable WebSockets.
- Env vars:
    MONGODB_URI = your Atlas URI
    JWT_SECRET = long random string
    (PORT provided by Render automatically)
- Visit /login.html
