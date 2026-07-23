# QRupload

A very small Node.js app that creates unique upload links.  
Each link allows mobile users to upload photos from their device camera/gallery.

## Features

- Create a unique URL for uploads
- Mobile-friendly file input (`accept="image/*"` + `capture="environment"`)
- Per-link photo gallery
- Persistent storage layer:
  - Railway-ready PostgreSQL when `DATABASE_URL` is set
  - Local file-backed fallback (`data.json` + `uploads/`) for dev
- Simple Express server, easy to deploy on Railway

## Local setup

1. Install Node.js 18+.
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm start
```

4. Open `http://localhost:3000`.

## Storage behavior

This app now stores:

- Upload links (URL metadata + QR data)
- Uploaded photos per link

### Production / Railway

Set `DATABASE_URL` to a PostgreSQL connection string (Railway Postgres plugin).  
In this mode, links and photos are stored in Postgres (photos in `BYTEA`) and survive app restarts/redeploys.

Memory-conscious upload path (important on small Railway plans):

- Multipart uploads land on disk first (not in Node heap via `memoryStorage`)
- Each photo is resized/compressed with `sharp` before insert (max edge ~1600px JPEG)
- A small thumbnail is stored and used by the gallery (`/photo/:id?v=thumb`)
- Concurrent uploads are limited (`MAX_CONCURRENT_UPLOADS`, default `2`)
- Postgres pool size is capped (`PG_POOL_MAX`, default `3`)

### Local development

If `DATABASE_URL` is not set, the app uses local storage:

- `data.json` for links + photo metadata
- `uploads/` for image files (+ `.thumb.jpg` companions)

## REST API

Create an upload link for integration with another app:

```bash
curl -X POST http://localhost:3000/api/links \
  -H "Content-Type: application/json" \
  -d "{\"sourceDocumentNumber\":\"DOC-2026-001\"}"
```

Example response:

```json
{
  "id": "f3f5a1a2c9",
  "uploadUrl": "http://localhost:3000/u/f3f5a1a2c9",
  "qrCodeUrl": "https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=http%3A%2F%2Flocalhost%3A3000%2Fu%2Ff3f5a1a2c9",
  "sourceDocumentNumber": "DOC-2026-001"
}
```

## Railway deployment

1. Push this folder to a GitHub repo.
2. In Railway, create a new project from that repo.
3. Add a PostgreSQL service in Railway.
4. Set `DATABASE_URL` in your app service environment variables to the Postgres URL.
5. Railway will run `npm install` + `npm start`.
6. After deploy, open the public URL and create upload links.
