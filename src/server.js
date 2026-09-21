// server.js — the whole REST API on Node's built-in http module, backed
// by real SQLite storage (see db.js). Zero npm dependencies: `node
// src/server.js` just works, anywhere Node 22+ is installed.
//
// Endpoints (full reference with examples in README.md):
//   Auth:          POST /api/auth/signup, /api/auth/login, GET /api/auth/me
//   Properties:    GET/POST /api/properties, GET/PATCH/DELETE /api/properties/:id
//                  POST /api/properties/:id/save (toggle saved), GET /api/me/saved-properties
//   Search:        POST /api/search              (real ranking, optional LLM parse — see search.js)
//   Requests:      GET/POST /api/requests         (reverse marketplace)
//   Leads:         GET/POST /api/leads, PATCH /api/leads/:id
//   Reports:       POST /api/reports, GET /api/admin/reports (admin only)
//   Verification:  PATCH /api/admin/properties/:id/verify (admin only)
//   Notifications: GET /api/notifications          (derived from real data)
//   Earnings:      GET /api/earnings                (computed, not hardcoded)
//   Social:        GET/POST /api/posts, POST /api/posts/:id/like|save,
//                  GET/POST /api/posts/:id/comments,
//                  POST /api/users/:id/follow, GET /api/users/:id
//   Messaging:     GET/POST /api/conversations, GET/POST /api/conversations/:id/messages
//   Uploads:       POST /api/upload, GET /uploads/:file (static)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { all, get, run, transaction, now } = require("./db");
const { hashPassword, verifyPassword, issueToken, verify } = require("./auth");
const { rankProperties } = require("./search");
const { handleUpload, serveUpload, deleteFile } = require("./upload");
const { handleUpgrade, sendToUser } = require("./ws");
const { lookupNeighborhood } = require("./neighborhoods");

const FRONTEND_DIST = process.env.ILE_FRONTEND_DIST || path.join(__dirname, "..", "..", "frontend", "dist");
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".ico": "image/x-icon" };

// Serves the built frontend if it exists (frontend/dist after `npm run
// build`). Falls back to index.html for any unmatched path so client-side
// routing works. Returns true if it handled the request, false otherwise
// (e.g. dist/ doesn't exist — local API-only dev is unaffected).
function serveFrontend(req, res, pathname) {
  if (!fs.existsSync(FRONTEND_DIST)) return false;
  let filePath = path.join(FRONTEND_DIST, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(FRONTEND_DIST)) return false; // path traversal guard
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(FRONTEND_DIST, "index.html");
  }
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const PORT = process.env.PORT || 4000;
const COMMISSION_RATE = 0.15;
const ALLOWED_ORIGIN = process.env.ILE_CORS_ORIGIN || "*"; // restrict this in production

// ---------- tiny helpers ----------

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2e6) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function authenticate(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verify(token); // null if missing/invalid/expired
}

function requireAuth(req, res) {
  const user = authenticate(req);
  if (!user) {
    send(res, 401, { error: "Sign in required" });
    return null;
  }
  return user;
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function safeUser(row) {
  if (!row) return null;
  const { password, ...rest } = row;
  return rest;
}

function serializeProperty(p, extra = {}) {
  return {
    id: p.id,
    ownerId: p.owner_id,
    title: p.title,
    location: p.location,
    lat: p.lat,
    lng: p.lng,
    priceValue: p.price_value,
    price: `₦${p.price_value}m`,
    period: p.period,
    beds: p.beds,
    baths: p.baths,
    tag: p.tag,
    status: p.status,
    verified: !!p.verified,
    verification: { identity: !!p.verify_identity, property: !!p.verify_property, location: !!p.verify_location },
    amenities: typeof p.amenities === "string" ? JSON.parse(p.amenities) : p.amenities,
    description: p.description,
    gradientSeed: p.gradient_seed,
    coverImageUrl: p.cover_image_url,
    createdAt: p.created_at,
    ...extra,
  };
}

// very small per-IP rate limiter — production would use a shared store
// (Redis) so it works across multiple server instances.
const hits = new Map();
function rateLimited(req) {
  const ip = req.socket.remoteAddress || "unknown";
  const nowMs = Date.now();
  const windowMs = 60_000;
  const max = 240;
  const entry = hits.get(ip) || { count: 0, resetAt: nowMs + windowMs };
  if (nowMs > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = nowMs + windowMs;
  }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > max;
}

// ================= AUTH =================

async function handleSignup(req, res) {
  const body = await readBody(req);
  const { name, email, password } = body;
  if (!name || !email || !password) return send(res, 400, { error: "name, email, and password are required" });
  if (password.length < 4) return send(res, 400, { error: "Password must be at least 4 characters" });
  const role = ["seeker", "professional"].includes(body.role) ? body.role : "seeker";

  if (await get("SELECT id FROM users WHERE lower(email) = lower(?)", [email])) {
    return send(res, 409, { error: "Email already registered" });
  }

  const { lastInsertRowid } = await run(
    "INSERT INTO users (name, email, password, role, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [name, email, hashPassword(password), role, role === "professional" ? "Newcomer" : null, now()]
  );
  const user = await get("SELECT * FROM users WHERE id = ?", [lastInsertRowid]);
  send(res, 201, { token: issueToken(user), user: safeUser(user) });
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const { email, password } = body;
  if (!email || !password) return send(res, 400, { error: "email and password are required" });
  const user = await get("SELECT * FROM users WHERE lower(email) = lower(?)", [email]);
  if (!user || !verifyPassword(password, user.password)) return send(res, 401, { error: "Invalid email or password" });
  send(res, 200, { token: issueToken(user), user: safeUser(user) });
}

async function handleMe(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const user = await get("SELECT * FROM users WHERE id = ?", [auth.sub]);
  if (!user) return send(res, 404, { error: "User not found" });
  send(res, 200, safeUser(user));
}

// ================= PROPERTIES =================

function handleListProperties(req, res, query) {
  const clauses = ["status != 'removed'"];
  const params = [];
  if (query.location) {
    clauses.push("lower(location) LIKE ?");
    params.push(`%${query.location.toLowerCase()}%`);
  }
  if (query.verified === "true") clauses.push("verified = 1");
  if (query.minBeds) {
    clauses.push("beds >= ?");
    params.push(Number(query.minBeds));
  }
  if (query.maxPrice) {
    clauses.push("price_value <= ?");
    params.push(Number(query.maxPrice));
  }
  if (query.ownerId) {
    clauses.push("owner_id = ?");
    params.push(Number(query.ownerId));
  }
  return all(`SELECT * FROM properties WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`, params).then((rows) => {
    send(res, 200, rows.map((p) => serializeProperty(p)));
  });
}

async function handleGetProperty(req, res, id) {
  const p = await get("SELECT * FROM properties WHERE id = ?", [id]);
  if (!p) return send(res, 404, { error: "Property not found" });
  const media = await all("SELECT url, kind FROM property_media WHERE property_id = ?", [id]);

  // Comparables: other active listings in the same city/area, used to
  // compute a real average — not a hardcoded "market rate".
  const areaWord = p.location.split(",")[0].trim();
  const comps = await all(
    "SELECT id, title, price_value, beds FROM properties WHERE id != ? AND status = 'active' AND location LIKE ?",
    [id, `%${areaWord}%`]
  );
  const sameBeds = comps.filter((row) => row.beds === p.beds);
  const avgPriceForBeds = sameBeds.length ? sameBeds.reduce((s, r) => s + r.price_value, 0) / sameBeds.length : null;

  send(res, 200, serializeProperty(p, {
    media,
    neighborhood: lookupNeighborhood(p.location),
    comparables: {
      areaSampleSize: comps.length,
      sameBedsSampleSize: sameBeds.length,
      avgPriceForBeds: avgPriceForBeds ? Math.round(avgPriceForBeds * 100) / 100 : null,
      percentVsAverage: avgPriceForBeds ? Math.round(((p.price_value - avgPriceForBeds) / avgPriceForBeds) * 100) : null,
    },
  }));
}

async function handleAddMedia(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const property = await get("SELECT * FROM properties WHERE id = ?", [id]);
  if (!property) return send(res, 404, { error: "Property not found" });
  if (property.owner_id !== auth.sub && auth.role !== "admin") return send(res, 403, { error: "Not your listing" });
  const body = await readBody(req);
  if (!body.url) return send(res, 400, { error: "url is required" });
  const { lastInsertRowid } = await run("INSERT INTO property_media (property_id, url, kind, created_at) VALUES (?, ?, ?, ?)", [id, body.url, body.kind || "image", now()]);
  send(res, 201, await get("SELECT * FROM property_media WHERE id = ?", [lastInsertRowid]));
}

async function handleDeleteMedia(req, res, propertyId, mediaId) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const property = await get("SELECT * FROM properties WHERE id = ?", [propertyId]);
  if (!property) return send(res, 404, { error: "Property not found" });
  if (property.owner_id !== auth.sub && auth.role !== "admin") return send(res, 403, { error: "Not your listing" });
  const media = await get("SELECT * FROM property_media WHERE id = ? AND property_id = ?", [mediaId, propertyId]);
  await run("DELETE FROM property_media WHERE id = ? AND property_id = ?", [mediaId, propertyId]);
  if (media) await deleteFile(path.basename(media.url)); // best-effort; a missing/already-gone file is not an error
  send(res, 204, {});
}

function handleGetNeighborhood(req, res, query) {
  const data = lookupNeighborhood(query.location || "");
  if (!data) return send(res, 404, { error: "No neighborhood data for that location" });
  send(res, 200, data);
}

async function handleCreateProperty(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== "professional" && auth.role !== "admin") {
    return send(res, 403, { error: "Only professional accounts can list properties" });
  }
  const body = await readBody(req);
  const required = ["title", "location", "priceValue", "beds", "baths"];
  const missing = required.filter((f) => body[f] === undefined || body[f] === null || body[f] === "");
  if (missing.length) return send(res, 400, { error: `Missing required fields: ${missing.join(", ")}` });
  if (typeof body.priceValue !== "number" || body.priceValue <= 0) return send(res, 400, { error: "priceValue must be a positive number" });

  const seeds = ["amber", "green", "rose", "blue"];
  const { lastInsertRowid } = await run(
    `INSERT INTO properties (owner_id, title, location, lat, lng, price_value, period, beds, baths, tag, status, verified, verify_identity, verify_property, verify_location, amenities, description, gradient_seed, cover_image_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', 'active', 0, 1, 0, 0, ?, ?, ?, ?, ?)`,
    [
      auth.sub, body.title, body.location, body.lat || null, body.lng || null, body.priceValue,
      body.period || "/year", body.beds, body.baths,
      JSON.stringify(Array.isArray(body.amenities) ? body.amenities : []),
      body.description || "", seeds[Math.floor(Math.random() * seeds.length)], body.coverImageUrl || null, now(),
    ]
  );
  const created = await get("SELECT * FROM properties WHERE id = ?", [lastInsertRowid]);
  await matchSavedSearches(created);
  send(res, 201, serializeProperty(created));
}

// Runs every saved search against a newly-created listing and fires a
// real alert (persisted + live push) for any strong match — this is
// what makes "saved search" mean something instead of just a bookmark.
async function matchSavedSearches(property) {
  const searches = await all("SELECT * FROM saved_searches");
  for (const s of searches) {
    try {
      const { ranked } = await rankProperties([property], s.query);
      const scored = ranked[0];
      if (scored && scored.match >= 70) {
        const { lastInsertRowid } = await run(
          "INSERT INTO search_alerts (saved_search_id, user_id, property_id, match_score, created_at) VALUES (?, ?, ?, ?, ?)",
          [s.id, s.user_id, property.id, scored.match, now()]
        );
        sendToUser(s.user_id, { type: "search_alert", alertId: lastInsertRowid, property: serializeProperty(property), match: scored.match, query: s.query });
      }
    } catch {
      // a single bad saved-search query should never block listing creation
    }
  }
}

async function handleUpdateProperty(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const existing = await get("SELECT * FROM properties WHERE id = ?", [id]);
  if (!existing) return send(res, 404, { error: "Property not found" });
  if (existing.owner_id !== auth.sub && auth.role !== "admin") return send(res, 403, { error: "Not your listing" });

  const body = await readBody(req);
  const fields = { title: body.title, location: body.location, price_value: body.priceValue, beds: body.beds, baths: body.baths, description: body.description, cover_image_url: body.coverImageUrl, tag: body.tag, status: body.status };
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
  }
  if (body.amenities !== undefined) {
    sets.push("amenities = ?");
    params.push(JSON.stringify(body.amenities));
  }
  if (sets.length) {
    params.push(id);
    await run(`UPDATE properties SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  send(res, 200, serializeProperty(await get("SELECT * FROM properties WHERE id = ?", [id])));
}

async function handleDeleteProperty(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const existing = await get("SELECT * FROM properties WHERE id = ?", [id]);
  if (!existing) return send(res, 404, { error: "Property not found" });
  if (existing.owner_id !== auth.sub && auth.role !== "admin") return send(res, 403, { error: "Not your listing" });
  await run("UPDATE properties SET status = 'removed' WHERE id = ?", [id]); // soft delete
  send(res, 204, {});
}

async function handleSaveProperty(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const existing = await get("SELECT id FROM saved_properties WHERE user_id = ? AND property_id = ?", [auth.sub, id]);
  if (existing) {
    await run("DELETE FROM saved_properties WHERE id = ?", [existing.id]);
    return send(res, 200, { saved: false });
  }
  await run("INSERT INTO saved_properties (user_id, property_id, created_at) VALUES (?, ?, ?)", [auth.sub, id, now()]);
  send(res, 200, { saved: true });
}

async function handleMySavedProperties(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const rows = await all(
    `SELECT p.* FROM properties p JOIN saved_properties s ON s.property_id = p.id WHERE s.user_id = ? ORDER BY s.created_at DESC`,
    [auth.sub]
  );
  send(res, 200, rows.map((p) => serializeProperty(p)));
}

// ================= SEARCH =================

async function handleSearch(req, res) {
  const body = await readBody(req);
  const rows = await all("SELECT * FROM properties WHERE status != 'removed'");
  const { ranked, parsed } = await rankProperties(rows, body.query || "");
  send(res, 200, { parsedFrom: body.query || "", parsed, results: ranked.map((p) => serializeProperty(p, { match: p.match, matchReasons: p.matchReasons, tradeoff: p.tradeoff })) });
}

// ================= REQUESTS (reverse marketplace) =================

async function handleListRequests(req, res) {
  const rows = await all("SELECT * FROM requests WHERE status != 'closed' ORDER BY created_at DESC");
  send(res, 200, rows);
}

async function handleCreateRequest(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  if (!body.description) return send(res, 400, { error: "description is required" });
  const { lastInsertRowid } = await run(
    "INSERT INTO requests (user_id, description, budget, location, beds, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
    [auth.sub, body.description, body.budget || null, body.location || null, body.beds || null, now()]
  );
  send(res, 201, await get("SELECT * FROM requests WHERE id = ?", [lastInsertRowid]));
}

// ================= LEADS =================

function serializeLead(l) {
  return { id: l.id, propertyId: l.property_id, fromUserId: l.from_user_id, name: l.name, message: l.message, status: l.status, createdAt: l.created_at };
}

async function handleListLeads(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const rows = auth.role === "admin"
    ? await all("SELECT * FROM leads ORDER BY created_at DESC")
    : await all(
        `SELECT l.* FROM leads l JOIN properties p ON p.id = l.property_id WHERE p.owner_id = ? ORDER BY l.created_at DESC`,
        [auth.sub]
      );
  send(res, 200, rows.map(serializeLead));
}

async function handleCreateLead(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  if (!body.propertyId || !body.message) return send(res, 400, { error: "propertyId and message are required" });
  const property = await get("SELECT * FROM properties WHERE id = ?", [body.propertyId]);
  if (!property) return send(res, 404, { error: "Property not found" });
  const fromUser = await get("SELECT * FROM users WHERE id = ?", [auth.sub]);

  const lead = await transaction(async () => {
    const { lastInsertRowid } = await run(
      "INSERT INTO leads (property_id, from_user_id, name, message, status, created_at) VALUES (?, ?, ?, ?, 'New', ?)",
      [body.propertyId, auth.sub, fromUser.name, body.message, now()]
    );

    // Contacting an agent also opens (or reuses) a real conversation
    // thread, seeded with the enquiry message — this is what makes
    // "Contact agent" more than a one-off ping into the void.
    let conversation = await get("SELECT * FROM conversations WHERE property_id = ? AND ((user_a = ? AND user_b