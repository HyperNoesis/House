// backup.js — creates a full database backup.
//
//   SQLite (no DATABASE_URL): uses SQLite's own `VACUUM INTO`, an atomic,
//   consistent snapshot into a single file — safe even while the app is
//   running and writing (unlike a raw file copy, which can catch a file
//   mid-write and land you a corrupt backup).
//
//   Postgres (DATABASE_URL set): dumps every table to a single JSON file.
//   This is intentionally NOT `pg_dump` — pg_dump requires the Postgres
//   client tools to be installed in whatever environment runs this
//   script, which most Node deploy images don't include by default. A
//   plain JSON dump needs nothing beyond the `pg` driver this app
//   already depends on, at the cost of being slower to restore on a
//   very large database. If your dataset outgrows this, switch to
//   `pg_dump -Fc` directly — the restore step in that case is
//   `pg_restore --clean --if-exists -d $DATABASE_URL backup.dump`.
//
// Usage:  node src/backup.js
// Env:    BACKUP_DIR (default backend/backups)
//         BACKUP_RETENTION (default 7 — older local backups are deleted)
//         S3_BUCKET (if set, the backup is also uploaded there for
//         off-site storage — the whole point of a backup is surviving
//         the loss of the machine it was taken on)

const fs = require("fs");
const path = require("path");

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const RETENTION = Number(process.env.BACKUP_RETENTION || 7);

// Same order as seed.js's delete list, reversed — parents before children,
// so a restore can re-insert in this order without hitting a foreign key
// that doesn't exist yet.
const TABLES_PARENT_FIRST = ["users", "properties", "property_media", "requests", "leads", "reports", "posts", "likes", "saves", "comments", "follows", "saved_properties", "conversations", "saved_searches", "search_alerts", "messages"];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function uploadToS3IfConfigured(filePath, filename) {
  if (!process.env.S3_BUCKET) return null;
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: process.env.S3_ACCESS_KEY_ID ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } : undefined,
  });
  const key = `${process.env.BACKUP_S3_PREFIX || "backups"}/${filename}`;
  await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: fs.readFileSync(filePath) }));
  return `s3://${process.env.S3_BUCKET}/${key}`;
}

function rotateOldBackups(ext) {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("ile-backup-") && f.endsWith(ext))
    .sort() // ISO timestamps in the filename sort chronologically as strings
    .reverse();
  for (const old of files.slice(RETENTION)) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
    console.log(`  pruned old backup: ${old}`);
  }
}

async function backupSqlite() {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = process.env.ILE_DB_PATH || path.join(__dirname, "..", "data", "ile.db");
  if (!fs.existsSync(dbPath)) throw new Error(`No database found at ${dbPath} — nothing to back up.`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true }); // self-contained: callers other than main() (e.g. the drill, tests) shouldn't have to remember this

  const filename = `ile-backup-${timestamp()}.db`;
  const outPath = path.join(BACKUP_DIR, filename);

  const db = new DatabaseSync(dbPath);
  // VACUUM INTO takes a string literal, not a bound parameter — escape
  // single quotes defensively even though this path is not user input.
  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  db.close();

  return { filename, outPath, ext: ".db" };
}

async function backupPostgres() {
  const { all } = require("./db");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dump = { takenAt: new Date().toISOString(), tables: {} };
  for (const table of TABLES_PARENT_FIRST) {
    dump.tables[table] = await all(`SELECT * FROM ${table}`);
  }

  const filename = `ile-backup-${timestamp()}.json`;
  const outPath = path.join(BACKUP_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(dump));

  return { filename, outPath, ext: ".json" };
}

async function main() {
  const usingPostgres = !!process.env.DATABASE_URL;

  console.log(`Backing up ${usingPostgres ? "Postgres" : "SQLite"} database...`);
  const { filename, outPath, ext } = usingPostgres ? await backupPostgres() : await backupSqlite();
  const sizeKb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`  wrote ${filename} (${sizeKb} KB)`);

  const s3Location = await uploadToS3IfConfigured(outPath, filename);
  if (s3Location) console.log(`  uploaded to ${s3Location}`);
  else if (usingPostgres) console.log("  S3_BUCKET not set — backup only exists on local disk. Set S3_BUCKET for off-site storage.");

  rotateOldBackups(ext);
  console.log("Backup complete.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Backup failed:", err.message);
    process.exit(1);
  });
}

module.exports = { TABLES_PARENT_FIRST, BACKUP_DIR, backupSqlite, backupPostgres, runBackup: main };
