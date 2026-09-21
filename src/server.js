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
    let conversation = await get("SELECT * FROM conversations WHERE property_id = ? AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))", [
      body.propertyId, auth.sub, property.owner_id, property.owner_id, auth.sub,
    ]);
    if (!conversation) {
      const { lastInsertRowid: convId } = await run(
        "INSERT INTO conversations (property_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)",
        [body.propertyId, auth.sub, property.owner_id, now()]
      );
      conversation = { id: convId };
    }
    await run("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)", [conversation.id, auth.sub, body.message, now()]);
    sendToUser(property.owner_id, { type: "message", conversationId: conversation.id, message: { conversation_id: conversation.id, sender_id: auth.sub, body: body.message, created_at: now() } });

    return serializeLead(await get("SELECT * FROM leads WHERE id = ?", [lastInsertRowid]));
  });
  send(res, 201, lead);
}

async function handleUpdateLead(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  const allowed = ["New", "Contacted", "Closed"];
  if (body.status && !allowed.includes(body.status)) return send(res, 400, { error: `status must be one of: ${allowed.join(", ")}` });
  const lead = await get("SELECT * FROM leads WHERE id = ?", [id]);
  if (!lead) return send(res, 404, { error: "Lead not found" });
  const property = await get("SELECT * FROM properties WHERE id = ?", [lead.property_id]);
  if (!property || (property.owner_id !== auth.sub && auth.role !== "admin")) return send(res, 403, { error: "Not your lead to update" });
  if (body.status) await run("UPDATE leads SET status = ? WHERE id = ?", [body.status, id]);
  send(res, 200, serializeLead(await get("SELECT * FROM leads WHERE id = ?", [id])));
}

// ================= REPORTS / MODERATION =================

async function handleCreateReport(req, res) {
  const body = await readBody(req);
  if (!body.propertyId || !body.reason) return send(res, 400, { error: "propertyId and reason are required" });
  const auth = authenticate(req); // reports may be filed anonymously
  const { lastInsertRowid } = await run(
    "INSERT INTO reports (property_id, reason, reported_by_user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    [body.propertyId, body.reason, auth ? auth.sub : null, now()]
  );
  send(res, 201, { message: "Report submitted for moderator review", report: await get("SELECT * FROM reports WHERE id = ?", [lastInsertRowid]) });
}

async function handleListAdminReports(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== "admin") return send(res, 403, { error: "Admin access required" });
  send(res, 200, await all("SELECT * FROM reports ORDER BY created_at DESC"));
}

async function handleAdminVerify(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== "admin") return send(res, 403, { error: "Admin access required" });
  const body = await readBody(req);
  const field = body.field;
  const columns = { identity: "verify_identity", property: "verify_property", location: "verify_location" };
  if (!columns[field]) return send(res, 400, { error: "field must be identity, property, or location" });

  const property = await get("SELECT * FROM properties WHERE id = ?", [id]);
  if (!property) return send(res, 404, { error: "Property not found" });
  await run(`UPDATE properties SET ${columns[field]} = ? WHERE id = ?`, [body.value ? 1 : 0, id]);
  const updated = await get("SELECT * FROM properties WHERE id = ?", [id]);
  const verified = updated.verify_identity && updated.verify_property ? 1 : 0; // location is a bonus signal, not required
  await run("UPDATE properties SET verified = ? WHERE id = ?", [verified, id]);
  send(res, 200, serializeProperty(await get("SELECT * FROM properties WHERE id = ?", [id])));
}

// ================= NOTIFICATIONS / EARNINGS =================

async function handleNotifications(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const leadNotifs = (await all(
    `SELECT l.id, l.status, l.created_at, l.name, p.title FROM leads l JOIN properties p ON p.id = l.property_id WHERE p.owner_id = ? ORDER BY l.created_at DESC LIMIT 30`,
    [auth.sub]
  )).map((l) => ({
    id: `lead-${l.id}`,
    type: "lead",
    title: `${l.name} ${l.status === "New" ? "sent a new enquiry about" : `is now "${l.status}" for`} ${l.title}`,
    time: new Date(l.created_at).toISOString(),
  }));

  const messageNotifs = (await all(
    `SELECT m.id, m.body, m.created_at, u.name as sender_name FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     JOIN users u ON u.id = m.sender_id
     WHERE (c.user_a = ? OR c.user_b = ?) AND m.sender_id != ?
     ORDER BY m.created_at DESC LIMIT 30`,
    [auth.sub, auth.sub, auth.sub]
  )).map((m) => ({
    id: `msg-${m.id}`,
    type: "message",
    title: `${m.sender_name}: ${m.body.slice(0, 60)}${m.body.length > 60 ? "…" : ""}`,
    time: new Date(m.created_at).toISOString(),
  }));

  const alertNotifs = (await all(
    `SELECT sa.id, sa.match_score, sa.created_at, p.title FROM search_alerts sa JOIN properties p ON p.id = sa.property_id WHERE sa.user_id = ? ORDER BY sa.created_at DESC LIMIT 30`,
    [auth.sub]
  )).map((a) => ({
    id: `alert-${a.id}`,
    type: "alert",
    title: `New ${a.match_score}% match for your saved search: ${a.title}`,
    time: new Date(a.created_at).toISOString(),
  }));

  const combined = [...leadNotifs, ...messageNotifs, ...alertNotifs].sort((a, b) => new Date(b.time) - new Date(a.time));
  send(res, 200, combined);
}

async function handleListSavedSearches(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  send(res, 200, await all("SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC", [auth.sub]));
}

async function handleCreateSavedSearch(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  if (!body.query) return send(res, 400, { error: "query is required" });
  const { lastInsertRowid } = await run("INSERT INTO saved_searches (user_id, query, created_at) VALUES (?, ?, ?)", [auth.sub, body.query, now()]);
  send(res, 201, await get("SELECT * FROM saved_searches WHERE id = ?", [lastInsertRowid]));
}

async function handleDeleteSavedSearch(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const row = await get("SELECT * FROM saved_searches WHERE id = ?", [id]);
  if (!row) return send(res, 404, { error: "Not found" });
  if (row.user_id !== auth.sub) return send(res, 403, { error: "Not your saved search" });
  await run("DELETE FROM saved_searches WHERE id = ?", [id]);
  send(res, 204, {});
}

async function handleEarnings(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const rows = await all(
    `SELECT l.id, p.price_value FROM leads l JOIN properties p ON p.id = l.property_id WHERE p.owner_id = ? AND l.status = 'Closed'`,
    [auth.sub]
  );
  const total = rows.reduce((sum, r) => sum + r.price_value * 1_000_000 * COMMISSION_RATE, 0);
  send(res, 200, {
    currency: "NGN",
    totalFromClosedLeads: Math.round(total),
    closedLeadCount: rows.length,
    commissionRate: COMMISSION_RATE,
    live: false,
    paymentProvider: null,
    note: "This figure is computed live from real closed leads in the database — it is not a hardcoded placeholder. It is not withdrawable: no payment processor (e.g. Paystack, Flutterwave) is connected yet. Wiring one requires real merchant credentials, which only you can provide.",
  });
}

// ================= SOCIAL LAYER =================

async function serializePost(row, viewerId) {
  const likeCount = (await get("SELECT COUNT(*) as n FROM likes WHERE post_id = ?", [row.id])).n;
  const commentCount = (await get("SELECT COUNT(*) as n FROM comments WHERE post_id = ?", [row.id])).n;
  const liked = viewerId ? !!(await get("SELECT id FROM likes WHERE post_id = ? AND user_id = ?", [row.id, viewerId])) : false;
  const saved = viewerId ? !!(await get("SELECT id FROM saves WHERE post_id = ? AND user_id = ?", [row.id, viewerId])) : false;
  const author = await get("SELECT id, name, tier FROM users WHERE id = ?", [row.author_id]);
  const authorFollowing = viewerId && viewerId !== row.author_id
    ? !!(await get("SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?", [viewerId, row.author_id]))
    : false;
  const property = row.property_id ? await get("SELECT id, title FROM properties WHERE id = ?", [row.property_id]) : null;
  return {
    id: row.id,
    type: row.type,
    caption: row.caption,
    mediaUrl: row.media_url,
    createdAt: row.created_at,
    author,
    authorFollowing,
    property,
    likeCount,
    commentCount,
    liked,
    saved,
  };
}

async function handleListPosts(req, res, query) {
  const auth = authenticate(req); // optional — like/save state only shows if signed in
  const type = query.type === "short" ? "short" : query.type === "post" ? "post" : null;
  const authorId = query.authorId ? Number(query.authorId) : null;
  const clauses = ["status = 'active'"];
  const params = [];
  if (type) { clauses.push("type = ?"); params.push(type); }
  if (authorId) { clauses.push("author_id = ?"); params.push(authorId); }
  const rows = await all(`SELECT * FROM posts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 50`, params);
  send(res, 200, await Promise.all(rows.map((r) => serializePost(r, auth ? auth.sub : null))));
}

async function handleCreatePost(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  const type = body.type === "short" ? "short" : "post";
  if (!body.caption && !body.mediaUrl) return send(res, 400, { error: "caption or mediaUrl is required" });
  const { lastInsertRowid } = await run(
    "INSERT INTO posts (author_id, type, caption, property_id, media_url, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    [auth.sub, type, body.caption || "", body.propertyId || null, body.mediaUrl || null, now()]
  );
  send(res, 201, await serializePost(await get("SELECT * FROM posts WHERE id = ?", [lastInsertRowid]), auth.sub));
}

async function handleToggleLike(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const existing = await get("SELECT id FROM likes WHERE post_id = ? AND user_id = ?", [id, auth.sub]);
  if (existing) {
    await run("DELETE FROM likes WHERE id = ?", [existing.id]);
    return send(res, 200, { liked: false });
  }
  await run("INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)", [id, auth.sub, now()]);
  send(res, 200, { liked: true });
}

async function handleToggleSave(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const existing = await get("SELECT id FROM saves WHERE post_id = ? AND user_id = ?", [id, auth.sub]);
  if (existing) {
    await run("DELETE FROM saves WHERE id = ?", [existing.id]);
    return send(res, 200, { saved: false });
  }
  await run("INSERT INTO saves (post_id, user_id, created_at) VALUES (?, ?, ?)", [id, auth.sub, now()]);
  send(res, 200, { saved: true });
}

async function handleListComments(req, res, id) {
  const rows = await all(
    `SELECT c.id, c.body, c.created_at, u.id as user_id, u.name as user_name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.created_at ASC`,
    [id]
  );
  send(res, 200, rows);
}

async function handleCreateComment(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  if (!body.body) return send(res, 400, { error: "body is required" });
  const { lastInsertRowid } = await run("INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)", [id, auth.sub, body.body, now()]);
  send(res, 201, await get("SELECT * FROM comments WHERE id = ?", [lastInsertRowid]));
}

async function handleToggleFollow(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (Number(id) === auth.sub) return send(res, 400, { error: "Can't follow yourself" });
  const existing = await get("SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?", [auth.sub, id]);
  if (existing) {
    await run("DELETE FROM follows WHERE id = ?", [existing.id]);
    return send(res, 200, { following: false });
  }
  await run("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)", [auth.sub, id, now()]);
  send(res, 200, { following: true });
}

async function handleListUsers(req, res, query) {
  const auth = authenticate(req);
  const role = query.role;
  const rows = role
    ? await all("SELECT id, name, role, tier, created_at FROM users WHERE role = ? ORDER BY created_at DESC LIMIT 50", [role])
    : await all("SELECT id, name, role, tier, created_at FROM users ORDER BY created_at DESC LIMIT 50");
  const withCounts = await Promise.all(rows.map(async (u) => {
    const followerCount = (await get("SELECT COUNT(*) as n FROM follows WHERE followee_id = ?", [u.id])).n;
    const isFollowing = auth ? !!(await get("SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?", [auth.sub, u.id])) : false;
    return { ...u, followerCount, isFollowing };
  }));
  send(res, 200, withCounts);
}

async function handleGetUserProfile(req, res, id) {
  const auth = authenticate(req);
  const user = await get("SELECT id, name, role, tier, created_at FROM users WHERE id = ?", [id]);
  if (!user) return send(res, 404, { error: "User not found" });
  const followerCount = (await get("SELECT COUNT(*) as n FROM follows WHERE followee_id = ?", [id])).n;
  const followingCount = (await get("SELECT COUNT(*) as n FROM follows WHERE follower_id = ?", [id])).n;
  const isFollowing = auth ? !!(await get("SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?", [auth.sub, id])) : false;
  const listings = user.role === "professional" ? (await all("SELECT * FROM properties WHERE owner_id = ? AND status != 'removed'", [id])).map((p) => serializeProperty(p)) : [];
  send(res, 200, { ...user, followerCount, followingCount, isFollowing, listings });
}

// ================= MESSAGING =================

async function handleListConversations(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const rows = await all(
    `SELECT c.*, p.title as property_title,
            (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
            (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at
     FROM conversations c LEFT JOIN properties p ON p.id = c.property_id
     WHERE c.user_a = ? OR c.user_b = ?
     ORDER BY last_message_at DESC`,
    [auth.sub, auth.sub]
  );
  const withOther = await Promise.all(rows.map(async (c) => {
    const otherId = c.user_a === auth.sub ? c.user_b : c.user_a;
    const other = await get("SELECT id, name FROM users WHERE id = ?", [otherId]);
    return { id: c.id, propertyId: c.property_id, propertyTitle: c.property_title, otherUser: other, lastMessage: c.last_message, lastMessageAt: c.last_message_at };
  }));
  send(res, 200, withOther);
}

async function handleCreateConversation(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = await readBody(req);
  if (!body.otherUserId) return send(res, 400, { error: "otherUserId is required" });
  let conversation = await get(
    "SELECT * FROM conversations WHERE (property_id IS ? OR property_id = ?) AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))",
    [body.propertyId || null, body.propertyId || null, auth.sub, body.otherUserId, body.otherUserId, auth.sub]
  );
  if (!conversation) {
    const { lastInsertRowid } = await run("INSERT INTO conversations (property_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)", [body.propertyId || null, auth.sub, body.otherUserId, now()]);
    conversation = await get("SELECT * FROM conversations WHERE id = ?", [lastInsertRowid]);
  }
  send(res, 201, conversation);
}

async function handleListMessages(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const conversation = await get("SELECT * FROM conversations WHERE id = ?", [id]);
  if (!conversation) return send(res, 404, { error: "Conversation not found" });
  if (conversation.user_a !== auth.sub && conversation.user_b !== auth.sub) return send(res, 403, { error: "Not your conversation" });

  // Mark the other person's messages as read now that this user has
  // opened the thread, and tell them live so their UI can show "Seen".
  const justRead = await all("SELECT id FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL", [id, auth.sub]);
  if (justRead.length) {
    await run("UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL", [now(), id, auth.sub]);
    const otherUserId = conversation.user_a === auth.sub ? conversation.user_b : conversation.user_a;
    sendToUser(otherUserId, { type: "read", conversationId: id, messageIds: justRead.map((m) => m.id) });
  }

  const messages = await all("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC", [id]);
  send(res, 200, messages);
}

async function handleSendMessage(req, res, id) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const conversation = await get("SELECT * FROM conversations WHERE id = ?", [id]);
  if (!conversation) return send(res, 404, { error: "Conversation not found" });
  if (conversation.user_a !== auth.sub && conversation.user_b !== auth.sub) return send(res, 403, { error: "Not your conversation" });
  const body = await readBody(req);
  if (!body.body) return send(res, 400, { error: "body is required" });
  const { lastInsertRowid } = await run("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)", [id, auth.sub, body.body, now()]);
  const message = await get("SELECT * FROM messages WHERE id = ?", [lastInsertRowid]);

  const otherUserId = conversation.user_a === auth.sub ? conversation.user_b : conversation.user_a;
  sendToUser(otherUserId, { type: "message", conversationId: id, message });

  send(res, 201, message);
}

// ================= ROUTER =================

const routes = [
  { method: "POST", pattern: /^\/api\/auth\/signup$/, handler: handleSignup },
  { method: "POST", pattern: /^\/api\/auth\/login$/, handler: handleLogin },
  { method: "GET", pattern: /^\/api\/auth\/me$/, handler: handleMe },

  { method: "GET", pattern: /^\/api\/properties$/, handler: (req, res, _id, query) => handleListProperties(req, res, query) },
  { method: "POST", pattern: /^\/api\/properties$/, handler: handleCreateProperty },
  { method: "GET", pattern: /^\/api\/properties\/(\d+)$/, handler: (req, res, id) => handleGetProperty(req, res, Number(id)) },
  { method: "GET", pattern: /^\/api\/neighborhoods$/, handler: (req, res, _id, query) => handleGetNeighborhood(req, res, query) },
  { method: "POST", pattern: /^\/api\/properties\/(\d+)\/media$/, handler: (req, res, id) => handleAddMedia(req, res, Number(id)) },
  { method: "DELETE", pattern: /^\/api\/properties\/(\d+)\/media\/(\d+)$/, handler: (req, res, id, query, mediaId) => handleDeleteMedia(req, res, Number(id), Number(mediaId)) },
  { method: "PATCH", pattern: /^\/api\/properties\/(\d+)$/, handler: (req, res, id) => handleUpdateProperty(req, res, Number(id)) },
  { method: "DELETE", pattern: /^\/api\/properties\/(\d+)$/, handler: (req, res, id) => handleDeleteProperty(req, res, Number(id)) },
  { method: "POST", pattern: /^\/api\/properties\/(\d+)\/save$/, handler: (req, res, id) => handleSaveProperty(req, res, Number(id)) },
  { method: "GET", pattern: /^\/api\/me\/saved-properties$/, handler: handleMySavedProperties },

  { method: "POST", pattern: /^\/api\/search$/, handler: handleSearch },

  { method: "GET", pattern: /^\/api\/requests$/, handler: handleListRequests },
  { method: "POST", pattern: /^\/api\/requests$/, handler: handleCreateRequest },

  { method: "GET", pattern: /^\/api\/leads$/, handler: handleListLeads },
  { method: "POST", pattern: /^\/api\/leads$/, handler: handleCreateLead },
  { method: "PATCH", pattern: /^\/api\/leads\/(\d+)$/, handler: (req, res, id) => handleUpdateLead(req, res, Number(id)) },

  { method: "POST", pattern: /^\/api\/reports$/, handler: handleCreateReport },
  { method: "GET", pattern: /^\/api\/admin\/reports$/, handler: handleListAdminReports },
  { method: "PATCH", pattern: /^\/api\/admin\/properties\/(\d+)\/verify$/, handler: (req, res, id) => handleAdminVerify(req, res, Number(id)) },

  { method: "GET", pattern: /^\/api\/notifications$/, handler: handleNotifications },
  { method: "GET", pattern: /^\/api\/saved-searches$/, handler: handleListSavedSearches },
  { method: "POST", pattern: /^\/api\/saved-searches$/, handler: handleCreateSavedSearch },
  { method: "DELETE", pattern: /^\/api\/saved-searches\/(\d+)$/, handler: (req, res, id) => handleDeleteSavedSearch(req, res, Number(id)) },
  { method: "GET", pattern: /^\/api\/earnings$/, handler: handleEarnings },

  { method: "GET", pattern: /^\/api\/posts$/, handler: (req, res, _id, query) => handleListPosts(req, res, query) },
  { method: "POST", pattern: /^\/api\/posts$/, handler: handleCreatePost },
  { method: "POST", pattern: /^\/api\/posts\/(\d+)\/like$/, handler: (req, res, id) => handleToggleLike(req, res, Number(id)) },
  { method: "POST", pattern: /^\/api\/posts\/(\d+)\/save$/, handler: (req, res, id) => handleToggleSave(req, res, Number(id)) },
  { method: "GET", pattern: /^\/api\/posts\/(\d+)\/comments$/, handler: (req, res, id) => handleListComments(req, res, Number(id)) },
  { method: "POST", pattern: /^\/api\/posts\/(\d+)\/comments$/, handler: (req, res, id) => handleCreateComment(req, res, Number(id)) },

  { method: "POST", pattern: /^\/api\/users\/(\d+)\/follow$/, handler: (req, res, id) => handleToggleFollow(req, res, Number(id)) },
  { method: "GET", pattern: /^\/api\/users$/, handler: (req, res, _id, query) => handleListUsers(req, res, query) },
  { method: "GET", pattern: /^\/api\/users\/(\d+)$/, handler: (req, res, id) => handleGetUserProfile(req, res, Number(id)) },

  { method: "GET", pattern: /^\/api\/conversations$/, handler: handleListConversations },
  { method: "POST", pattern: /^\/api\/conversations$/, handler: handleCreateConversation },
  { method: "GET", pattern: /^\/api\/conversations\/(\d+)\/messages$/, handler: (req, res, id) => handleListMessages(req, res, Number(id)) },
  { method: "POST", pattern: /^\/api\/conversations\/(\d+)\/messages$/, handler: (req, res, id) => handleSendMessage(req, res, Number(id)) },

  { method: "POST", pattern: /^\/api\/upload$/, handler: (req, res) => handleUpload(req, res, send) },
];

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (rateLimited(req)) return send(res, 429, { error: "Too many requests, slow down" });

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/uploads/")) return serveUpload(req, res, url.pathname.replace("/uploads/", ""));
  if (url.pathname === "/health") return send(res, 200, { ok: true, time: new Date().toISOString() });

  const query = Object.fromEntries(url.searchParams);
  const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));

  if (!route) {
    // Not an API route: serve the built frontend (if present) instead of a
    // bare 404. This lets one deployed service serve both the API and the
    // web app — no separate static host or cross-origin setup required.
    if (req.method === "GET" && serveFrontend(req, res, url.pathname)) return;
    return send(res, 404, { error: "Not found" });
  }

  const match = url.pathname.match(route.pattern);
  const id = match && match[1];
  const id2 = match && match[2];

  try {
    await route.handler(req, res, id, query, id2);
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: err.message || "Internal server error" });
  }
});

server.on("upgrade", (req, socket) => {
  if (new URL(req.url, "http://placeholder").pathname === "/ws") {
    handleUpgrade(req, socket, verify);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Ilé backend listening on http://localhost:${PORT}`);
  console.log(`Try:  curl http://localhost:${PORT}/api/properties`);
});

module.exports = { server };
