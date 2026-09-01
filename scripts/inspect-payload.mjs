import Database from "better-sqlite3";
import { join } from "path";

const db = new Database(join(process.cwd(), "data/recoverai.db"));

// Inspect failed payment payload
const failedRows = db.prepare(
  "SELECT event_type, raw_payload FROM webhook_events WHERE related_entity_id = 'pay_TUJULUouXtIq8y' LIMIT 1"
).all();

if (failedRows.length) {
  const entity = JSON.parse(failedRows[0].raw_payload).payload.payment.entity;
  console.log("=== FAILED PAYMENT ENTITY FIELDS ===");
  const { id, amount, currency, status, method, email, contact,
          error_code, error_description, error_source, error_step, error_reason,
          created_at, captured } = entity;
  console.log(JSON.stringify({ id, amount, currency, status, method, email, contact,
    error_code, error_description, error_source, error_step, error_reason,
    created_at, captured }, null, 2));
}

// Inspect captured payment payload
const capturedRows = db.prepare(
  "SELECT event_type, raw_payload FROM webhook_events WHERE related_entity_id = 'pay_TUJOzQxoEqFSLU' AND event_type = 'payment.captured' LIMIT 1"
).all();

if (capturedRows.length) {
  const entity = JSON.parse(capturedRows[0].raw_payload).payload.payment.entity;
  console.log("\n=== CAPTURED PAYMENT ENTITY FIELDS ===");
  const { id, amount, currency, status, method, email, contact,
          error_code, error_description, error_source, error_step, error_reason,
          created_at, captured } = entity;
  console.log(JSON.stringify({ id, amount, currency, status, method, email, contact,
    error_code, error_description, error_source, error_step, error_reason,
    created_at, captured }, null, 2));
}

// Check how many payments share the same contact/email
const contactRows = db.prepare(`
  SELECT json_extract(raw_payload, '$.payload.payment.entity.contact') as contact,
         json_extract(raw_payload, '$.payload.payment.entity.id') as pay_id,
         event_type
  FROM webhook_events
  WHERE event_type IN ('payment.failed','payment.captured','payment.authorized')
`).all();
console.log("\n=== ALL PAYMENT EVENTS (contact, pay_id, event_type) ===");
console.log(JSON.stringify(contactRows, null, 2));
