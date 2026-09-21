// upload.js — real file uploads, parsed from raw multipart/form-data
// using only Node's Buffer API (no `multer`/`busboy` dependency).
//
// Storage is dual-mode, same pattern as db.js:
//   - No S3_BUCKET set  -> local disk (backend/uploads/), served back at
//     /uploads/<name>. Zero setup, good for local dev — but most PaaS
//     containers wipe local disk on every redeploy/restart, so this is
//     NOT safe for production.
//   - S3_BUCKET set     -> uploads go to S3 (or any S3-compatible store:
//     Cloudflare R2, DigitalOcean Spaces, Backblaze B2, Supabase Storage
//     all speak the S3 API — just point S3_ENDPOINT at them). The
//     returned URL is either your CDN in front of the bucket
//     (S3_PUBLIC_URL_BASE) or the bucket's own public URL.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".webm"]);
const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

const USE_S3 = !!process.env.S3_BUCKET;

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("File too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Parses a `multipart/form-data` body into a list of parts, each with
// `{ name, filename, contentType, data }`. `data` is a Buffer for file
// parts, or omitted (use `.value` instead, a string) for plain fields.
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    const rawPart = buffer.slice(start + boundaryBuf.length, next);
    const headerEnd = rawPart.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerText = rawPart.slice(0, headerEnd).toString("utf8");
      let body = rawPart.slice(headerEnd + 4);
      // strip the trailing \r\n before the next boundary
      if (body.slice(-2).toString() === "\r\n") body = body.slice(0, -2);

      const nameMatch = headerText.match(/name="([^"]+)"/);
      const filenameMatch = headerText.match(/filename="([^"]*)"/);
      const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);

      if (nameMatch) {
        parts.push({
          name: nameMatch[1],
          filename: filenameMatch ? filenameMatch[1] : null,
          contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
          data: body,
        });
      }
    }
    start = next;
  }
  return parts;
}

let saveFile, deleteFile, serveUpload;

if (USE_S3) {
  // ---------- S3 (or S3-compatible) backend ----------
  const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3"); // npm install @aws-sdk/client-s3

  const s3 = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined, // set for R2/Spaces/B2/etc.; leave unset for real AWS S3
    forcePathStyle: !!process.env.S3_ENDPOINT, // most S3-compatible providers need path-style addressing
    credentials: process.env.S3_ACCESS_KEY_ID ? {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    } : undefined, // undefined lets the SDK fall back to the environment/instance role, e.g. on EC2/ECS
  });

  function publicUrlFor(key) {
    if (process.env.S3_PUBLIC_URL_BASE) return `${process.env.S3_PUBLIC_URL_BASE.replace(/\/$/, "")}/${key}`;
    if (process.env.S3_ENDPOINT) return `${process.env.S3_ENDPOINT.replace(/\/$/, "")}/${process.env.S3_BUCKET}/${key}`;
    return `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION || "us-east-1"}.amazonaws.com/${key}`;
  }

  saveFile = async (filename, data, contentType) => {
    const key = `uploads/${filename}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
      // ACL intentionally omitted: most providers (and AWS's own current
      // guidance) expect a bucket policy granting public read on
      // uploads/*, rather than per-object ACLs.
    }));
    return publicUrlFor(key);
  };

  deleteFile = async (filename) => {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `uploads/${filename}` })).catch(() => {});
  };

  // Files are served directly from S3/CDN, not through this server.
  serveUpload = (req, res) => {
    res.writeHead(404);
    res.end("Uploads are served from object storage, not this server — check S3_PUBLIC_URL_BASE.");
  };
} else {
  // ---------- Local disk backend (default, zero-dependency local dev) ----------
  const UPLOAD_DIR = process.env.ILE_UPLOAD_DIR || path.join(__dirname, "..", "uploads");
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  saveFile = async (filename, data) => {
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), data);
    return `/uploads/${filename}`;
  };

  deleteFile = async (filename) => {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, filename)); } catch {}
  };

  // Static file server for anything already uploaded — intentionally
  // minimal (no range requests / caching headers), fine for local dev;
  // production should be on the S3 path above instead.
  serveUpload = (req, res, urlPath) => {
    const filename = path.basename(urlPath); // prevents path traversal
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filename).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(filePath).pipe(res);
  };
}

async function handleUpload(req, res, send) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!contentType.startsWith("multipart/form-data") || !boundaryMatch) {
    return send(res, 400, { error: "Expected multipart/form-data with a boundary" });
  }

  let buffer;
  try {
    buffer = await readRawBody(req, MAX_UPLOAD_BYTES);
  } catch (err) {
    return send(res, err.status || 400, { error: err.message });
  }

  const parts = parseMultipart(buffer, boundaryMatch[1]);
  const filePart = parts.find((p) => p.filename);
  if (!filePart) return send(res, 400, { error: "No file field found in upload" });

  const ext = path.extname(filePart.filename).toLowerCase() || ".bin";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return send(res, 400, { error: `File type ${ext} not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}` });
  }

  const safeName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  const url = await saveFile(safeName, filePart.data, MIME_BY_EXT[ext] || "application/octet-stream");

  send(res, 201, { url, kind: [".mp4", ".mov", ".webm"].includes(ext) ? "video" : "image" });
}

module.exports = { handleUpload, serveUpload, deleteFile, usingS3: USE_S3 };
