# RecoverAI Milestones

## Milestone 1 — Razorpay Test Mode Payment Link

**Status: COMPLETE**

### What was built

- Next.js + TypeScript project scaffolded with the App Router.
- Server-side Razorpay integration via a dedicated client module.
- `POST /api/payment-link` API route that creates a Standard Payment Link.
- Integration runs in **Razorpay Test Mode** — no real money is processed.

### Verified behaviour

- Rs.100 test amount used for all test payment link creation.
- A real HTTP request is made to the Razorpay API.
- The response contains real fields: `id`, `short_url`, `status`, `amount`, and `reference_id`.
- The Test Mode checkout was manually opened in a browser and visually verified.

### Build and lint status

- `npm run build` passes cleanly.
- `npm run lint` passes with one currently known, non-blocking warning (not described here).

### Environment

- `.env.local` is listed in `.gitignore` and is **not tracked** by Git.
- No credentials, secrets, or private URLs are committed to the repository.

### Milestone commit

```
d37b704  feat: add razorpay test payment link integration
```

---

## Milestone 2 — Reliable Razorpay Webhook Intake

**Status: COMPLETE**

### Objective

Prove that RecoverAI can safely receive, authenticate, deduplicate, correlate, and persist Razorpay webhook events. M2 does NOT implement recovery scoring, AI, dashboard, or polling.

### What was built

| Component | Path |
|-----------|------|
| SQLite persistence layer | `lib/db/client.ts` |
| Signature verification + event parsing | `lib/razorpay/webhooks.ts` |
| Webhook intake route | `app/api/webhooks/razorpay/route.ts` |
| Local verification script | `scripts/verify-webhook-local.mjs` |
| DB audit script | `scripts/audit-db.mjs` |

**Database**: `better-sqlite3` (SQLite, no server required). Selected as minimum viable persistence — file-based, zero infrastructure, works in local dev and any Node.js environment.

**Table**: `webhook_events`
- `event_id TEXT NOT NULL UNIQUE` — DB-level uniqueness, enforces idempotency
- `event_type TEXT NOT NULL`
- `related_entity_id TEXT` — primary entity per event type
- `received_at TEXT NOT NULL`
- `signature_verified INTEGER NOT NULL DEFAULT 1`
- `raw_payload TEXT NOT NULL` — full JSON preserved for M5 reconciliation

**Supported event types**: `payment.failed`, `payment.authorized`, `payment.captured`, `payment_link.paid`

### Webhook endpoint

```
POST /api/webhooks/razorpay
```

Pipeline: raw body → HMAC-SHA256 signature verification → JSON parse → event type validation → DB-level deduplication → persist → 200 acknowledgement

### Signature verification

- Algorithm: HMAC-SHA256, constant-time comparison
- Input: exact raw request body string (via `req.text()` — body never parsed before verification)
- Header: `X-Razorpay-Signature`
- Secret: `RAZORPAY_WEBHOOK_SECRET` environment variable

### Idempotency strategy

- `event_id` from `X-Razorpay-Event-Id` header
- `INSERT OR IGNORE` + DB `UNIQUE` constraint on `event_id`
- Duplicate event returns `200 { received: true, processed: false, reason: "duplicate_event_id" }`

### Build and lint status

- `npm run build` passes cleanly (exit 0). Route `ƒ /api/webhooks/razorpay` registered.
- `npm run lint` passes (exit 0). One pre-existing non-blocking M1 warning unchanged.
- `npx tsc --noEmit` passes (exit 0).

### Environment

- `.env.local` is not tracked by Git.
- No credentials or secrets in any commit.
- `/data/` SQLite directory excluded via `.gitignore`.

---

### Real Razorpay Test Mode Webhook Evidence

All four events received from Razorpay Test Mode via Pinggy SSH tunnel on 2026-08-26.

#### Successful payment transaction

| event_id | event_type | related_entity_id | received_at (UTC) |
|----------|------------|-------------------|-------------------|
| `TUJP9nIPXjjKHz` | `payment.authorized` | `pay_TUJOzQxoEqFSLU` | 2026-08-26T07:14:12.943Z |
| `TUJPAgMDIlHLPk` | `payment.captured` | `pay_TUJOzQxoEqFSLU` | 2026-08-26T07:14:13.669Z |
| `TUJPBb9nJ07SCK` | `payment_link.paid` | `plink_TUJOLytB9eXVkn` | 2026-08-26T07:14:14.594Z |

#### Correlation analysis (from raw payloads)

All three events share the same values in their raw JSON payloads:

| Field | Value |
|-------|-------|
| `payload.payment.entity.id` | `pay_TUJOzQxoEqFSLU` |
| `payload.payment.entity.order_id` | `order_TUJOYlCiaimXgm` |
| `payload.payment_link.entity.id` | `plink_TUJOLytB9eXVkn` (present in `payment_link.paid` raw payload only) |

**Correlation verdict**: All three events are reliably correlated to the same underlying payment transaction via `pay_TUJOzQxoEqFSLU`, which appears in `payload.payment.entity.id` of all three raw payloads. The `payment_link.paid` event also includes both identifiers in its raw payload, making M5 reconciliation unambiguous.

**Note for M5**: `related_entity_id` stores the primary entity per event type (`pay_*` for payment events, `plink_*` for payment_link events). Cross-type correlation requires reading `payload.payment.entity.id` from the `raw_payload` column of `payment_link.paid` rows — this field is preserved and available.

#### Event arrival order (from received_at)

```
1. payment.authorized  — 07:14:12.943Z
2. payment.captured    — 07:14:13.669Z   (+726ms)
3. payment_link.paid   — 07:14:14.594Z   (+1651ms total)
```

Order matches expected Razorpay payment state progression: `authorized → captured`, with `payment_link.paid` delivered last (after the link is marked paid). Both `payment.captured` and `payment_link.paid` fired for the same Payment Link transaction — they are distinct events with distinct `event_id` values and are stored as separate rows.

#### Failed payment event

| event_id | event_type | related_entity_id | received_at (UTC) |
|----------|------------|-------------------|-------------------|
| `TUJVP3og9VrG5n` | `payment.failed` | `pay_TUJULUouXtIq8y` | 2026-08-26T07:20:07.732Z |

#### Security verification

- Valid Razorpay signature: **accepted** (all 4 real events persisted)
- Invalid signature (local tampered test): **rejected with HTTP 401**
- Duplicate event ID (local test): **deduplicated — second delivery returned 200 without creating a second row**
- Unsupported event type (`order.paid`): **acknowledged with 200, not persisted**

### Milestone commits

```
9243aba  feat: add webhook persistence schema
037ea01  feat: verify razorpay webhook signatures
db61984  feat: add razorpay webhook endpoint
2c7c459  feat: handle razorpay payment events
<fifth>  test: verify razorpay webhook lifecycle
```

---

---

## Milestone 3 — Canonical Payment State Derivation

**Status: COMPLETE**

### Objective

Build a small, deterministic canonical payment-state derivation layer that
examines the persisted webhook event history for an underlying payment and
determines its current factual payment state.

M3 answers: "What is the current factual payment state for this underlying
payment, based on the Razorpay events RecoverAI has received?"

M3 is NOT the recovery engine, scoring engine, AI, dashboard, or polling.

### What was built

| Component | Path |
|-----------|------|
| Canonical state derivation (pure + DB) | `lib/payments/state.ts` |
| Payment state API route | `app/api/payment-state/route.ts` |
| M3 unit + integration tests | `tests/payment-state.test.mjs` |
| DB inspection helper | `scripts/inspect-m2-events.mjs` |

### Canonical State Model

Four states — chosen as the smallest sensible model that distinguishes all
factual payment outcomes:

| State | Meaning |
|-------|---------|
| `UNKNOWN` | No recognised state-bearing events received |
| `FAILED` | `payment.failed` received; no higher-finality event |
| `AUTHORIZED` | `payment.authorized` received; no capture yet |
| `CAPTURED` | `payment.captured` received — highest finality |

`RECOVERED`, `RECOVERABLE`, `LOST`, `SCORE`, and `AI_DIAGNOSIS` are
deliberately absent — those belong to later milestones.

### General State-Derivation Rule

**Event-type finality precedence:**

```
CAPTURED (rank 3) > AUTHORIZED (rank 2) > FAILED (rank 1) > UNKNOWN (rank 0)
```

From all webhook events for a payment, the canonical state is the one
carried by the event type with the **highest finality rank**.

`payment_link.paid` carries **no rank** — it is a correlation/confirmation
signal only, not an independent payment state.

#### Why this rule is semantically correct

Razorpay's payment lifecycle has irreversible positive finality:

- A captured payment cannot become un-captured.
- A `payment.failed` event received after `payment.captured` is a webhook
  delivery artifact (out-of-order or retry), not a state reversal.
- `payment.authorized` is a transient state that terminates in either
  capture or failure; it never supersedes a completed capture.

The same rule handles ALL valid event orderings without special cases:

```
failed                          → FAILED
authorized                      → AUTHORIZED
captured                        → CAPTURED
failed → authorized             → AUTHORIZED
authorized → captured           → CAPTURED
failed → captured               → CAPTURED
captured → failed               → CAPTURED   (finality preserved)
authorized → failed → captured  → CAPTURED
payment_link.paid + captured    → CAPTURED
duplicates of any event         → same state (idempotent by design)
```

### Payment Identity Correlation

The canonical payment ID (`pay_xxx`) is the single correlation key.

For all event types (including `payment_link.paid`), correlation uses
SQLite `json_extract` on the `raw_payload` column:

```sql
SELECT DISTINCT event_type
FROM   webhook_events
WHERE  json_extract(raw_payload, '$.payload.payment.entity.id') = ?
```

This works uniformly across all event types. For `payment_link.paid`,
`related_entity_id` stores the payment link ID (`plink_xxx`), but
`payload.payment.entity.id` in the raw payload always contains the
underlying payment ID — confirmed by M2 real event inspection.

### Database Index

The `idx_webhook_events_related_entity_id` index on `related_entity_id`
was already created in M2 and covers `payment.*` lookups efficiently.

M3 uses `json_extract` on `raw_payload` for uniform correlation; this
expression is not separately indexed (noted for M5 optimisation if needed).

No new indexes were added — the M2 index is sufficient at current scale.

### API Route

```
GET /api/payment-state?paymentId=pay_xxx
```

Response:
```json
{
  "paymentId": "pay_TUJOzQxoEqFSLU",
  "state": "CAPTURED",
  "derivedAt": "2026-08-26T15:00:00.000Z"
}
```

### Real M2 Database Results

| Payment ID | Events in DB | Derived State |
|------------|-------------|---------------|
| `pay_TUJOzQxoEqFSLU` | `payment.authorized`, `payment.captured`, `payment_link.paid` | **CAPTURED** |
| `pay_TUJULUouXtIq8y` | `payment.failed` | **FAILED** |

Cross-contamination: confirmed absent — each payment ID is queried
independently via its own `json_extract` predicate.

### Tests

21 tests, all pass. Two layers:

**Layer 1 — Pure unit tests (`derivePaymentStateFromEvents`):**
1. `failed only → FAILED`
2. `authorized only → AUTHORIZED`
3. `captured only → CAPTURED`
4. `authorized → captured → CAPTURED`
5. `failed → captured → CAPTURED`
6. `captured → failed → CAPTURED` (out-of-order)
7. `payment_link.paid + captured → CAPTURED`
8a. `duplicate payment.failed → FAILED` (idempotent)
8b. `duplicate payment.captured → CAPTURED` (idempotent)
9a. `captured → authorized (reversed) → CAPTURED`
9b. `authorized → failed (reversed) → AUTHORIZED`
9c. `payment_link.paid → captured (plink first) → CAPTURED`
EXTRA: `authorized → failed → captured → CAPTURED` (general rule demonstration)
EXTRA: `authorized → failed → AUTHORIZED` (no capture)
EXTRA: `payment_link.paid alone → UNKNOWN`
EXTRA: `empty event list → UNKNOWN`
EXTRA: `unknown event type → UNKNOWN`

**Layer 2 — DB integration tests (`derivePaymentState`, real M2 events):**
10a. `pay_TUJOzQxoEqFSLU → CAPTURED` ✅
10b. `pay_TUJULUouXtIq8y → FAILED` ✅
10c. Cross-contamination check: CAPTURED ≠ FAILED ✅
10d. Synthetic/unknown payment ID → UNKNOWN ✅

### Unresolved Edge Cases

None. All required transitions are handled deterministically by the
finality-precedence rule.

### Build and lint status

- `npm run build` passes cleanly (exit 0). Route `ƒ /api/payment-state` registered.
- `npm run lint` passes (exit 0). Same pre-existing M1 warning — unchanged.
- All 21 M3 tests pass. All M2 tests continue to pass.

### M2 regression

M2 real event records are untouched (verified via `scripts/inspect-m2-events.mjs`).
M2 DB schema is unchanged. M2 committed code is unchanged.

### Milestone commits

```
1. feat: add canonical payment state derivation
2. feat: add payment state API route
3. test: cover payment state transitions
4. docs: document canonical payment states
```

---

## Upcoming Milestones

| Milestone | Title |
|-----------|-------|
| M4 | Recovery state and recovered revenue tracking |
| M5 | Deterministic recovery scoring |
| M6 | AI diagnosis and recommendation |
| M7 | Merchant dashboard |
| M8 | End-to-end demo and polish |

Implementation details for M4–M8 are not yet defined.
