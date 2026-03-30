const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");

const uploadsRoot = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsRoot)) {
  fs.mkdirSync(uploadsRoot, { recursive: true });
}

const dbFilePath = path.join(__dirname, "data.json");
const app = express();
const port = process.env.PORT || 3000;
const storage = createStorage();

app.use("/uploads", express.static(uploadsRoot));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

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

function uploadForLink(usesPostgres) {
  const configuredStorage = usesPostgres ? multer.memoryStorage() : multer.diskStorage({
    destination(req, file, cb) {
      const linkFolder = path.join(uploadsRoot, req.params.linkId);
      fs.mkdirSync(linkFolder, { recursive: true });
      cb(null, linkFolder);
    },
    filename(req, file, cb) {
      const safeExt = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
    }
  });

  return multer({
    storage: configuredStorage,
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter(req, file, cb) {
      if (!file.mimetype.startsWith("image/")) {
        return cb(new Error("Only image uploads are allowed."));
      }
      return cb(null, true);
    }
  }).array("photos", 10);
}

function uploadViaMulter(req, res, usesPostgres) {
  const uploader = uploadForLink(usesPostgres);
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

app.get("/", async (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const links = await storage.getLinks();
  const createdLinks = links.map((link) => {
    const relativeUrl = link.qrData || `/u/${link.id}`;
    return {
      id: link.id,
      url: `${baseUrl}${relativeUrl}`,
      sourceDocumentNumber: link.sourceDocumentNumber || "",
      hasUploads: Boolean(link.hasUploads)
    };
  });
  res.send(renderHomePage(createdLinks));
});

app.post("/links", async (req, res) => {
  const linkId = createLinkId();
  const sourceDocumentNumber = normalizeSourceDocumentNumber(req.body.sourceDocumentNumber);
  await storage.createLink(linkId, sourceDocumentNumber);
  res.redirect(`/u/${linkId}`);
});

app.post("/links/clear", async (req, res) => {
  await storage.clearAll();
  res.redirect("/");
});

app.get("/u/:linkId", ensureLinkExists, async (req, res) => {
  const { linkId } = req.params;
  const uploaded = req.query.uploaded === "1";
  const photos = await storage.getPhotos(linkId);
  const linkData = await storage.getLinkById(linkId);
  const publicUrl = `${getPublicBaseUrl(req)}/u/${linkId}`;
  res.send(renderUploadPage(publicUrl, linkId, linkData, photos, uploaded, null));
});

app.post("/u/:linkId/upload", ensureLinkExists, async (req, res) => {
  try {
    await uploadViaMulter(req, res, storage.kind === "postgres");
    await storage.addPhotos(req.params.linkId, req.files || []);
    return res.redirect(`/u/${req.params.linkId}?uploaded=1`);
  } catch (err) {
    const photos = await storage.getPhotos(req.params.linkId);
    const linkData = await storage.getLinkById(req.params.linkId);
    const publicUrl = `${getPublicBaseUrl(req)}/u/${req.params.linkId}`;
    return res.status(400).send(renderUploadPage(publicUrl, req.params.linkId, linkData, photos, false, err.message));
  }
});

app.get("/photo/:photoId", async (req, res) => {
  const photo = await storage.getPhotoById(req.params.photoId);
  if (!photo) {
    return res.status(404).send(renderNotFoundPage());
  }

  if (photo.data) {
    res.setHeader("Content-Type", photo.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(photo.data);
  }

  if (photo.filePath) {
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
    async createLink(id, sourceDocumentNumber) {
      const state = readState();
      if (!state.links.some((link) => link.id === id)) {
        state.links.push({
          id,
          qrData: `/u/${id}`,
          sourceDocumentNumber,
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
      const rows = files.map((file) => ({
        id: crypto.randomUUID(),
        linkId,
        filename: file.filename,
        contentType: file.mimetype || "image/jpeg",
        filePath: file.path,
        createdAt: new Date().toISOString()
      }));
      state.photos.push(...rows);
      writeState(state);
    },
    async getPhotos(linkId) {
      const state = readState();
      return state.photos
        .filter((photo) => photo.linkId === linkId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((photo) => `/photo/${encodeURIComponent(photo.id)}`);
    },
    async getPhotoById(photoId) {
      const state = readState();
      const photo = state.photos.find((entry) => entry.id === photoId);
      if (!photo || !photo.filePath || !fs.existsSync(photo.filePath)) {
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
        if (photo.filePath && fs.existsSync(photo.filePath)) {
          try {
            fs.unlinkSync(photo.filePath);
          } catch {
            // Ignore file deletion errors and continue cleanup.
          }
        }
      }
      writeState({ links: [], photos: [] });
    }
  };
}

function createPostgresStorage(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("railway.app") ? { rejectUnauthorized: false } : undefined
  });

  return {
    kind: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS links (
          id TEXT PRIMARY KEY,
          qr_data TEXT NOT NULL,
          source_document_number TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        ALTER TABLE links
        ADD COLUMN IF NOT EXISTS source_document_number TEXT NOT NULL DEFAULT '';
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
    },
    async createLink(id, sourceDocumentNumber) {
      const qrData = `/u/${id}`;
      await pool.query(
        `INSERT INTO links (id, qr_data, source_document_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, qrData, sourceDocumentNumber]
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
        `SELECT id, qr_data AS "qrData", source_document_number AS "sourceDocumentNumber", created_at AS "createdAt"
         FROM links
         WHERE id = $1
         LIMIT 1`,
        [id]
      );
      return result.rowCount ? result.rows[0] : null;
    },
    async addPhotos(linkId, files) {
      if (!files.length) return;
      for (const file of files) {
        await pool.query(
          `INSERT INTO photos (link_id, filename, content_type, data) VALUES ($1, $2, $3, $4)`,
          [linkId, file.originalname || "photo.jpg", file.mimetype || "image/jpeg", file.buffer]
        );
      }
    },
    async getPhotos(linkId) {
      const result = await pool.query(
        `SELECT id FROM photos WHERE link_id = $1 ORDER BY created_at DESC`,
        [linkId]
      );
      return result.rows.map((row) => `/photo/${row.id}`);
    },
    async getPhotoById(photoId) {
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
    }
  };
}

function renderHomePage(createdLinks) {
  const linkList = createdLinks.length
    ? createdLinks
        .map(({ id, url, sourceDocumentNumber, hasUploads }) => {
          const encodedUrl = encodeURIComponent(url);
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodedUrl}`;
          const sourceLabel = sourceDocumentNumber
            ? escapeHtml(sourceDocumentNumber)
            : "Not provided";
          const statusClass = hasUploads ? "used" : "unused";
          const statusText = hasUploads ? "Used: photo uploaded" : "Unused: no uploads yet";
          return `<li class="link-card">
        <p class="link-card-label">Link</p>
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
    <title>QRupload</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="container">
      <h1>QRupload</h1>
      <p>Create a unique link and share it with a phone to upload photos.</p>
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

function renderUploadPage(publicUrl, linkId, linkData, photos, uploaded, errorMessage) {
  const photoList = photos.length
    ? photos
        .map(
          (photoUrl) => `<li class="photo-item">
        <img src="${photoUrl}" alt="Uploaded photo" loading="lazy" />
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
    <title>Upload Photos</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="container">
      <h1>Upload Photos</h1>
      <p class="source-doc">
        <strong>Source document:</strong> ${escapeHtml((linkData && linkData.sourceDocumentNumber) || "Not provided")}
      </p>
      <p class="link-label">Unique URL:</p>
      <p><code>${escapeHtml(publicUrl)}</code></p>
      <p><a href="/">Back to links list</a></p>
      <p class="hint">Open this link on a phone and use the camera button below.</p>

      ${uploaded ? '<p class="ok">Upload successful.</p>' : ""}
      ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}

      <form method="post" action="/u/${encodeURIComponent(linkId)}/upload" enctype="multipart/form-data">
        <input id="photos" name="photos" type="file" accept="image/*" capture="environment" multiple required />
        <button id="cameraButton" type="button">Make a photo</button>
        <button type="submit">Upload</button>
      </form>

      <h2>Uploaded Photos</h2>
      <ul class="photo-grid">
        ${photoList}
      </ul>
    </main>
    <dialog id="photoDialog" class="photo-dialog">
      <div class="photo-dialog-content">
        <button id="closePhotoDialog" class="close-dialog" type="button" aria-label="Close full size image">Close</button>
        <img id="dialogPhotoImage" alt="Full size uploaded photo" />
      </div>
    </dialog>
    <script>
      const fileInput = document.getElementById("photos");
      const cameraButton = document.getElementById("cameraButton");
      const photoDialog = document.getElementById("photoDialog");
      const photoDialogContent = photoDialog.querySelector(".photo-dialog-content");
      const dialogPhotoImage = document.getElementById("dialogPhotoImage");
      const closePhotoDialog = document.getElementById("closePhotoDialog");
      const openPhotoButtons = document.querySelectorAll(".open-photo-button");

      cameraButton.addEventListener("click", () => {
        // iOS Safari requires direct user gesture to open camera/file chooser.
        fileInput.click();
      });

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
      <h1>Link not found</h1>
      <p>This upload link does not exist or has expired.</p>
      <a href="/">Create a new upload link</a>
    </main>
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
