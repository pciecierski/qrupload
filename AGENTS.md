# AGENTS.md

## Cursor Cloud specific instructions

**QRupload** is a single Node.js/Express web application (`server.js`) that generates unique upload links with QR codes for mobile photo uploads. There is no build step, no test framework, and no linter configured in the repository.

### Running the app

```bash
npm start        # or: node server.js
```

The server listens on port 3000 by default (override with `PORT` env var). Without `DATABASE_URL`, the app uses local file storage (`data.json` + `uploads/`), which is fully functional for development. Setting `DATABASE_URL` to a PostgreSQL connection string switches to Postgres-backed storage.

### Key caveats

- There are **no automated tests** and **no lint configuration** in this repo. The only way to verify changes is manual testing.
- The app is a single file (`server.js`) with server-side rendered HTML — no frontend build pipeline.
- The `data.json` file is the local dev database; deleting it resets all links and photo metadata. The `uploads/` directory stores actual image files in file-storage mode.
- QR code images are loaded client-side from `https://api.qrserver.com` — they require internet access from the browser but not from the server.
