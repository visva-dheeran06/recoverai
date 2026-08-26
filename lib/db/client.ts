/**
 * SQLite database client — server-side only.
 *
 * Uses better-sqlite3 (synchronous, no server required) as the minimum
 * viable persistence layer for M2 webhook event storage.
 *
 * The database file is created at `./data/recoverai.db` relative to the
 * project root, which is outside the Next.js `.next` build directory and
 * is excluded from version control via .gitignore.
 *
 * MUST NOT be imported in any browser-side code.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "recoverai.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    // Ensure the data directory exists.
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    _db = new Database(DB_PATH);

    // Enable WAL mode for better concurrent read performance.
    _db.pragma("journal_mode = WAL");

    // Enforce foreign key constraints.
    _db.pragma("foreign_keys = ON");

    // Initialise schema on first connection.
    initSchema(_db);
  }

  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL UNIQUE,
      event_type       TEXT NOT NULL,
      related_entity_id TEXT,
      received_at      TEXT NOT NULL,
      signature_verified INTEGER NOT NULL DEFAULT 1,
      raw_payload      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id
      ON webhook_events (event_id);

    CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
      ON webhook_events (event_type);

    CREATE INDEX IF NOT EXISTS idx_webhook_events_related_entity_id
      ON webhook_events (related_entity_id);
  `);
}
