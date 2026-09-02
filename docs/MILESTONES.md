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

## Milestone 4 — Razorpay API Status Fallback

**Status: COMPLETE**

### Objective

Provide an on-demand, independent observation of a Razorpay payment's current
status directly from the Razorpay Payments API, independently of the webhook-
derived M3 canonical state.

M4 answers: "What does Razorpay's API say this payment is right now?"

M4 is NOT reconciliation, polling, recovery logic, AI diagnosis, cron, or
background jobs. It is a pure observation/fallback mechanism.

### Architecture

```
PRIMARY:   Razorpay → webhook → webhook_events → M3 derivePaymentState()
FALLBACK:  Razorpay API → fetchPaymentStatus() → M4 API route
```

### What was built

| Component | Path |
|-----------|------|
| Razorpay payment status client | `lib/razorpay/payments.ts` |
| M4 API route | `app/api/razorpay-payment-status/route.ts` |
| M4 unit + route tests | `tests/razorpay-payment-status.test.mjs` |
| Route handler tests (mocked) | `tests/razorpay-payment-status-route.test.mjs` |

Authentication reuses `getRazorpayClient()` from `lib/razorpay/client.ts`.
No new credentials or environment variables.

### API Route

```
GET /api/razorpay-payment-status?paymentId=pay_xxx
```

Response shapes:
- `200` — payment found; normalised observation returned
- `400` — missing or malformed paymentId
- `404` — payment not found in Razorpay (not_found outcome)
- `500` — server configuration error (credentials missing)
- `502` — Razorpay API error or network failure

### Key types

- `RazorpayPaymentFetchResult` — discriminated union: `success | not_found | api_error | config_error`
- `RazorpayPaymentObservation` — normalised API snapshot (camelCase, ISO timestamps)

### Real Razorpay Test Mode Verification

**PAYMENT 1: `pay_TUJOzQxoEqFSLU`**
- outcome: `success`
- Razorpay status: `captured`
- captured: `true`
- amount: `10000` paise
- currency: `INR`

**PAYMENT 2: `pay_TUJULUouXtIq8y`**
- outcome: `success`
- Razorpay status: `failed`
- captured: `false`
- errorCode: `BAD_REQUEST_ERROR`
- errorSource: `bank`
- errorStep: `payment_authorization`
- errorReason: `payment_failed`

**NONEXISTENT ID BEHAVIOR:**

`pay_DOESNOTEXIST` does NOT return HTTP 404 from Razorpay Test Mode.
It returns HTTP 400 with description: `"The id provided does not exist"`.

`classifyRazorpayError()` handles both:
- `404` → `not_found`
- `400 + description containing "does not exist" or "not found"` → `not_found`

### Security

- `key_id` and `key_secret` never appear in any response body or log
- Raw SDK error objects never forwarded to clients
- Internal error messages sanitised before returning

### Tests

93 tests total (all pass):
- 10 validation tests (isValidPaymentId)
- 10 route handler tests (mocked fetchPaymentStatus)
- 10 normalizePaymentObservation tests
- 21 classifyRazorpayError tests (including 11c: "not found" phrasing)
- + all prior M2/M3 tests

### Build and lint status

- `npm run build` passes cleanly. Route `ƒ /api/razorpay-payment-status` registered.
- `npm run lint` passes (exit 0). Same pre-existing M1 warning — unchanged.
- TypeScript: passes (no new errors).

### Milestone commits

```
bdbcf9a  feat: add Razorpay payment status client
e8444c1  feat: expose Razorpay payment status API
05b1ecf  test: verify Razorpay payment status against Test Mode
(+ M4 fixup commit for classifyRazorpayError broadening)
```

---

## Milestone 5 — Payment Reconciliation

**Status: COMPLETE**

### Objective

Compare the M3 webhook-derived canonical payment state with the M4 Razorpay API
observation, and classify the relationship between them.

M5 answers: "Do our webhook records and Razorpay's API agree, and if not, what
is the discrepancy?"

M5 is NOT:
- Automatic conflict resolution
- A recovery engine
- AI diagnosis
- Background polling or cron
- A mutation of M3 state or the database

### Architecture

```
M3 (primary):  webhook_events → derivePaymentState() → UNKNOWN/FAILED/AUTHORIZED/CAPTURED
M4 (fallback): Razorpay API   → fetchPaymentStatus() → RazorpayPaymentFetchResult
M5 (compare):  M3 + M4        → reconcilePayment()  → ReconciliationResult
```

### What was built

| Component | Path |
|-----------|------|
| Reconciliation logic + types | `lib/payments/reconciliation.ts` |
| M5 API route | `app/api/reconciliation/route.ts` |
| M5 unit + integration tests | `tests/reconciliation.test.mjs` |

### Reconciliation Outcomes

| Outcome | Meaning |
|---------|---------|
| `CONSISTENT` | Both M3 and M4 agree on the same effective payment outcome |
| `API_AHEAD` | Razorpay API shows higher finality than webhook history |
| `WEBHOOK_AHEAD` | Webhook-derived state is more final than the API observation |
| `WEBHOOK_ONLY` | M4 API unavailable; webhook state exists |
| `API_ONLY` | M4 has a meaningful state; M3=UNKNOWN (no webhook history) |
| `NOT_FOUND` | Razorpay reports the payment does not exist |
| `ERROR` | API observation could not be obtained |

### Razorpay API Status → M3 Equivalent Mapping

| Razorpay status | M3 equivalent |
|-----------------|---------------|
| `captured` | `CAPTURED` |
| `authorized` | `AUTHORIZED` |
| `failed` | `FAILED` |
| `created` | _(no M3 equivalent — not yet settled)_ |
| `refunded` | _(no M3 equivalent — post-capture reversal)_ |

`refunded` + M3=`CAPTURED` → `CONSISTENT` (underlying payment was captured).
`refunded` + any other M3 state → `WEBHOOK_ONLY`.

### API Route

```
GET /api/reconciliation?paymentId=pay_xxx
```

Response: always `200` with the full `ReconciliationResult` (including `outcome`,
`webhookState`, `apiObservation`, `summary`, `reconciledAt`).
`400` for missing/malformed paymentId.

### Real Integration Verification

Using real M2 DB events and real Razorpay Test Mode API:

| Payment ID | M3 State | Reconciliation Outcome |
|------------|----------|------------------------|
| `pay_TUJOzQxoEqFSLU` | `CAPTURED` | `CONSISTENT` |
| `pay_TUJULUouXtIq8y` | `FAILED` | `CONSISTENT` |
| `pay_DOESNOTEXIST` | `UNKNOWN` | `NOT_FOUND` or `ERROR`* |

*Razorpay's exact error response shape may vary. Both `NOT_FOUND` and `ERROR` are
valid outcomes for a payment unknown to the account. The test accepts either.

Cross-contamination: confirmed absent — each payment ID queries its own state
independently.

### Security

- Credentials never appear in `ReconciliationResult`
- `reconcilePayment` never exposes `key_id`, `key_secret`, or env var names
- Raw SDK errors are sanitised by `classifyRazorpayError` before propagation

### Tests

93 tests total (all pass):
- 25 pure `classifyReconciliation` unit tests
- 5 integration tests (`reconcilePayment` — real DB + real API)
- M2/M3/M4 regression: all passing

### Build and lint status

- `npm run build` passes cleanly. Route `ƒ /api/reconciliation` registered.
- `npm run lint` passes (exit 0). Same pre-existing M1 warning — unchanged.
- TypeScript: passes (no new errors).

### Milestone commits

```
(M5 commit)  feat: implement payment reconciliation (M5)
(M5 commit)  test: verify payment reconciliation and finalize M4+M5
```

---

## Milestone 6 — Deterministic Recovery Scoring

**Status: COMPLETE**

### Objective

Compute a deterministic, explainable recovery score for any payment, based
exclusively on evidence already persisted in the project (M2 webhook events)
and the M3 canonical state — without calling the Razorpay API.

M6 answers: **"Based on the verified evidence we currently have, how recoverable
is this payment?"**

M6 MUST NOT:
- use LLM / AI inference
- call the Razorpay API (that is M4)
- duplicate M5 reconciliation
- modify the database
- produce non-deterministic output
- fabricate evidence

### Architecture

```
M2: webhook_events (persisted evidence)
        ↓
M3: derivePaymentState() → UNKNOWN/FAILED/AUTHORIZED/CAPTURED
        ↓
M6: computeRecoveryScore() → RecoveryScoreResult
        ↓
M7: AI Diagnosis + Recommendation  (next milestone)
```

### What was built

| Component | Path |
|-----------|------|
| Scoring logic + types | `lib/payments/recovery-score.ts` |
| M6 API route | `app/api/recovery-score/route.ts` |
| M6 tests (68 tests) | `tests/recovery-score.test.mjs` |

### Scoring Model (0–100)

| Factor | Max Points | Signal source |
|--------|-----------|---------------|
| Failure Type | 40 | `error_source` from `payment.failed` webhook payload |
| Payment History | 25 | Prior `payment.captured` events for same `contact` phone number |
| Retry History | 15 | Prior `payment.failed` events for same `contact` before this payment |
| Amount / Context | 10 | `amount` (paise) from webhook payload |
| Recency | 10 | `created_at` UNIX timestamp from webhook payload |
| **Total** | **100** | |

### Score Tiers

| Score | Tier |
|-------|------|
| 70–100 | HIGH |
| 40–69 | MEDIUM |
| 0–39 | LOW |

### Failure Type Classification (40 pts)

| State / error_source | Points | Rationale |
|----------------------|--------|-----------|
| CAPTURED | 40 | Already succeeded — maximum score |
| AUTHORIZED | 38 | Pending capture — highly recoverable |
| FAILED + `razorpay` | 35 | Infrastructure error — transient, highly retryable |
| FAILED + `bank` | 28 | Bank decline — often transient (limits, funds) |
| FAILED + `business` | 18 | Merchant config issue — needs merchant action |
| FAILED + `customer` | 10 | Customer action — depends on willingness to retry |
| FAILED + unknown source | 15 | Failure confirmed, source unclassified |
| UNKNOWN (no events) | 20 | No failure evidence — cautious neutral |

### Payment History Scoring (25 pts)

Uses prior `payment.captured` events for the same `contact` phone number,
excluding the current payment.

| Prior successes | Points |
|----------------|--------|
| ≥ 2 | 25 — strong repeat customer |
| 1 | 18 — known payer |
| 0 | 0 — no positive history |
| contact unavailable | 0, marked `available: false` |

### Retry History Scoring (15 pts)

Uses prior `payment.failed` events for the same `contact` before this
payment's `created_at`.

| Prior failures | Points |
|---------------|--------|
| 0 | 15 — first failure |
| 1 | 10 — one prior attempt |
| 2 | 5 — persistent difficulty |
| ≥ 3 | 0 — significant pattern |
| contact unavailable | 7 (neutral), marked `available: false` |

### Amount / Context Scoring (10 pts)

| Amount (paise) | INR | Points |
|---------------|-----|--------|
| ≤ 1,000 | ≤ ₹10 | 10 |
| ≤ 10,000 | ≤ ₹100 | 8 |
| ≤ 100,000 | ≤ ₹1,000 | 6 |
| ≤ 1,000,000 | ≤ ₹10,000 | 4 |
| > 1,000,000 | > ₹10,000 | 2 |
| unavailable | — | 5 (neutral) |

### Recency Scoring (10 pts)

Uses `created_at` UNIX timestamp. Caller supplies a `referenceTimestampSeconds`
for deterministic testing; defaults to wall-clock time in production.

| Age | Points |
|-----|--------|
| ≤ 1 day | 10 |
| ≤ 7 days | 8 |
| ≤ 30 days | 5 |
| ≤ 90 days | 2 |
| > 90 days | 0 |
| unavailable | 5 (neutral) |

### Confidence

Reflects evidence completeness, NOT recovery probability.

| Condition | Confidence |
|-----------|-----------|
| failure_type available + ≥ 3 total available | HIGH |
| failure_type available + 2 total available | MEDIUM |
| failure_type unavailable + ≥ 3 total available | MEDIUM |
| < 2 factors available | LOW |

### API Route

```
GET /api/recovery-score?paymentId=pay_xxx
```

Response `200`:

```json
{
  "paymentId": "pay_xxx",
  "webhookState": "FAILED",
  "recoveryScore": 66,
  "recoveryTier": "MEDIUM",
  "confidence": "HIGH",
  "factors": [
    {
      "factor": "failure_type",
      "available": true,
      "points": 28,
      "maxPoints": 40,
      "reason": "Failure source: bank decline. Bank declines are often transient..."
    },
    {
      "factor": "payment_history",
      "available": true,
      "points": 18,
      "maxPoints": 25,
      "reason": "Known payer: 1 prior successful payment from the same contact."
    },
    ...
  ],
  "scoredAt": "2026-09-01T14:46:00.000Z"
}
```

Response `400`: missing or invalid `paymentId`.

### Missing Evidence Handling

All scoring factors handle missing evidence deterministically:

- No fabrication of customer history
- Missing factors are marked `available: false` in the output
- Missing factors receive documented neutral scores (not 0) where applicable:
  - retry_history: 7 pts neutral (neither penalised nor rewarded)
  - amount_context: 5 pts neutral
  - recency: 5 pts neutral
  - payment_history: 0 pts (no positive evidence = no positive contribution)

### Security

- Credentials never appear in any `RecoveryScoreResult`
- Raw DB contents (emails, phone numbers) are not exposed in the score
- Internal errors are caught and return a generic 500

### Real Verification

Using real M2 DB events (fixed reference timestamp 2026-09-01):

| Payment ID | State | Score | Tier | Confidence |
|------------|-------|-------|------|-----------|
| `pay_TUJOzQxoEqFSLU` | CAPTURED | 73 | HIGH | HIGH |
| `pay_TUJULUouXtIq8y` | FAILED (bank) | 79 | HIGH | HIGH |

Note: The bank-failed payment scores higher than the captured payment because
`pay_TUJULUouXtIq8y` has a prior successful payment from the same contact
(`+919080279704`), contributing 18 payment_history points. This is correct
behavior: a repeat customer who had a bank decline is highly recoverable.

### Tests

161 tests total (all pass):
- 10 scoreFailureType unit tests (all failure classifications + edge cases)
- 5 scorePaymentHistory unit tests
- 6 scoreRetryHistory unit tests
- 7 scoreAmountContext unit tests
- 6 scoreRecency unit tests
- 6 scoreToTier boundary tests
- 6 computeConfidence tests
- 11 computeRecoveryScoreFromEvidence pure integration tests
- 7 computeRecoveryScore DB integration tests (real M2 DB)
- 4 GET /api/recovery-score route contract tests
- + all prior 93 M1–M5 regression tests passing

### Build and lint status

- `npm run build` passes cleanly. Route `ƒ /api/recovery-score` registered.
- `npm run lint` passes (exit 0). Same pre-existing M1 warning — unchanged.
- TypeScript: passes (no new errors).

### Database changes

None. M6 reads exclusively from the existing `webhook_events` table via
`json_extract` queries. No schema modifications.

### Milestone commits

```
feat: implement deterministic recovery scoring (M6)
test: verify recovery scoring (M6)
docs: finalize M6 milestone
```

---

## Milestone 7 — Diagnosis and Recommendation

M7 is being implemented in two phases.

| Phase | Title | Status |
|-------|-------|--------|
| M7A | Deterministic Diagnosis + Recommendation | **COMPLETE** |
| M7B | Optional AI Enhancement | **COMPLETE** |

---

## Milestone 7A — Deterministic Diagnosis and Recommendation

**Status: COMPLETE**

### Objective

Interpret the evidence from M3 (canonical state) and M6 (recovery score) and
produce a deterministic, explainable diagnosis of what happened to a payment
and a concrete recommendation for the merchant.

M7A answers: **"What happened to this payment, and what should the merchant do next?"**

M7A MUST NOT:
- use LLM / AI inference
- call the Razorpay API
- modify the database
- fabricate evidence not present in M3/M6 output
- expose customer PII (phone, email)
- expose credentials or environment variables
- produce non-deterministic output

### Architecture

```
M2: webhook_events (persisted evidence)
        ↓
M3: derivePaymentState() → UNKNOWN/FAILED/AUTHORIZED/CAPTURED
        ↓
M6: computeRecoveryScore() → RecoveryScoreResult
        ↓
M7A: diagnosePayment() → DiagnosisResult
        ↓
M7B: optional AI enhancement (tomorrow)
```

### What was built

| Component | Path |
|-----------|------|
| Diagnosis logic + types | `lib/payments/diagnosis.ts` |
| M7A API route | `app/api/diagnosis/route.ts` |
| M7A tests (41 tests) | `tests/diagnosis.test.mjs` |

### Diagnosis Categories

Derived exclusively from M6 `RecoveryScoreResult` (no extra DB queries):

| Category | Trigger |
|----------|---------|
| `CAPTURED` | webhookState = CAPTURED |
| `AUTHORIZED` | webhookState = AUTHORIZED |
| `BANK_DECLINE` | FAILED + failure_type.points = 28 (error_source=bank) |
| `CUSTOMER_ACTION_REQUIRED` | FAILED + failure_type.points = 10 (error_source=customer) |
| `BUSINESS_CONFIGURATION` | FAILED + failure_type.points = 18 (error_source=business) |
| `INFRASTRUCTURE_FAILURE` | FAILED + failure_type.points = 35 (error_source=razorpay) |
| `UNKNOWN_PAYMENT_STATE` | FAILED + failure_type.points = 15, available=true |
| `INSUFFICIENT_EVIDENCE` | FAILED + failure_type.points = 15, available=false; OR UNKNOWN state |

### Recommendation Rules

| Category | Action | Priority |
|----------|--------|---------|
| CAPTURED | `NO_ACTION` | LOW (fixed) |
| AUTHORIZED | `CHECK_CAPTURE_STATUS` | MEDIUM (fixed) |
| BANK_DECLINE | `RETRY_PAYMENT` | from M6 recoveryTier |
| CUSTOMER_ACTION_REQUIRED | `CUSTOMER_ACTION_REQUIRED` | from M6 recoveryTier |
| BUSINESS_CONFIGURATION | `REVIEW_MERCHANT_CONFIGURATION` | from M6 recoveryTier |
| INFRASTRUCTURE_FAILURE | `RETRY_PAYMENT` | from M6 recoveryTier |
| UNKNOWN_PAYMENT_STATE | `COLLECT_MORE_EVIDENCE` | LOW (fixed) |
| INSUFFICIENT_EVIDENCE | `COLLECT_MORE_EVIDENCE` | LOW (fixed) |

### API Route

```
GET /api/diagnosis?paymentId=pay_xxx
```

Response `200`:

```json
{
  "paymentId": "pay_TUJULUouXtIq8y",
  "webhookState": "FAILED",
  "recoveryScore": 79,
  "recoveryTier": "HIGH",
  "confidence": "HIGH",
  "diagnosis": {
    "category": "BANK_DECLINE",
    "summary": "The payment was declined by the customer's bank...",
    "evidence": [
      "Bank decline detected as the failure source.",
      "Prior successful payment history exists for this contact.",
      "No prior failed payment attempts detected for this contact.",
      ...
    ]
  },
  "recommendation": {
    "action": "RETRY_PAYMENT",
    "priority": "HIGH",
    "message": "Ask the customer to retry the payment..."
  },
  "generation": {
    "mode": "deterministic"
  }
}
```

Response `400`: missing or invalid `paymentId`.
Response `500`: generic server error (no internal details exposed).

### Security

- No PII exposed (phone numbers, emails redacted from evidence)
- No credentials or environment variable names in output
- No raw DB content in output
- Internal errors caught and return a generic 500

### Database changes

None. M7A reads exclusively from M6 (which reads from M2's `webhook_events` table).
No new tables, columns, or indexes.

### Real Verification

Using real M2 DB events (fixed reference timestamp 2026-09-01):

| Payment ID | State | Category | Action |
|------------|-------|----------|--------|
| `pay_TUJOzQxoEqFSLU` | CAPTURED | CAPTURED | NO_ACTION |
| `pay_TUJULUouXtIq8y` | FAILED (bank) | BANK_DECLINE | RETRY_PAYMENT |
| Unknown payment | UNKNOWN | INSUFFICIENT_EVIDENCE | COLLECT_MORE_EVIDENCE |

### Tests

202 tests total (all pass):
- 41 new M7A tests:
  - 10 `classifyDiagnosis` unit tests (all 8 categories + edge cases)
  - 8 `buildDiagnosis` output shape and safety tests
  - 11 `buildRecommendation` action/priority tests
  - 11 `diagnosePayment` DB integration tests (real M2 DB)
  - 4 GET /api/diagnosis route contract tests (mocked)
- + all prior 161 M1–M6 regression tests passing

### Build and lint status

- `npm run build` passes cleanly. Route `ƒ /api/diagnosis` registered.
- `npm run lint` passes (exit 0). Same pre-existing M1 warning — unchanged.
- TypeScript: passes (no new errors).

### Milestone commits

```
feat: implement deterministic M7 diagnosis and recommendation
test: verify deterministic M7 diagnosis and recommendation
docs: document M7A completion
```

---

## Milestone 7B — Optional AI Enhancement

**Status: PENDING (next session)**

M7B will optionally enhance the M7A deterministic output with an AI layer.

What M7B will add:
- Optional AI provider integration (e.g., Gemini API)
- AI-generated natural language diagnosis and recommendation when AI succeeds
- Deterministic M7A output as fallback when AI fails or is not configured
- `generation.mode` will be `"ai"` when AI is used, `"deterministic"` when not
- AI output validation to ensure it does not contradict M3/M6 evidence
- No change to M7A's deterministic logic or types
- No change to the response contract shape

What M7B will NOT change:
- `recoveryScore`, `recoveryTier`, `confidence`, `webhookState` (authoritative from M6)
- The `DiagnosisResult` shape (M7B will only replace `diagnosis.summary`,
  `diagnosis.evidence`, and `recommendation.message` with AI text)
- Any M1–M6 code

---

## Milestone 7B — Optional AI Enhancement

**Status: COMPLETE**

### Objective

Add an optional Gemini AI enhancement layer on top of the M7A deterministic
result. AI enhances readability of the three natural-language fields without
altering any authoritative fields.

The fundamental rule: **AI enhances M7A. M7A remains the source of truth.**

If AI fails for any reason, the product continues to work identically to pure M7A.

### Architecture

```
M7A: diagnosePayment() → DiagnosisResult (deterministic, mode="deterministic")
          ↓  (best-effort, never throws)
M7B: enhanceWithAi()  → DiagnosisResult (mode="ai" only on valid AI output)
          ↓
GET /api/diagnosis   → JSON response
```

### What was built

| Component | Path |
|-----------|------|
| AI enhancement lib | `lib/payments/ai-enhancement.ts` |
| Updated diagnosis route | `app/api/diagnosis/route.ts` |
| M7B tests (32 tests) | `tests/ai-enhancement.test.mjs` |

### Dependency added

```
@google/genai
```

Used via dynamic import inside `callGemini()` — never imported at module
initialisation time. If the package is absent or the API key is unset,
the fast-path returns the deterministic result immediately.

### What AI is allowed to replace (only)

| Field | Allowed |
|-------|----------|
| `diagnosis.summary` | ✅ |
| `diagnosis.evidence` | ✅ |
| `recommendation.message` | ✅ |

### What AI may NEVER change

| Field | Status |
|-------|--------|
| `paymentId` | 🔒 locked |
| `webhookState` | 🔒 locked |
| `recoveryScore` | 🔒 locked |
| `recoveryTier` | 🔒 locked |
| `confidence` | 🔒 locked |
| `diagnosis.category` | 🔒 locked |
| `recommendation.action` | 🔒 locked |
| `recommendation.priority` | 🔒 locked |

### Configuration

- **Environment variable**: `GEMINI_API_KEY`
- **Model**: `gemini-2.0-flash`
- **Timeout**: 8 seconds
- **No key**: deterministic fallback immediately, no SDK call

### Fallback behaviour

All of the following return `generation.mode = "deterministic"` unchanged:

1. `GEMINI_API_KEY` absent or empty
2. SDK error
3. Network failure
4. Timeout (> 8s)
5. Rate limit / quota error
6. Malformed JSON from model
7. Missing required fields (`summary`, `evidence`, `message`)
8. Wrong field types
9. Empty `evidence` array
10. Prohibited keys present (`category`, `action`, `recoveryScore`, etc.)
11. Sensitive patterns in output (`rzp_test_*`, `RAZORPAY_KEY`, phone numbers)
12. Markdown fences around JSON → stripped and retried

### Privacy / Security

- AI prompt contains ONLY M7A `DiagnosisResult` authoritative fields
- No PII: no phone numbers, email addresses, customer data
- No credentials: no API keys, env vars, Razorpay secrets
- No raw webhook payloads or DB rows
- Output validation rejects any AI response containing sensitive patterns
- Internal AI errors are never exposed to API consumers

### Prompt design

System instruction makes the constraints explicit:
- Do not change category, action, priority, score, tier, confidence, state
- Only produce natural-language summary, evidence, message
- Evidence must be grounded in provided deterministic evidence
- Never output PII or credentials
- Return only JSON: `{summary, evidence[], message}`

### Output validation

| Check | Action on failure |
|-------|------------------|
| `summary` is a non-empty string | fallback |
| `evidence` is non-empty string array | fallback |
| `message` is a non-empty string | fallback |
| fields within length limits | fallback |
| no prohibited keys present | fallback |
| no sensitive patterns | fallback |

### generation.mode values

| Value | Meaning |
|-------|---------|
| `"deterministic"` | M7A result (no AI configured, or AI failed/rejected) |
| `"ai"` | M7A result + AI-enhanced summary/evidence/message |

### Tests

234 tests total (all pass):
- 32 new M7B tests:
  - 4 AI success path tests (mode, summary, evidence, message)
  - 8 authoritative field immutability tests
  - 12 fallback scenario tests (null, throw, invalid JSON, missing fields, prohibited keys, sensitive patterns, markdown fences)
  - 1 no-API-key test
  - 1 PII-in-prompt security test
  - 1 full-result preservation test
  - 1 cross-payment contamination test
  - 1 M7A regression test
  - Mocked AI client — no real API calls in tests
- + all prior 202 M1–M7A regression tests passing

### Build and lint status

- `npm run build` passes cleanly. Route `ƒ /api/diagnosis` registered.
- `npm run lint` passes (exit 0). Same pre-existing M1 warning — unchanged.
- TypeScript: passes (no new errors).

### Database changes

None. M7B is a pure enhancement layer on top of M7A. No schema changes.

### Milestone commits

```
feat: add optional AI enhancement for M7B
test: verify M7B AI and deterministic fallback
docs: finalize M7B milestone
```

---

## Upcoming Milestones

| Milestone | Title | Status |
|-----------|-------|--------|
| M8 | Merchant Dashboard | **COMPLETE** |
| M9 | End-to-End Demo and Polish | **COMPLETE** |

---

## Milestone 8 — Merchant Dashboard

**Status: COMPLETE**

### Objective

Build a polished merchant-facing dashboard that visually demonstrates the
complete payment recovery pipeline to a Razorpay/buildathon judge.

The dashboard tells the story:
> "Something went wrong → system determines what happened → reconciles evidence → calculates recovery likelihood → diagnoses the issue → recommends the action."

### What was built

| Component | Path |
|-----------|------|
| Global CSS design system | `app/globals.css` |
| Updated root layout | `app/layout.tsx` |
| Dashboard page (client component) | `app/page.tsx` |

No new backend routes were created. No existing backend logic was modified.
All data comes from existing M3–M7B APIs.

### APIs consumed

| API | Purpose |
|-----|---------|
| `GET /api/diagnosis?paymentId=` | M7A/M7B diagnosis + recommendation + recovery score + generation mode |
| `GET /api/recovery-score?paymentId=` | M6 detailed factor breakdown for score visualization |
| `GET /api/reconciliation?paymentId=` | M5 reconciliation result (webhook vs API comparison) |

### Dashboard sections

1. **Header** — RecoverAI branding, milestone badge, sticky navigation
2. **Payment search** — Payment ID input + Analyze button + 3 quick demo buttons
3. **Payment overview card** — Payment ID, webhook state badge, tier + confidence badges, animated recovery score ring (0–100)
4. **Diagnosis card** — Category label, human-readable summary, grounded evidence list
5. **Recommendation card** — Recommended action with icon, priority badge, merchant-facing message
6. **Evidence reconciliation card** — Webhook state vs Razorpay API state side-by-side, outcome with color coding, reconciliation summary
7. **Recovery score breakdown** — Per-factor progress bars (Failure Type, Payment History, Retry History, Amount, Recency) with data-unavailable annotation
8. **Generation mode badge** — "✦ AI Enhanced" (purple) or "⊙ Deterministic" (slate) indicating M7B AI usage

### Demo scenarios

| Demo | Payment ID | Expected |
|------|-----------|---------|
| Captured | `pay_TUJOzQxoEqFSLU` | CAPTURED · Score 73 · NO_ACTION |
| Bank Failure | `pay_TUJULUouXtIq8y` | FAILED · BANK_DECLINE · RETRY_PAYMENT |
| Unknown | `pay_DEMO_UNKNOWN00` | UNKNOWN · INSUFFICIENT_EVIDENCE |

All scenarios are selectable via one-click demo buttons.

### Loading / Error / Empty states

- **Empty**: clear prompt to enter a payment ID
- **Loading**: spinner with "Running recovery analysis pipeline…"
- **Error**: inline error card with human-readable message
- **Partial failure**: reconciliation gracefully degrades if API is unreachable

### Visual design

- Dark fintech theme (`#0a0d14` base)
- Status badges with semantic color coding (green/amber/red/blue/purple/slate)
- Animated SVG score ring with tier-appropriate color
- Per-factor horizontal progress bars
- Responsive 2-column grid (collapses to single column on mobile)
- Sticky header with product branding

### Build / Test / Lint status

- `npm run build` → exit 0 (page registered as `○ /` static)
- `npm test` → 234/234 pass (no regressions)
- `npm run lint` → exit 0 (same pre-existing M1 warning)
- TypeScript: no new errors

### Database changes

None. M8 is a pure frontend layer.

### Milestone commits

```
feat: implement merchant dashboard (M8)
docs: finalize M8 milestone
```

---

## Milestone 9 — End-to-End Demo and Polish

**Status: COMPLETE**

### Objective

Verify the full product pipeline end-to-end, fix any correctness or reliability issues, and prepare for a live 4–5 minute contest demo.

### What was done

| Task | Result |
|------|--------|
| Full codebase inspection (M1–M8) | No architectural issues found |
| `npm test` | 234/234 pass (no regressions) |
| `npm run build` | Exit 0, all routes registered |
| `npm run lint` | Exit 0 (1 pre-existing M1 warning, 0 errors) |
| Three demo scenarios verified | See below |
| M7B AI/deterministic paths verified | Deterministic path confirmed |
| **Bug fix**: `pay_DEMO_UNKNOWN00` → `pay_DEMOUNKNOWN000` | Fixed |
| README rewritten | Concise reviewer-ready documentation |

### Bug fixed

**`pay_DEMO_UNKNOWN00` failed validation.**

The `pay_DEMO_UNKNOWN00` ID contains an underscore in its suffix, which violates the `^pay_[A-Za-z0-9]{1,}$` validation regex used by both the client and API routes. Clicking the "Unknown" quick-demo button showed a validation error instead of the expected INSUFFICIENT_EVIDENCE result.

**Fix**: Changed to `pay_DEMOUNKNOWN000` (alphanumeric only). No other files changed.

### Demo scenarios — verified results

| Scenario | Payment ID | webhookState | category | action | generation.mode |
|----------|-----------|-------------|---------|--------|----------------|
| A — Bank Failure | `pay_TUJULUouXtIq8y` | FAILED | BANK_DECLINE | RETRY_PAYMENT | deterministic |
| B — Captured | `pay_TUJOzQxoEqFSLU` | CAPTURED | CAPTURED | NO_ACTION | deterministic |
| C — Unknown | `pay_DEMOUNKNOWN000` | UNKNOWN | INSUFFICIENT_EVIDENCE | COLLECT_MORE_EVIDENCE | deterministic |

**Note on recovery scores**: The `recoveryScore` and `recoveryTier` include a time-based recency factor. As the payments age, the score decreases. The values in earlier milestone docs (79, 73) used a fixed reference timestamp (2026-09-01). Live values at demo time reflect actual wall-clock age. All stable authoritative fields (state, category, action, confidence, tier-to-score mapping) remain correct.

### AI path verified

- `GEMINI_API_KEY` is absent from `.env.local` → deterministic fallback confirmed.
- `generation.mode = "deterministic"` for all three scenarios.
- Deterministic path works identically with or without the Gemini package.
- If a key is added, `enhanceWithAi()` will attempt AI enhancement; any failure returns the deterministic result unchanged.

### Build / Test / Lint status

- `npm test` → 234/234 pass
- `npm run build` → exit 0 (all routes registered)
- `npm run lint` → exit 0 (1 pre-existing M1 warning, 0 errors)
- TypeScript: no new errors

### Database changes

None.

### Milestone commits

```
fix: correct Unknown demo payment ID for validation (M9)
docs: complete M9 milestone documentation
```
