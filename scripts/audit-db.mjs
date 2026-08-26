/**
 * M2 Database Audit Script — reads actual persisted webhook_events rows.
 * Run with: node scripts/audit-db.mjs
 */
import Database from "better-sqlite3";
import { join } from "path";

const db = new Database(join(process.cwd(), "data", "recoverai.db"));

// ── 1. All rows (summary) ────────────────────────────────────────────────────
const allRows = db.prepare(
  "SELECT id, event_id, event_type, related_entity_id, received_at FROM webhook_events ORDER BY id ASC"
).all();

console.log("\n=== ALL webhook_events ROWS ===");
console.table(allRows);
console.log("Total rows:", allRows.length);

// ── 2. The three real successful events ──────────────────────────────────────
const realSuccessIds = ["TUJP9nIPXjjKHz", "TUJPAgMDIlHLPk", "TUJPBb9nJ07SCK"];
const realFailureId  = "TUJVP3og9VrG5n";

console.log("\n=== REAL SUCCESSFUL EVENT ROWS ===");
for (const eid of realSuccessIds) {
  const row = db.prepare(
    "SELECT id, event_id, event_type, related_entity_id, received_at FROM webhook_events WHERE event_id = ?"
  ).get(eid);
  if (row) {
    console.log(`\n[${eid}]`);
    console.log("  event_type       :", row.event_type);
    console.log("  related_entity_id:", row.related_entity_id);
    console.log("  received_at      :", row.received_at);
  } else {
    console.log(`\n[${eid}] — NOT FOUND IN DATABASE`);
  }
}

// ── 3. Real failure event ────────────────────────────────────────────────────
console.log("\n=== REAL FAILURE EVENT ROW ===");
{
  const row = db.prepare(
    "SELECT id, event_id, event_type, related_entity_id, received_at FROM webhook_events WHERE event_id = ?"
  ).get(realFailureId);
  if (row) {
    console.log(`[${realFailureId}]`);
    console.log("  event_type       :", row.event_type);
    console.log("  related_entity_id:", row.related_entity_id);
    console.log("  received_at      :", row.received_at);
  } else {
    console.log(`[${realFailureId}] — NOT FOUND IN DATABASE`);
  }
}

// ── 4. Inspect raw payloads for correlation fields ───────────────────────────
console.log("\n=== RAW PAYLOAD CORRELATION FIELDS ===");
for (const eid of realSuccessIds) {
  const row = db.prepare(
    "SELECT event_id, event_type, raw_payload FROM webhook_events WHERE event_id = ?"
  ).get(eid);
  if (!row) { console.log(`[${eid}] NOT FOUND`); continue; }

  let parsed;
  try { parsed = JSON.parse(row.raw_payload); } catch { console.log(`[${eid}] INVALID JSON`); continue; }

  const p = parsed.payload ?? {};
  const paymentId   = p?.payment?.entity?.id      ?? null;
  const orderId     = p?.payment?.entity?.order_id ?? null;
  const plinkId     = p?.payment_link?.entity?.id  ?? null;

  console.log(`\n[${eid}] ${row.event_type}`);
  console.log("  payload.payment.entity.id          :", paymentId);
  console.log("  payload.payment.entity.order_id    :", orderId);
  console.log("  payload.payment_link.entity.id     :", plinkId);
}

// ── 5. Uniqueness constraint check ──────────────────────────────────────────
console.log("\n=== SCHEMA UNIQUENESS CHECK ===");
const schema = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='webhook_events'"
).get();
const hasUnique = schema?.sql?.includes("UNIQUE") ?? false;
console.log("UNIQUE constraint on event_id in DDL:", hasUnique ? "YES ✅" : "NO ❌");
console.log("DDL:", schema?.sql);
