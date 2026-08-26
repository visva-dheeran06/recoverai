/**
 * Pre-M3 inspection: reads real M2 event rows and payload fields.
 * Run with: node scripts/inspect-m2-events.mjs
 */
import Database from "better-sqlite3";
import { join } from "path";

const db = new Database(join(process.cwd(), "data", "recoverai.db"), { readonly: true });

const rows = db.prepare(
  "SELECT event_id, event_type, related_entity_id, received_at, raw_payload FROM webhook_events ORDER BY id ASC"
).all();

console.log("=== M2 DB INSPECTION ===\n");

for (const row of rows) {
  let p;
  try { p = JSON.parse(row.raw_payload); } catch { p = {}; }
  const payload = p.payload ?? {};
  const payId    = payload?.payment?.entity?.id      ?? null;
  const orderId  = payload?.payment?.entity?.order_id ?? null;
  const plinkId  = payload?.payment_link?.entity?.id  ?? null;

  console.log(`[${row.event_id}] ${row.event_type}`);
  console.log(`  related_entity_id               : ${row.related_entity_id}`);
  console.log(`  payload.payment.entity.id       : ${payId}`);
  console.log(`  payload.payment.entity.order_id : ${orderId}`);
  console.log(`  payload.payment_link.entity.id  : ${plinkId}`);
  console.log(`  received_at                     : ${row.received_at}`);
  console.log();
}
