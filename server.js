const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const https = require("https");
const path = require("path");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { Pool } = require("pg");

const uploadsRoot = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsRoot)) {
  fs.mkdirSync(uploadsRoot, { recursive: true });
}

const dbFilePath = path.join(__dirname, "data.json");
const app = express();
const port = process.env.PORT || 3000;
const storage = createStorage();

// Cap concurrent upload requests so one busy moment cannot spike RAM.
const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 2);
let activeUploads = 0;

// Keep phone photos usable but much smaller in RAM/DB than full camera originals.
const IMAGE_MAX_EDGE = Number(process.env.IMAGE_MAX_EDGE || 1600);
const IMAGE_JPEG_QUALITY = Number(process.env.IMAGE_JPEG_QUALITY || 78);
const THUMB_MAX_EDGE = Number(process.env.THUMB_MAX_EDGE || 360);
const THUMB_JPEG_QUALITY = Number(process.env.THUMB_JPEG_QUALITY || 68);

app.use("/uploads", express.static(uploadsRoot, { maxAge: "1y", immutable: true }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

function createLinkId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

async function ensureLinkExists(req, res, next) {
  const { linkId } = req.params;
  if (!(await storage.hasLink(linkId))) {
    return res.status(404).send(renderNotFoundPage());
  }
  return next();
}

function uploadForLink() {
  // Always write to disk first. memoryStorage() kept every upload in the Node heap
  // (up to 10 x 10MB) and was the main Railway RAM spike.
  return multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const linkFolder = path.join(uploadsRoot, req.params.linkId);
        fs.mkdirSync(linkFolder, { recursive: true });
        cb(null, linkFolder);
      },
      filename(req, file, cb) {
        const safeExt = path.extname(file.originalname || "").toLowerCase() || ".jpg";
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter(req, file, cb) {
      if (!file.mimetype.startsWith("image/")) {
        return cb(new Error("Only image uploads are allowed."));
      }
      return cb(null, true);
    }
  }).array("photos", 10);
}

function uploadViaMulter(req, res) {
  const uploader = uploadForLink();
  return new Promise((resolve, reject) => {
    uploader(req, res, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function unlinkQuietly(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore missing/temp cleanup failures.
  }
}

/**
 * Compress one image at a time into a smaller JPEG + thumbnail.
 * sequentialRead + single-file processing keeps sharp's peak RSS lower.
 */
async function optimizeImage(inputPath) {
  try {
    const pipeline = sharp(inputPath, {
      failOn: "none",
      sequentialRead: true,
      limitInputPixels: 40_000_000
    }).rotate();

    // Sequential (not Promise.all) so decode/resize peaks stay closer to one frame.
    const data = await pipeline
      .clone()
      .resize({
        width: IMAGE_MAX_EDGE,
        height: IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    const thumb = await pipeline
      .clone()
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: THUMB_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    return { data, thumb, contentType: "image/jpeg" };
  } catch (error) {
    console.warn("Image optimize failed, storing original bytes:", error && error.message);
    const data = await fsp.readFile(inputPath);
    return { data, thumb: null, contentType: "image/jpeg" };
  }
}

function sendBinary(res, contentType, data) {
  res.setHeader("Content-Type", contentType || "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Length", data.length);
  return res.end(data);
}

app.get("/", async (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const links = await storage.getLinks();
  const createdLinks = links.map((link) => {
    const relativeUrl = link.qrData || `/u/${link.id}`;
    return {
      id: link.id,
      url: `${baseUrl}${relativeUrl}`,
      sourceDocumentNumber: link.sourceDocumentNumber || "",
      hasUploads: Boolean(link.hasUploads),
      isApiCreated: Boolean(link.isApiCreated)
    };
  });
  res.send(renderHomePage(createdLinks));
});

app.post("/links", async (req, res) => {
  const linkId = createLinkId();
  const sourceDocumentNumber = normalizeSourceDocumentNumber(req.body.sourceDocumentNumber);
  await storage.createLink(linkId, sourceDocumentNumber, false);
  res.redirect(`/u/${linkId}`);
});

app.post("/api/links", async (req, res) => {
  const linkId = createLinkId();
  const sourceDocumentNumber = normalizeSourceDocumentNumber(req.body && req.body.sourceDocumentNumber);
  await storage.createLink(linkId, sourceDocumentNumber, true);
  return res.status(201).json(buildApiLinkResponse(req, linkId, sourceDocumentNumber));
});

app.get("/apidocs", (req, res) => {
  res.send(renderApiDocsPage(req));
});

app.get("/apidocs.json", (req, res) => {
  res.json(buildApiLinksSpec(req));
});

const KOLEJKA_CLOSED_URL = process.env.KOLEJKA_CLOSED_URL || "https://missioncontrol.dclabs.pl/api/closed";
// Skip TLS verify for POST to kolejka when: KOLEJKA_TLS_INSECURE=1, or Railway deploy (wildcard cert mismatch on custom domain).
// Force strict verify: KOLEJKA_TLS_INSECURE=0
const KOLEJKA_SKIP_TLS_VERIFY = (function () {
  if (process.env.KOLEJKA_TLS_INSECURE === "0" || process.env.KOLEJKA_TLS_INSECURE === "false") {
    return false;
  }
  if (process.env.KOLEJKA_TLS_INSECURE === "1" || process.env.KOLEJKA_TLS_INSECURE === "true") {
    return true;
  }
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_SERVICE_NAME ||
      process.env.RAILWAY_PROJECT_ID
  );
})();

function postJsonToHttps(urlString, jsonObject, timeoutMs) {
  const ms = typeof timeoutMs === "number" ? timeoutMs : 45000;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlString);
    } catch (e) {
      reject(new Error("Invalid KOLEJKA_CLOSED_URL"));
      return;
    }
    const bodyBuf = Buffer.from(JSON.stringify(jsonObject), "utf8");
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
        "User-Agent": "QRupload/1.0",
        Accept: "application/json, */*"
      },
      timeout: ms
    };
    if (KOLEJKA_SKIP_TLS_VERIFY) {
      options.rejectUnauthorized = false;
    }
    const req = https.request(options, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        resolve({
          statusCode: incoming.statusCode,
          headers: incoming.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Upstream timeout after " + ms + "ms"));
    });
    req.write(bodyBuf);
    req.end();
  });
}

app.post("/api/complete-document", async (req, res) => {
  const raw = req.body && req.body.sourceDocumentNumber;
  const sourceDocumentNumber = typeof raw === "string" ? raw.slice(0, 120) : "";
  const upstreamPayload = { sourceDocumentNumber };
  try {
    const upstream = await postJsonToHttps(KOLEJKA_CLOSED_URL, upstreamPayload, 45000);
    const contentType = upstream.headers["content-type"];
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    return res.status(upstream.statusCode || 502).send(upstream.body);
  } catch (err) {
    const code = err && err.code ? err.code : "";
    console.error("complete-document upstream:", err && err.message, code);
    let detail = err && err.message ? err.message : String(err);
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID" && !KOLEJKA_SKIP_TLS_VERIFY) {
      detail +=
        " Set KOLEJKA_TLS_INSECURE=1, deploy on Railway (auto), or npm run start:kolejka-insecure locally. Or fix TLS for missioncontrol.dclabs.pl.";
    }
    return res.status(502).json({
      error: "Upstream request failed",
      detail,
      code: code || undefined
    });
  }
});

app.post("/links/clear", async (req, res) => {
  await storage.clearAll();
  res.redirect("/");
});

app.get("/u/:linkId", ensureLinkExists, async (req, res) => {
  const { linkId } = req.params;
  const uploaded = req.query.uploaded === "1";
  const cleared = req.query.cleared === "1";
  const photos = await storage.getPhotos(linkId);
  const linkData = await storage.getLinkById(linkId);
  const publicUrl = `${getPublicBaseUrl(req)}/u/${linkId}`;
  res.send(renderUploadPage(publicUrl, linkId, linkData, photos, uploaded, cleared, null));
});

app.post("/u/:linkId/upload", ensureLinkExists, async (req, res) => {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    res.setHeader("Retry-After", "3");
    return res
      .status(503)
      .send(renderUploadPage(
        `${getPublicBaseUrl(req)}/u/${req.params.linkId}`,
        req.params.linkId,
        await storage.getLinkById(req.params.linkId),
        await storage.getPhotos(req.params.linkId),
        false,
        false,
        "Serwer jest zajęty przesyłaniem innych zdjęć. Spróbuj ponownie za chwilę."
      ));
  }

  activeUploads += 1;
  const uploadedFiles = [];
  try {
    await uploadViaMulter(req, res);
    uploadedFiles.push(...(req.files || []));
    await storage.addPhotos(req.params.linkId, uploadedFiles);
    return res.redirect(`/u/${req.params.linkId}?uploaded=1`);
  } catch (err) {
    await Promise.all(uploadedFiles.map((file) => unlinkQuietly(file && file.path)));
    const photos = await storage.getPhotos(req.params.linkId);
    const linkData = await storage.getLinkById(req.params.linkId);
    const publicUrl = `${getPublicBaseUrl(req)}/u/${req.params.linkId}`;
    return res.status(400).send(renderUploadPage(publicUrl, req.params.linkId, linkData, photos, false, false, err.message));
  } finally {
    activeUploads = Math.max(0, activeUploads - 1);
  }
});

app.post("/u/:linkId/photos/clear", ensureLinkExists, async (req, res) => {
  await storage.clearPhotosForLink(req.params.linkId);
  res.redirect(`/u/${req.params.linkId}?cleared=1`);
});

app.get("/photo/:photoId", async (req, res) => {
  const variant = req.query.v === "thumb" ? "thumb" : "full";
  const photo = await storage.getPhotoById(req.params.photoId, variant);
  if (!photo) {
    return res.status(404).send(renderNotFoundPage());
  }

  if (photo.data) {
    return sendBinary(res, photo.contentType, photo.data);
  }

  if (photo.filePath) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(photo.filePath);
  }

  return res.status(404).send(renderNotFoundPage());
});

start().catch((error) => {
  console.error("Failed to start QRupload:", error);
  process.exit(1);
});

async function start() {
  await storage.init();
  app.listen(port, () => {
    console.log(`QRupload app listening on http://localhost:${port} using ${storage.kind} storage`);
    if (KOLEJKA_SKIP_TLS_VERIFY) {
      console.warn(
        "Kolejka upstream: TLS certificate verification is disabled for POST to kolejka. After missioncontrol.dclabs.pl has a valid cert, set KOLEJKA_TLS_INSECURE=0."
      );
    }
  });
}

function createStorage() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return createPostgresStorage(normalizeDatabaseUrl(databaseUrl));
  }
  return createFileStorage();
}

function createFileStorage() {
  function readState() {
    if (!fs.existsSync(dbFilePath)) {
      return { links: [], photos: [] };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(dbFilePath, "utf8"));
      return {
        links: Array.isArray(parsed.links) ? parsed.links : [],
        photos: Array.isArray(parsed.photos) ? parsed.photos : []
      };
    } catch {
      return { links: [], photos: [] };
    }
  }

  function writeState(state) {
    fs.writeFileSync(dbFilePath, JSON.stringify(state, null, 2));
  }

  return {
    kind: "file",
    async init() {
      if (!fs.existsSync(dbFilePath)) {
        writeState({ links: [], photos: [] });
      }
    },
    async createLink(id, sourceDocumentNumber, isApiCreated) {
      const state = readState();
      if (!state.links.some((link) => link.id === id)) {
        state.links.push({
          id,
          qrData: `/u/${id}`,
          sourceDocumentNumber,
          isApiCreated: Boolean(isApiCreated),
          createdAt: new Date().toISOString()
        });
        writeState(state);
      }
    },
    async hasLink(id) {
      const state = readState();
      return state.links.some((link) => link.id === id);
    },
    async getLinks() {
      const state = readState();
      return state.links
        .map((link) => ({
          ...link,
          hasUploads: state.photos.some((photo) => photo.linkId === link.id)
        }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    async getLinkById(id) {
      const state = readState();
      return state.links.find((link) => link.id === id) || null;
    },
    async addPhotos(linkId, files) {
      if (!files.length) return;
      const state = readState();
      for (const file of files) {
        if (!file || !file.path) continue;
        const optimized = await optimizeImage(file.path);
        const baseName = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const finalPath = path.join(path.dirname(file.path), `${baseName}.jpg`);
        await fsp.writeFile(finalPath, optimized.data);
        let thumbPath = null;
        if (optimized.thumb) {
          thumbPath = path.join(path.dirname(file.path), `${baseName}.thumb.jpg`);
          await fsp.writeFile(thumbPath, optimized.thumb);
        }
        if (file.path !== finalPath) {
          await unlinkQuietly(file.path);
        }
        state.photos.push({
          id: crypto.randomUUID(),
          linkId,
          filename: `${baseName}.jpg`,
          contentType: optimized.contentType,
          filePath: finalPath,
          thumbPath,
          createdAt: new Date().toISOString()
        });
        // Drop large buffers ASAP.
        optimized.data = null;
        optimized.thumb = null;
      }
      writeState(state);
    },
    async getPhotos(linkId) {
      const state = readState();
      return state.photos
        .filter((photo) => photo.linkId === linkId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((photo) => `/photo/${encodeURIComponent(photo.id)}`);
    },
    async getPhotoById(photoId, variant = "full") {
      const state = readState();
      const photo = state.photos.find((entry) => entry.id === photoId);
      if (!photo) return null;

      if (variant === "thumb" && photo.thumbPath && fs.existsSync(photo.thumbPath)) {
        return {
          contentType: "image/jpeg",
          filePath: photo.thumbPath
        };
      }

      if (!photo.filePath || !fs.existsSync(photo.filePath)) {
        return null;
      }
      return {
        contentType: photo.contentType || "image/jpeg",
        filePath: photo.filePath
      };
    },
    async clearAll() {
      const state = readState();
      for (const photo of state.photos) {
        await unlinkQuietly(photo.filePath);
        await unlinkQuietly(photo.thumbPath);
      }
      writeState({ links: [], photos: [] });
    },
    async clearPhotosForLink(linkId) {
      const state = readState();
      const keptPhotos = [];
      for (const photo of state.photos) {
        if (photo.linkId !== linkId) {
          keptPhotos.push(photo);
          continue;
        }
        await unlinkQuietly(photo.filePath);
        await unlinkQuietly(photo.thumbPath);
      }
      state.photos = keptPhotos;
      writeState(state);
    }
  };
}

function createPostgresStorage(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("railway.app") ? { rejectUnauthorized: false } : undefined,
    // Small Railway plans: fewer idle connections = less RSS.
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: true
  });

  return {
    kind: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS links (
          id TEXT PRIMARY KEY,
          qr_data TEXT NOT NULL,
          source_document_number TEXT NOT NULL DEFAULT '',
          api_created BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        ALTER TABLE links
        ADD COLUMN IF NOT EXISTS source_document_number TEXT NOT NULL DEFAULT '';
      `);
      await pool.query(`
        ALTER TABLE links
        ADD COLUMN IF NOT EXISTS api_created BOOLEAN NOT NULL DEFAULT FALSE;
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS photos (
          id BIGSERIAL PRIMARY KEY,
          link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          data BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        ALTER TABLE photos
        ADD COLUMN IF NOT EXISTS thumb BYTEA;
      `);
    },
    async createLink(id, sourceDocumentNumber, isApiCreated) {
      const qrData = `/u/${id}`;
      await pool.query(
        `INSERT INTO links (id, qr_data, source_document_number, api_created)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, qrData, sourceDocumentNumber, Boolean(isApiCreated)]
      );
    },
    async hasLink(id) {
      const result = await pool.query(`SELECT 1 FROM links WHERE id = $1 LIMIT 1`, [id]);
      return result.rowCount > 0;
    },
    async getLinks() {
      const result = await pool.query(
        `SELECT
           l.id,
           l.qr_data AS "qrData",
           l.source_document_number AS "sourceDocumentNumber",
           l.api_created AS "isApiCreated",
           l.created_at AS "createdAt",
           EXISTS (
             SELECT 1 FROM photos p WHERE p.link_id = l.id
           ) AS "hasUploads"
         FROM links l
         ORDER BY l.created_at DESC`
      );
      return result.rows;
    },
    async getLinkById(id) {
      const result = await pool.query(
        `SELECT id, qr_data AS "qrData", source_document_number AS "sourceDocumentNumber", api_created AS "isApiCreated", created_at AS "createdAt"
         FROM links
         WHERE id = $1
         LIMIT 1`,
        [id]
      );
      return result.rowCount ? result.rows[0] : null;
    },
    async addPhotos(linkId, files) {
      if (!files.length) return;
      // Process one file at a time so sharp + BYTEA insert do not multiply in heap.
      for (const file of files) {
        if (!file || !file.path) continue;
        let optimized;
        try {
          optimized = await optimizeImage(file.path);
          await pool.query(
            `INSERT INTO photos (link_id, filename, content_type, data, thumb)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              linkId,
              file.originalname || "photo.jpg",
              optimized.contentType,
              optimized.data,
              optimized.thumb
            ]
          );
        } finally {
          await unlinkQuietly(file.path);
          if (optimized) {
            optimized.data = null;
            optimized.thumb = null;
          }
        }
      }
    },
    async getPhotos(linkId) {
      const result = await pool.query(
        `SELECT id FROM photos WHERE link_id = $1 ORDER BY created_at DESC`,
        [linkId]
      );
      return result.rows.map((row) => `/photo/${row.id}`);
    },
    async getPhotoById(photoId, variant = "full") {
      if (variant === "thumb") {
        const thumbResult = await pool.query(
          `SELECT content_type AS "contentType",
                  COALESCE(thumb, data) AS data
           FROM photos
           WHERE id = $1
           LIMIT 1`,
          [photoId]
        );
        if (!thumbResult.rowCount) return null;
        return {
          contentType: "image/jpeg",
          data: thumbResult.rows[0].data
        };
      }

      const result = await pool.query(
        `SELECT content_type AS "contentType", data FROM photos WHERE id = $1 LIMIT 1`,
        [photoId]
      );
      if (!result.rowCount) return null;
      return result.rows[0];
    },
    async clearAll() {
      await pool.query(`DELETE FROM photos`);
      await pool.query(`DELETE FROM links`);
    },
    async clearPhotosForLink(linkId) {
      await pool.query(`DELETE FROM photos WHERE link_id = $1`, [linkId]);
    }
  };
}

function renderHomePage(createdLinks) {
  const linkList = createdLinks.length
    ? createdLinks
        .map(({ id, url, sourceDocumentNumber, hasUploads, isApiCreated }) => {
          const encodedUrl = encodeURIComponent(url);
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodedUrl}`;
          const sourceLabel = sourceDocumentNumber
            ? escapeHtml(sourceDocumentNumber)
            : "Not provided";
          const apiBadge = isApiCreated ? '<span class="api-pill">API</span>' : "";
          const statusClass = hasUploads ? "used" : "unused";
          const statusText = hasUploads ? "Used: photo uploaded" : "Unused: no uploads yet";
          return `<li class="link-card">
        <p class="link-card-label">Link ${apiBadge}</p>
        <p class="link-status">
          <span class="status-icon ${statusClass}" aria-hidden="true"></span>
          ${statusText}
        </p>
        <p class="source-doc"><strong>Source document:</strong> ${sourceLabel}</p>
        <p><a href="/u/${encodeURIComponent(id)}">${escapeHtml(url)}</a></p>
        <button
          class="qr-button"
          type="button"
          data-qr-url="${qrUrl}"
          data-link-url="${escapeHtml(url)}"
          aria-label="Open QR code for ${escapeHtml(url)}"
        >
          <img src="${qrUrl}" alt="QR code for ${escapeHtml(url)}" loading="lazy" />
        </button>
      </li>`;
        })
        .join("")
    : `<li class="empty">No links created yet.</li>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tworzenie Linków i QR do dokumentów</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="container">
      <header class="title-row">
        <h1>Tworzenie Linków i QR do dokumentów</h1>
        <img src="/dclog-logo.png" alt="dclog.pl logo" class="app-logo" />
      </header>
      <p>Za pomocą tego rozwiązania możesz tworzyć pojedyncze linki w postaci kodów QR które pozwolą sprawnie przesyłać np. zdjęcia i/lub dokumentację z poziomu dowolnego smartfona</p>
      <form method="post" action="/links">
        <input id="sourceDocumentNumber" name="sourceDocumentNumber" type="hidden" />
        <button id="openCreateLinkDialog" type="button">Create Upload Link</button>
      </form>
      <h2>Created Links</h2>
      <ul class="link-grid">
        ${linkList}
      </ul>
      <form method="post" action="/links/clear" class="danger-zone">
        <button
          type="submit"
          class="danger-button"
          onclick="return window.confirm('Delete all created links and uploaded photos?')"
        >
          Delete all created links
        </button>
      </form>
    </main>
    <footer class="app-footer">
      <div>Product preview, Designed by dclog.pl</div>
      <p><a href="/apidocs">Open API docs</a></p>
    </footer>
    <dialog id="qrDialog" class="qr-dialog">
      <div class="qr-dialog-content">
        <button id="closeQrDialog" class="close-dialog" type="button" aria-label="Close QR code dialog">Close</button>
        <img id="dialogQrImage" alt="" />
      </div>
    </dialog>
    <dialog id="createLinkDialog" class="qr-dialog">
      <form id="createLinkDialogForm" method="dialog" class="qr-dialog-content">
        <label for="sourceDocumentPromptInput"><strong>Source document number</strong></label>
        <input id="sourceDocumentPromptInput" type="text" maxlength="120" required />
        <div class="dialog-actions">
          <button id="cancelCreateLink" type="button">Cancel</button>
          <button type="submit">Create</button>
        </div>
      </form>
    </dialog>
    <script>
      const qrDialog = document.getElementById("qrDialog");
      const qrDialogContent = qrDialog.querySelector(".qr-dialog-content");
      const dialogQrImage = document.getElementById("dialogQrImage");
      const closeQrDialog = document.getElementById("closeQrDialog");
      const qrButtons = document.querySelectorAll(".qr-button");
      const createForm = document.querySelector('form[action="/links"]');
      const sourceInput = document.getElementById("sourceDocumentNumber");
      const openCreateLinkDialogButton = document.getElementById("openCreateLinkDialog");
      const createLinkDialog = document.getElementById("createLinkDialog");
      const createLinkDialogForm = document.getElementById("createLinkDialogForm");
      const sourceDocumentPromptInput = document.getElementById("sourceDocumentPromptInput");
      const cancelCreateLink = document.getElementById("cancelCreateLink");

      qrButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const qrUrl = button.dataset.qrUrl;
          const linkUrl = button.dataset.linkUrl;
          if (!qrUrl) return;
          dialogQrImage.src = qrUrl.replace("size=180x180", "size=420x420");
          dialogQrImage.alt = "QR code for " + (linkUrl || "upload link");
          qrDialog.showModal();
        });
      });

      closeQrDialog.addEventListener("click", () => {
        qrDialog.close();
      });

      qrDialog.addEventListener("click", (event) => {
        if (!qrDialogContent.contains(event.target)) {
          qrDialog.close();
        }
      });

      if (createForm && sourceInput && openCreateLinkDialogButton && createLinkDialog && createLinkDialogForm) {
        openCreateLinkDialogButton.addEventListener("click", () => {
          if (typeof createLinkDialog.showModal === "function") {
            sourceDocumentPromptInput.value = "";
            createLinkDialog.showModal();
            sourceDocumentPromptInput.focus();
            return;
          }

          // Fallback for browsers without <dialog> support.
          const fallbackValue = window.prompt("Enter source document number:");
          if (fallbackValue === null) return;
          sourceInput.value = fallbackValue.trim();
          createForm.submit();
        });

        cancelCreateLink.addEventListener("click", () => {
          createLinkDialog.close();
        });

        createLinkDialogForm.addEventListener("submit", (event) => {
          event.preventDefault();
          sourceInput.value = sourceDocumentPromptInput.value.trim();
          createLinkDialog.close();
          createForm.submit();
        });
      }
    </script>
  </body>
</html>`;
}

function renderUploadPage(publicUrl, linkId, linkData, photos, uploaded, cleared, errorMessage) {
  const apiBadge = linkData && linkData.isApiCreated ? '<span class="api-pill">API</span>' : "";
  const canCompleteDocument = photos.length > 0;
  const photoList = photos.length
    ? photos
        .map(
          (photoUrl) => `<li class="photo-item">
        <img src="${photoUrl}?v=thumb" alt="Uploaded photo" loading="lazy" decoding="async" width="360" height="360" />
        <button class="open-photo-button" type="button" data-photo-url="${photoUrl}">Open full size</button>
      </li>`
        )
        .join("")
    : `<li class="empty">No photos uploaded yet.</li>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Obsługa dokumentu</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="container">
      <header class="title-row">
        <h1>Obsługa dokumentu</h1>
        <img src="/dclog-logo.png" alt="dclog.pl logo" class="app-logo" />
      </header>
      ${apiBadge}
      <p id="documentCompletionPill" class="completion-pill" style="display: none;">Obsługa dokumentu zakończona</p>
      <p class="source-doc">
        <strong>Source document:</strong> ${escapeHtml((linkData && linkData.sourceDocumentNumber) || "Not provided")}
      </p>
      <p class="source-doc-note">Dodajesz zdjęcia dla tego dokumentu źródłowego, informacje o dodanych zdjęciach zostaną odzwierciedlone w dokumencie źródłowym/misji i zakończą jego procesowanie.</p>
      <p class="link-label">Unique URL:</p>
      <p><code>${escapeHtml(publicUrl)}</code></p>
      <p><a href="/">wróć do menu głównego</a></p>
      <p class="hint">ten link działa na dowolnej przeglądarce na telefonie, użyj przycisków poniżej żeby dodać zdjęcia do dokumentu</p>

      ${uploaded ? '<div id="uploadToast" class="toast toast-success" role="status" aria-live="polite">Zdjęcie zostało poprawnie przesłane.</div>' : ""}
      ${cleared ? '<p class="ok">All uploaded photos for this link were deleted.</p>' : ""}
      ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}

      <form method="post" action="/u/${encodeURIComponent(linkId)}/upload" enctype="multipart/form-data">
        <input id="photos" name="photos" type="file" accept="image/*" capture="environment" multiple required />
        <button id="cameraButton" type="button">Wykonaj zdjęcie</button>
        <button id="uploadButton" class="upload-button" type="submit" disabled>Prześlij zdjęcie</button>
      </form>

      <h2>Uploaded Photos</h2>
      <form method="post" action="/u/${encodeURIComponent(linkId)}/photos/clear" class="danger-zone">
        <div class="action-row">
          <button
            type="submit"
            class="danger-button"
            onclick="return window.confirm('Delete all uploaded photos for this link?')"
          >
            Usuń Zdjęcia
          </button>
          <button
            id="completeDocButton"
            type="button"
            class="complete-doc-button"
            ${canCompleteDocument ? "" : "disabled"}
            data-link-id="${escapeHtml(linkId)}"
            data-source-document-number="${escapeHtml((linkData && linkData.sourceDocumentNumber) || '')}"
          >
            zakończ obsługę dokumentu.
          </button>
        </div>
      </form>
      <ul class="photo-grid">
        ${photoList}
      </ul>
    </main>
    <footer class="app-footer">Product preview, Designed by dclog.pl</footer>
    <dialog id="photoDialog" class="photo-dialog">
      <div class="photo-dialog-content">
        <button id="closePhotoDialog" class="close-dialog" type="button" aria-label="Close full size image">Close</button>
        <img id="dialogPhotoImage" alt="Full size uploaded photo" />
      </div>
    </dialog>
    <dialog id="completeDocDialog" class="qr-dialog">
      <div class="qr-dialog-content">
        <p>Dokument zostanie zakończony  a infomracje zostaną przekazane do systemu źródłowego, czy potwierdzasz?</p>
        <div class="dialog-actions">
          <button id="cancelCompleteDoc" type="button">Zrezygnuj</button>
          <button id="confirmCompleteDoc" type="button">Potwierdź</button>
        </div>
      </div>
    </dialog>
    <script>
      const fileInput = document.getElementById("photos");
      const cameraButton = document.getElementById("cameraButton");
      const uploadButton = document.getElementById("uploadButton");
      const photoDialog = document.getElementById("photoDialog");
      const photoDialogContent = photoDialog.querySelector(".photo-dialog-content");
      const dialogPhotoImage = document.getElementById("dialogPhotoImage");
      const closePhotoDialog = document.getElementById("closePhotoDialog");
      const openPhotoButtons = document.querySelectorAll(".open-photo-button");
      const uploadToast = document.getElementById("uploadToast");
      const completeDocButton = document.getElementById("completeDocButton");
      const completeDocDialog = document.getElementById("completeDocDialog");
      const cancelCompleteDoc = document.getElementById("cancelCompleteDoc");
      const confirmCompleteDoc = document.getElementById("confirmCompleteDoc");
      const documentCompletionPill = document.getElementById("documentCompletionPill");

      function syncUploadState() {
        const hasSelectedPhoto = fileInput.files && fileInput.files.length > 0;
        cameraButton.disabled = hasSelectedPhoto;
        uploadButton.disabled = !hasSelectedPhoto;
        uploadButton.classList.toggle("ready", hasSelectedPhoto);
      }

      syncUploadState();

      cameraButton.addEventListener("click", () => {
        // iOS Safari requires direct user gesture to open camera/file chooser.
        fileInput.click();
      });

      fileInput.addEventListener("change", () => {
        syncUploadState();
      });

      const uploadForm = fileInput.closest("form");
      if (uploadForm) {
        uploadForm.addEventListener("submit", async (event) => {
          // Client-side resize shrinks payload before it hits Railway RAM.
          if (uploadForm.dataset.compressing === "1") return;
          const selected = fileInput.files ? Array.from(fileInput.files) : [];
          if (!selected.length || typeof createImageBitmap !== "function" || typeof DataTransfer === "undefined") {
            cameraButton.disabled = true;
            uploadButton.disabled = true;
            return;
          }

          event.preventDefault();
          uploadForm.dataset.compressing = "1";
          cameraButton.disabled = true;
          uploadButton.disabled = true;
          uploadButton.textContent = "Przygotowywanie…";

          try {
            const transfer = new DataTransfer();
            for (const file of selected) {
              transfer.items.add(await compressImageForUpload(file));
            }
            fileInput.files = transfer.files;
            uploadForm.submit();
          } catch (err) {
            console.warn("Client compress failed, uploading originals:", err);
            uploadForm.dataset.compressing = "0";
            uploadForm.submit();
          }
        });
      }

      async function compressImageForUpload(file) {
        if (!file || !file.type || file.type.indexOf("image/") !== 0) return file;
        const maxEdge = 1600;
        const bitmap = await createImageBitmap(file);
        try {
          const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
          const width = Math.max(1, Math.round(bitmap.width * scale));
          const height = Math.max(1, Math.round(bitmap.height * scale));
          if (scale >= 0.98 && file.size < 900 * 1024) {
            return file;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) return file;
          ctx.drawImage(bitmap, 0, 0, width, height);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
          if (!blob || blob.size >= file.size) return file;
          const name = (file.name || "photo.jpg").replace(/\.[^.]+$/, "") + ".jpg";
          return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
        } finally {
          if (bitmap && typeof bitmap.close === "function") bitmap.close();
        }
      }

      openPhotoButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const photoUrl = button.dataset.photoUrl;
          if (!photoUrl) return;
          dialogPhotoImage.src = photoUrl;
          photoDialog.showModal();
        });
      });

      closePhotoDialog.addEventListener("click", () => {
        photoDialog.close();
      });

      photoDialog.addEventListener("click", (event) => {
        if (!photoDialogContent.contains(event.target)) {
          photoDialog.close();
        }
      });

      // Show toast after successful upload (rendered when query param uploaded=1 is present).
      if (uploadToast) {
        requestAnimationFrame(() => uploadToast.classList.add("show"));
        setTimeout(() => uploadToast.classList.remove("show"), 4000);
      }

      if (completeDocButton) {
        completeDocButton.addEventListener("click", () => {
          if (completeDocDialog && typeof completeDocDialog.showModal === "function") {
            completeDocDialog.showModal();
          }
        });
      }

      if (cancelCompleteDoc && completeDocDialog) {
        cancelCompleteDoc.addEventListener("click", () => {
          completeDocDialog.close();
        });
      }

      function showFloatingToast(message, variant) {
        var existing = document.getElementById("floatingToast");
        if (!existing) {
          existing = document.createElement("div");
          existing.id = "floatingToast";
          existing.setAttribute("role", "status");
          existing.setAttribute("aria-live", "polite");
          document.body.appendChild(existing);
        }
        existing.className = "toast " + (variant === "error" ? "toast-error" : "toast-warning");
        existing.textContent = message;
        requestAnimationFrame(function () {
          existing.classList.add("show");
        });
        setTimeout(function () {
          existing.classList.remove("show");
        }, 5000);
      }

      if (confirmCompleteDoc && completeDocButton && documentCompletionPill && completeDocDialog) {
        confirmCompleteDoc.addEventListener("click", function () {
          completeDocDialog.close();

          var sourceDocumentNumber = completeDocButton.dataset.sourceDocumentNumber || "";
          completeDocButton.disabled = true;
          confirmCompleteDoc.disabled = true;

          fetch("/api/complete-document", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sourceDocumentNumber: sourceDocumentNumber })
          })
            .then(function (resp) {
              if (resp.status === 200) {
                var linkIdForCompletion = completeDocButton.dataset.linkId || "";
                var storageKey = linkIdForCompletion ? "qrupload:docCompleted:" + linkIdForCompletion : "";
                if (storageKey) {
                  try {
                    localStorage.setItem(storageKey, "1");
                  } catch (e) {
                    // Ignore localStorage errors (private mode, etc.).
                  }
                }
                documentCompletionPill.style.display = "block";
                var actionForm = completeDocButton.closest("form");
                var deletePhotosButton = actionForm ? actionForm.querySelector("button.danger-button") : null;
                if (deletePhotosButton) deletePhotosButton.style.display = "none";
                completeDocButton.style.display = "none";
                showFloatingToast("Obsługa dokumentu została zakończona.", "warning");
              } else {
                return resp.text().then(function (text) {
                  var msg = "Nie udało się zakończyć obsługi dokumentu (HTTP " + resp.status + ").";
                  try {
                    var j = JSON.parse(text);
                    if (j && j.detail) {
                      msg = msg + " " + j.detail;
                    } else if (j && j.error) {
                      msg = msg + " " + j.error;
                    }
                    if (j && j.code) {
                      msg = msg + " (" + j.code + ")";
                    }
                  } catch (e2) {
                    if (text && text.length < 300) {
                      msg = msg + " " + text.trim();
                    }
                  }
                  showFloatingToast(msg, "error");
                  completeDocButton.disabled = false;
                });
              }
            })
            .catch(function () {
              showFloatingToast("Błąd połączenia. Spróbuj ponownie.", "error");
              completeDocButton.disabled = false;
            })
            .finally(function () {
              confirmCompleteDoc.disabled = false;
            });
        });
      }

      // Apply completed state on page load.
      if (completeDocButton && documentCompletionPill) {
        const linkIdForCompletion = completeDocButton.dataset.linkId || "";
        const storageKey = linkIdForCompletion ? "qrupload:docCompleted:" + linkIdForCompletion : "";
        if (storageKey) {
          let isCompleted = false;
          try {
            isCompleted = localStorage.getItem(storageKey) === "1";
          } catch {
            isCompleted = false;
          }
          if (isCompleted) {
            documentCompletionPill.style.display = "block";

            const actionForm = completeDocButton.closest("form");
            const deletePhotosButton = actionForm ? actionForm.querySelector("button.danger-button") : null;
            if (deletePhotosButton) deletePhotosButton.style.display = "none";
            completeDocButton.style.display = "none";
          }
        }
      }
    </script>
  </body>
</html>`;
}

function renderNotFoundPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Link Not Found</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="container">
      <header class="title-row">
        <h1>Link not found</h1>
        <img src="/dclog-logo.png" alt="dclog.pl logo" class="app-logo" />
      </header>
      <p>This upload link does not exist or has expired.</p>
      <a href="/">Create a new upload link</a>
    </main>
    <footer class="app-footer">Product preview, Designed by dclog.pl</footer>
  </body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getPublicBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function normalizeSourceDocumentNumber(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 120);
}

function buildApiLinkResponse(req, linkId, sourceDocumentNumber) {
  const uploadPath = `/u/${linkId}`;
  const uploadUrl = `${getPublicBaseUrl(req)}${uploadPath}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=${encodeURIComponent(uploadUrl)}`;
  return {
    id: linkId,
    uploadUrl,
    qrCodeUrl,
    sourceDocumentNumber
  };
}

function buildApiLinksSpec(req) {
  const baseUrl = getPublicBaseUrl(req);
  return {
    openapi: "3.0.3",
    info: {
      title: "QRupload API",
      version: "1.0.0",
      description: "API endpoint for creating upload links with QR codes."
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/api/links": {
        post: {
          summary: "Create a new upload link",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sourceDocumentNumber: {
                      type: "string",
                      maxLength: 120,
                      description: "Optional source document number."
                    }
                  }
                },
                example: {
                  sourceDocumentNumber: "DOC-2026-0001"
                }
              }
            }
          },
          responses: {
            201: {
              description: "Link created successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      uploadUrl: { type: "string", format: "uri" },
                      qrCodeUrl: { type: "string", format: "uri" },
                      sourceDocumentNumber: { type: "string" }
                    },
                    required: ["id", "uploadUrl", "qrCodeUrl", "sourceDocumentNumber"]
                  },
                  example: {
                    id: "a1b2c3d4e5",
                    uploadUrl: `${baseUrl}/u/a1b2c3d4e5`,
                    qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=${encodeURIComponent(`${baseUrl}/u/a1b2c3d4e5`)}`,
                    sourceDocumentNumber: "DOC-2026-0001"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

function renderApiDocsPage(req) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>QRupload API Docs</title>
    <link rel="stylesheet" href="/styles.css" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <main class="container">
      <header class="title-row">
        <h1>QRupload API docs</h1>
        <img src="/dclog-logo.png" alt="dclog.pl logo" class="app-logo" />
      </header>
      <p>Specyfikacja endpointu <code>POST /api/links</code>.</p>
      <p>
        <a href="/apidocs.json" target="_blank" rel="noopener noreferrer">Open raw JSON spec</a>
      </p>
      <div id="swagger-ui"></div>
    </main>
    <footer class="app-footer">Product preview, Designed by dclog.pl</footer>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.addEventListener("load", function () {
        if (!window.SwaggerUIBundle) return;
        window.SwaggerUIBundle({
          url: "/apidocs.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          displayRequestDuration: true
        });
      });
    </script>
  </body>
</html>`;
}

function normalizeDatabaseUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return "";
  }

  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("railwaypostgresql://")) {
    return `postgresql://${trimmed.slice("railwaypostgresql://".length)}`;
  }

  if (trimmed.startsWith("railway://")) {
    return `postgresql://${trimmed.slice("railway://".length)}`;
  }

  return trimmed;
}
