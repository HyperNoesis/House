// restore.js — restores a backup produced by backup.js.
//
// DESTRUCTIVE by default: it overwrites whatever database it points at.
// Requires --force to actually run, as a guard against fat-fingering
// this against production.
//
// Usage:
//   node src/restore.js --force [--file path/to/backup] [--into path-or-url]
//
//   --file   which backup to restore (default: the most recent one in
//            BACKUP_DIR)
//   --into   SQLite: an alternate file path to restore into, instead of
//            ILE_DB_PATH (used by the restore drill so it never touches
//            your real database).
//            Postgres: an alternate DATABASE_URL to restore into, instead
//            of the live one (used by the drill for the same reason).

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { force: false, file: null, into: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--into") args.into = argv[++i];
  }
  return args;
}

function findLatestBackup(dir, ext) {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("ile-backup-") && f.endsWith(ext)).sort();
  if (!files.length) throw new Error(`No backups found in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}

async function restoreSqlite(backupFile, targetPath) {
  if (!fs.existsSync(backupFile)) throw new Error(`Backup file not found: ${backupFile}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(backupFile, targetPath);
  console.log(`  restored ${backupFile} -> ${targetPath}`);
}

async function restorePostgres(backupFile, databaseUrl) {
  const dump = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false } });

  // Truncate children-first (reverse of the dump's parent-first order) so
  // no foreign key is violated mid-wipe, then re-insert parent-first.
  const tableNames = Object.keys(dump.tables);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of [...tableNames].reverse()) {
      await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    }
    for (const table of tableNames) {
      const rows = dump.tables[table];
      for (const row of rows) {
        const cols = Object.keys(row);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`, cols.map((c) => row[c]));
      }
      if (rows.length) {
        // Explicit-id inserts don't advance the SERIAL sequence — fix it
        // so the next real INSERT doesn't collide with a restored id.
        await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
      }
      console.log(`  restored ${rows.length} rows into ${table}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.force) {
    console.error("Refusing to restore without --force (this overwrites the target database).");
    process.exit(1);
  }

  const usingPostgres = !!(args.into ? args.into.startsWith("postgres") : process.env.DATABASE_URL);
  const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
  const ext = usingPostgres ? ".json" : ".db";
  const backupFile = args.file || findLatestBackup(BACKUP_DIR, ext);

  console.log(`Restoring ${usingPostgres ? "Postgres" : "SQLite"} from ${backupFile}...`);
  if (usingPostgres) {
    await restorePostgres(backupFile, args.into || process.env.DATABASE_URL);
  } else {
    const targetPath = args.into || process.env.ILE_DB_PATH || path.join(__dirname, "..", "data", "ile.db");
    await restoreSqlite(backupFile, targetPath);
  }
  console.log("Restore complete.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Restore failed:", err.message);
    process.exit(1);
  });
}

module.exports = { restoreSqlite, restorePostgres, findLatestBackup };
