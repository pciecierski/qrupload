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

### Local development

If `DATABASE_URL` is not set, the app uses local storage:

- `data.json` for links + photo metadata
- `uploads/` for image files

## Railway deployment

1. Push this folder to a GitHub repo.
2. In Railway, create a new project from that repo.
3. Add a PostgreSQL service in Railway.
4. Set `DATABASE_URL` in your app service environment variables to the Postgres URL.
5. Railway will run `npm install` + `npm start`.
6. After deploy, open the public URL and create upload links.
