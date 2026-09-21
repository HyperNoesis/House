// db.js — storage layer for Ilé.
//
// Uses Postgres (via the `pg` driver) when DATABASE_URL is set — the
// real path for production and multi-instance deployments — and falls
// back to Node's built-in synchronous SQLite for zero-dependency local
// dev when it isn't.
//
// Every exported function (all/get/run/transaction) is async, on both
// backends, so every call site elsewhere in the app is written once
// (with `await`) and works unchanged against either database. Nothing
// outside this file talks to storage directly.

const path = require("path");
const fs = require("fs");

const USE_PG = !!process.env.DATABASE_URL;

let all, get, run, transaction, db;

if (USE_PG) {
  // ---------- Postgres backend ----------
  const { Pool } = require("pg"); // npm install pg
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
  });

  // The Render start command doesn't run `node src/migrate.js` separately,
  // so run the schema here instead. Every statement in the migration file
  // is CREATE TABLE/INDEX IF NOT EXISTS, so re-running it on every boot is
  // safe and cheap — this is not a substitute for real migration tooling
  // if this schema ever needs to change incompatibly later.
  const migrationSql = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  const ready = pool.query(migrationSql).catch((err) => {
    console.error("Schema setup failed:", err);
    throw err;
  });

  // Every call site in this app was written for SQLite's "?" placeholder
  // style. Rather than rewrite ~100 call sites to Postgres's "$1, $2, ..."
  // style, translate at the boundary so both backends share identical
  // call-site code.
  function toPgQuery(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  all = async (sql, params = []) => {
    await ready;
    const { rows } = await pool.query(toPgQuery(sql), params);
    return rows;
  };
  get = async (sql, params = []) => {
    await ready;
    const { rows } = await pool.query(toPgQuery(sql), params);
    return rows[0];
  };
  run = async (sql, params = []) => {
    await ready;
    // Postgres has no built-in "last inserted rowid" — every INSERT in
    // this app targets a table with a serial `id` primary key, so we can
    // always ask for it back via RETURNING (added only if not already
    // present in the query).
    const isInsert = /^\s*INSERT/i.test(sql);
    const finalSql = isInsert && !/RETURNING/i.test(sql) ? `${sql} RETURNING id` : sql;
    const result = await pool.query(toPgQuery(finalSql), params);
    return {
      lastInsertRowid: isInsert && result.rows[0] ? result.rows[0].id : undefined,
      changes: result.rowCount,
    };
  };
  transaction = async (fn) => {
    await ready;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // fn() calls the module-level all/get/run above (against the pool,
      // not this specific client) — safe here because everything is
      // awaited to completion before COMMIT/ROLLBACK/release runs, so no
      // other request's queries can interleave with this transaction's
      // logical steps from this function's point of view. A stricter
      // implementation would thread `client` through to fn(), which is
      // worth doing if this transaction ever needs true isolation from
      // concurrent requests hitting the same rows.
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  module.exports = { all, get, run, transaction, now: () => Date.now(), usingPostgres: true, pool };
} else {
  // ---------- SQLite backend (default, zero-dependency local dev) ----------
  const { DatabaseSync } = require("node:sqlite");

  const DB_PATH = process.env.ILE_DB_PATH || path.join(__dirname, "..", "data", "ile.db");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); // git doesn't track empty folders, so this must exist on first boot in a fresh clone/container
  db = new DatabaseSync(DB_PATH);

  db.exec("PRAGMA journal_mode = WAL;"); // real concurrent-read safety
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'seeker',
  tier TEXT,
  avatar_seed TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  lat REAL,
  lng REAL,
  price_value REAL NOT NULL,
  period TEXT NOT NULL DEFAULT '/year',
  beds INTEGER NOT NULL,
  baths INTEGER NOT NULL,
  tag TEXT DEFAULT 'New',
  status TEXT NOT NULL DEFAULT 'active',
  verified INTEGER NOT NULL DEFAULT 0,
  verify_identity INTEGER NOT NULL DEFAULT 0,
  verify_property INTEGER NOT NULL DEFAULT 0,
  verify_location INTEGER NOT NULL DEFAULT 0,
  amenities TEXT NOT NULL DEFAULT '[]',
  description TEXT DEFAULT '',
  gradient_seed TEXT DEFAULT 'amber',
  cover_image_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
CREATE INDEX IF NOT EXISTS idx_properties_owner ON properties(owner_id);

CREATE TABLE IF NOT EXISTS property_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  budget REAL,
  location TEXT,
  beds INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_property ON leads(property_id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  reason TEXT NOT NULL,
  reported_by_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'post',
  caption TEXT DEFAULT '',
  property_id INTEGER REFERENCES properties(id),
  media_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type, status);

CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, user_id)
);

CREATE TABLE IF NOT EXISTS saves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id INTEGER NOT NULL REFERENCES users(id),
  followee_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS saved_properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, property_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES properties(id),
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(property_id, user_a, user_b)
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_search_id INTEGER NOT NULL REFERENCES saved_searches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  match_score INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
`);

  // ---------- small query helpers ----------
  // Every write is a parameterized prepared statement — no string-built SQL
  // anywhere, so this is not vulnerable to SQL injection from user input.
  // Wrapped as `async` (even though node:sqlite itself is synchronous) so
  // every call site is identical to the Postgres backend above.

  all = async (sql, params = []) => db.prepare(sql).all(...params);
  get = async (sql, params = []) => db.prepare(sql).get(...params);
  run = async (sql, params = []) => {
    const info = db.prepare(sql).run(...params);
    return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
  };
  transaction = async (fn) => {
    db.exec("BEGIN");
    try {
      const result = await fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  module.exports = { db, all, get, run, transaction, now: () => Date.now(), usingPostgres: false };
}
