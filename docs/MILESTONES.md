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

## Upcoming Milestones

| Milestone | Title |
|-----------|-------|
| M3 | Payment status polling fallback |
| M4 | Recovery state and recovered revenue tracking |
| M5 | Deterministic recovery scoring |
| M6 | AI diagnosis and recommendation |
| M7 | Merchant dashboard |
| M8 | End-to-end demo and polish |

Implementation details for M3–M8 are not yet defined.
