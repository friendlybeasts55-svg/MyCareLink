# CareLink

This is a Node.js server app. It CANNOT run on Netlify, which only hosts static files and shows "Page not found".
Use a host that runs Node: Render, Railway, or Fly.io.

## Run on your computer
1. Install Node.js (nodejs.org)
2. In this folder run: npm start
3. Open http://localhost:3000 (the first run prints the admin login)

## Deploy on Render
1. Put these files on GitHub (a new repository, files at the top level).
2. On render.com choose New > Blueprint and select the repository. It reads render.yaml.
3. Fill in BASE_URL (your Render address), ADMIN_EMAIL and ADMIN_PASSWORD when asked.
4. Open your Render address. Sign in as the admin to approve doctors.
