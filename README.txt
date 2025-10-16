Haliport One-to-One v2 (No DB) — direct chat via URL path, username = IP

How it works
------------
- The room is the URL path. Example:
    https://YOUR.onrender.com/project-omega   -> room "project-omega"
    https://YOUR.onrender.com/                -> room "chat"
- No join screen. Connects automatically when you open the link.
- Each room allows exactly TWO people.
- Your "name" shown in presence is your IP (from X-Forwarded-For / remoteAddress).

Run locally
-----------
npm install
npm start
Open http://localhost:3000/alpha in two browsers to test

Deploy on Render
----------------
- New → Web Service → connect repo
- Build Command: npm install
- Start Command: npm start
- Enable WebSockets: ON
- No environment variables needed
