"use client";

import { useState, useCallback, useRef } from "react";

// ─── Types matching the real API response contracts ────────────────────────────

interface DiagnosisResult {
  paymentId: string;
  webhookState: "CAPTURED" | "AUTHORIZED" | "FAILED" | "UNKNOWN";
  recoveryScore: number;
  recoveryTier: "HIGH" | "MEDIUM" | "LOW";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  diagnosis: {
    category: string;
    summary: string;
    evidence: string[];
  };
  recommendation: {
    action: string;
    priority: "HIGH" | "MEDIUM" | "LOW";
    message: string;
  };
  generation: {
    mode: "deterministic" | "ai";
  };
  factors?: ScoreFactor[];
}

interface ScoreFactor {
  factor: string;
  available: boolean;
  points: number;
  maxPoints: number;
  reason: string;
}

interface ReconciliationResult {
  paymentId: string;
  outcome: string;
  webhookState: string;
  apiObservation: null | {
    razorpayStatus?: string;
    status?: string;
    captured?: boolean;
    amount?: number;
    currency?: string;
    errorSource?: string | null;
  };
  summary: string;
  reconciledAt: string;
}

interface RecoveryScoreResult {
  paymentId: string;
  webhookState: string;
  recoveryScore: number;
  recoveryTier: string;
  confidence: string;
  factors: ScoreFactor[];
  scoredAt: string;
}

interface DashboardData {
  diagnosis: DiagnosisResult;
  reconciliation: ReconciliationResult | null;
  score: RecoveryScoreResult;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEMO_PAYMENTS = [
  { id: "pay_TUJOzQxoEqFSLU", label: "Captured", hint: "CAPTURED · NO_ACTION" },
  { id: "pay_TUJULUouXtIq8y", label: "Bank Failure", hint: "FAILED · BANK_DECLINE" },
  { id: "pay_DEMOUNKNOWN000", label: "Unknown", hint: "UNKNOWN · INSUFFICIENT EVIDENCE" },
];

const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{1,}$/;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function stateBadgeClass(state: string): string {
  switch (state?.toUpperCase()) {
    case "CAPTURED":   return "badge-captured";
    case "AUTHORIZED": return "badge-authorized";
    case "FAILED":     return "badge-failed";
    default:           return "badge-unknown";
  }
}

function tierBadgeClass(tier: string): string {
  switch (tier?.toUpperCase()) {
    case "HIGH":   return "badge-high";
    case "MEDIUM": return "badge-medium";
    case "LOW":    return "badge-low";
    default:       return "badge-unknown";
  }
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "CONSISTENT":     return "var(--green)";
    case "API_AHEAD":      return "var(--amber)";
    case "WEBHOOK_AHEAD":  return "var(--amber)";
    case "API_ONLY":       return "var(--blue)";
    case "WEBHOOK_ONLY":   return "var(--blue)";
    case "NOT_FOUND":      return "var(--slate)";
    case "ERROR":          return "var(--red)";
    default:               return "var(--text-muted)";
  }
}

function factorLabel(key: string): string {
  const map: Record<string, string> = {
    failure_type:   "Failure Type",
    payment_history:"Pay History",
    retry_history:  "Retry History",
    amount_context: "Amount",
    recency:        "Recency",
  };
  return map[key] ?? key;
}

function factorBarColor(points: number, maxPoints: number): string {
  const ratio = points / maxPoints;
  if (ratio >= 0.7) return "var(--green)";
  if (ratio >= 0.4) return "var(--amber)";
  return "var(--red)";
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    CAPTURED:               "Payment Captured",
    AUTHORIZED:             "Payment Authorized",
    BANK_DECLINE:           "Bank Decline",
    CUSTOMER_ACTION_REQUIRED: "Customer Action Required",
    BUSINESS_CONFIGURATION: "Business Configuration Error",
    INFRASTRUCTURE_FAILURE: "Infrastructure Failure",
    UNKNOWN_PAYMENT_STATE:  "Unknown Payment State",
    INSUFFICIENT_EVIDENCE:  "Insufficient Evidence",
  };
  return map[cat] ?? cat.replace(/_/g, " ");
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    NO_ACTION:                  "No Action Required",
    CHECK_CAPTURE_STATUS:       "Check Capture Status",
    RETRY_PAYMENT:              "Retry Payment",
    CUSTOMER_ACTION_REQUIRED:   "Contact Customer",
    REVIEW_MERCHANT_CONFIGURATION: "Review Configuration",
    COLLECT_MORE_EVIDENCE:      "Collect More Evidence",
  };
  return map[action] ?? action.replace(/_/g, " ");
}

function actionIcon(action: string): string {
  const map: Record<string, string> = {
    NO_ACTION:                     "✅",
    CHECK_CAPTURE_STATUS:          "🔍",
    RETRY_PAYMENT:                 "🔁",
    CUSTOMER_ACTION_REQUIRED:      "📞",
    REVIEW_MERCHANT_CONFIGURATION: "⚙️",
    COLLECT_MORE_EVIDENCE:         "📋",
  };
  return map[action] ?? "💡";
}

// ─── Recovery Score Arc ───────────────────────────────────────────────────────

function ScoreRing({ score, tier }: { score: number; tier: string }) {
  const radius = 38;
  const circ = 2 * Math.PI * radius;
  const fill = (score / 100) * circ;
  const strokeColor =
    tier === "HIGH" ? "var(--green)" :
    tier === "MEDIUM" ? "var(--amber)" :
    "var(--red)";

  return (
    <div className="score-ring-wrap">
      <div className="score-ring">
        <svg width="100" height="100" viewBox="0 0 100 100">
          {/* Track */}
          <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--border)" strokeWidth="8" />
          {/* Fill */}
          <circle
            cx="50" cy="50" r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth="8"
            strokeDasharray={`${fill} ${circ}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="score-ring-text">
          <span className="score-number">{score}</span>
          <span className="score-denom">/100</span>
        </div>
      </div>
      <div className="score-ring-label">Recovery Score</div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [inputVal, setInputVal] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const analyze = useCallback(async (paymentId: string) => {
    const id = paymentId.trim();
    if (!id) return;

    if (!PAYMENT_ID_RE.test(id)) {
      setError(`"${id}" is not a valid Razorpay payment ID. It must start with pay_ followed by alphanumeric characters.`);
      setData(null);
      return;
    }

    setLoading(true);
    setError(null);
    setData(null);

    try {
      // Fetch diagnosis (includes score fields) and reconciliation in parallel.
      // The diagnosis endpoint calls M7A/M7B which include all M6 score fields.
      // We also fetch the recovery-score endpoint separately for the factors breakdown.
      const [diagRes, reconRes, scoreRes] = await Promise.allSettled([
        fetch(`/api/diagnosis?paymentId=${encodeURIComponent(id)}`),
        fetch(`/api/reconciliation?paymentId=${encodeURIComponent(id)}`),
        fetch(`/api/recovery-score?paymentId=${encodeURIComponent(id)}`),
      ]);

      // Diagnosis is the primary result — required
      if (diagRes.status === "rejected") {
        throw new Error("Failed to reach the diagnosis service. Please try again.");
      }
      const diagResponse = diagRes.value;
      if (!diagResponse.ok) {
        const errBody = await diagResponse.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Diagnosis API returned ${diagResponse.status}`);
      }
      const diagnosis: DiagnosisResult = await diagResponse.json();

      // Reconciliation — optional, may fail
      let reconciliation: ReconciliationResult | null = null;
      if (reconRes.status === "fulfilled" && reconRes.value.ok) {
        reconciliation = await reconRes.value.json().catch(() => null);
      }

      // Recovery score — for detailed factors breakdown
      let score: RecoveryScoreResult | null = null;
      if (scoreRes.status === "fulfilled" && scoreRes.value.ok) {
        score = await scoreRes.value.json().catch(() => null);
      }

      // Fallback: construct a minimal score object from diagnosis if needed
      const finalScore: RecoveryScoreResult = score ?? {
        paymentId: diagnosis.paymentId,
        webhookState: diagnosis.webhookState,
        recoveryScore: diagnosis.recoveryScore,
        recoveryTier: diagnosis.recoveryTier,
        confidence: diagnosis.confidence,
        factors: [],
        scoredAt: new Date().toISOString(),
      };

      setData({ diagnosis, reconciliation, score: finalScore });
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    analyze(inputVal);
  };

  const selectDemo = (id: string) => {
    setInputVal(id);
    analyze(id);
  };

  const d = data;

  return (
    <>
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="header">
        <div className="header-logo">
          <div className="header-logo-icon">💳</div>
          <span className="header-product">RecoverAI</span>
        </div>
        <div className="header-sep" />
        <span className="header-subtitle">Payment Recovery Console</span>
        <span className="header-badge">Razorpay Buildathon</span>
      </header>

      {/* ── Main ───────────────────────────────────────────── */}
      <main className="main">

        {/* ── Search ─────────────────────────────────────── */}
        <section className="search-section">
          <label htmlFor="payment-id-input" className="search-label">
            Analyze Payment
          </label>
          <form onSubmit={handleSubmit}>
            <div className="search-row">
              <input
                ref={inputRef}
                id="payment-id-input"
                className="search-input"
                type="text"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                placeholder="pay_xxxxxxxxxxxxxxxx"
                autoComplete="off"
                spellCheck={false}
                aria-label="Razorpay Payment ID"
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={loading || !inputVal.trim()}
                aria-label="Analyze payment"
              >
                {loading ? (
                  <>
                    <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                    Analyzing…
                  </>
                ) : (
                  <>🔍 Analyze</>
                )}
              </button>
            </div>
          </form>

          <div className="demo-row">
            <span className="demo-label">Quick demo:</span>
            {DEMO_PAYMENTS.map(p => (
              <button
                key={p.id}
                className="btn-demo"
                onClick={() => selectDemo(p.id)}
                title={`${p.id} — ${p.hint}`}
                type="button"
              >
                {p.label}
              </button>
            ))}
          </div>
        </section>

        {/* ── Error ──────────────────────────────────────── */}
        {error && !loading && (
          <div className="state-error" role="alert">
            <span className="state-error-icon">⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {/* ── Loading ─────────────────────────────────────── */}
        {loading && (
          <div className="state-loading" aria-live="polite">
            <div className="spinner" />
            <span>Running recovery analysis pipeline…</span>
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────── */}
        {!loading && !error && !d && (
          <div className="state-empty">
            <span className="state-empty-icon" aria-hidden>🔍</span>
            <p className="state-empty-title">No payment selected</p>
            <p className="state-empty-sub">
              Enter a Razorpay payment ID above or select a demo scenario to run the full recovery analysis pipeline.
            </p>
          </div>
        )}

        {/* ── Results ─────────────────────────────────────── */}
        {!loading && d && (
          <div className="results-grid">

            {/* ── Overview + Score ──────────────────────── */}
            <div className="card overview-card card-full">
              <div>
                <div className="card-header">
                  <span className="card-icon">💳</span>
                  <span className="card-title">Payment Overview</span>
                  <span
                    className={`gen-badge ${d.diagnosis.generation.mode === "ai" ? "badge-ai" : "badge-det"}`}
                    style={{ marginLeft: "auto" }}
                    title={
                      d.diagnosis.generation.mode === "ai"
                        ? "Explanation enhanced by Gemini AI"
                        : "Deterministic analysis — no AI configured or AI unavailable"
                    }
                  >
                    {d.diagnosis.generation.mode === "ai" ? "✦ AI Enhanced" : "⊙ Deterministic"}
                  </span>
                </div>
                <div className="overview-payment-id">{d.diagnosis.paymentId}</div>
                <div className="overview-state-row">
                  <span className={`state-badge ${stateBadgeClass(d.diagnosis.webhookState)}`}>
                    <span className="state-badge-dot" style={{
                      background:
                        d.diagnosis.webhookState === "CAPTURED" ? "var(--green)" :
                        d.diagnosis.webhookState === "AUTHORIZED" ? "var(--blue)" :
                        d.diagnosis.webhookState === "FAILED" ? "var(--red)" :
                        "var(--slate)"
                    }} />
                    {d.diagnosis.webhookState}
                  </span>
                  <span className={`state-badge ${tierBadgeClass(d.diagnosis.recoveryTier)}`}>
                    {d.diagnosis.recoveryTier} Recoverability
                  </span>
                  <span className={`state-badge ${tierBadgeClass(d.diagnosis.confidence)}`}>
                    {d.diagnosis.confidence} Confidence
                  </span>
                </div>
              </div>
              <ScoreRing score={d.diagnosis.recoveryScore} tier={d.diagnosis.recoveryTier} />
            </div>

            {/* ── Diagnosis ─────────────────────────────── */}
            <div className="card">
              <div className="card-header">
                <span className="card-icon">🩺</span>
                <span className="card-title">Diagnosis</span>
              </div>
              <div className="diagnosis-category">
                {categoryLabel(d.diagnosis.diagnosis.category)}
              </div>
              <p className="diagnosis-summary">{d.diagnosis.diagnosis.summary}</p>
              <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.6rem" }}>
                Evidence
              </div>
              <ul className="evidence-list">
                {d.diagnosis.diagnosis.evidence.map((ev, i) => (
                  <li key={i} className="evidence-item">
                    <span className="evidence-dot" aria-hidden />
                    {ev}
                  </li>
                ))}
              </ul>
            </div>

            {/* ── Recommendation ────────────────────────── */}
            <div className="card">
              <div className="card-header">
                <span className="card-icon">💡</span>
                <span className="card-title">Recommendation</span>
              </div>
              <div className="rec-action-row">
                <span className="rec-action">
                  {actionIcon(d.diagnosis.recommendation.action)}{" "}
                  {actionLabel(d.diagnosis.recommendation.action)}
                </span>
                <span className={`state-badge ${tierBadgeClass(d.diagnosis.recommendation.priority)}`}>
                  {d.diagnosis.recommendation.priority} Priority
                </span>
              </div>
              <p className="rec-message">{d.diagnosis.recommendation.message}</p>
            </div>

            {/* ── Reconciliation ────────────────────────── */}
            <div className="card">
              <div className="card-header">
                <span className="card-icon">⚖️</span>
                <span className="card-title">Evidence Reconciliation</span>
              </div>
              {d.reconciliation ? (
                <>
                  <div className="recon-sources">
                    <div className="recon-source">
                      <div className="recon-source-label">Webhook (M3)</div>
                      <div
                        className={`recon-source-val state-badge ${stateBadgeClass(d.reconciliation.webhookState)}`}
                        style={{ display: "inline-flex" }}
                      >
                        {d.reconciliation.webhookState}
                      </div>
                    </div>
                    <div className="recon-arrow">→</div>
                    <div className="recon-source">
                      <div className="recon-source-label">Razorpay API (M4)</div>
                      <div
                        className={`recon-source-val state-badge ${stateBadgeClass(
                          d.reconciliation.apiObservation?.razorpayStatus?.toUpperCase() ??
                          d.reconciliation.apiObservation?.status?.toUpperCase() ??
                          "UNKNOWN"
                        )}`}
                        style={{ display: "inline-flex" }}
                      >
                        {d.reconciliation.apiObservation?.razorpayStatus ??
                         d.reconciliation.apiObservation?.status ??
                         "N/A"}
                      </div>
                    </div>
                  </div>
                  <div className="recon-outcome-row">
                    <span className="recon-outcome-label">Outcome</span>
                    <span
                      className="recon-outcome-val"
                      style={{ color: outcomeColor(d.reconciliation.outcome) }}
                    >
                      {d.reconciliation.outcome.replace(/_/g, " ")}
                    </span>
                  </div>
                  {d.reconciliation.summary && (
                    <p className="recon-summary">{d.reconciliation.summary}</p>
                  )}
                </>
              ) : (
                <p style={{ fontSize: "0.88rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                  Reconciliation data unavailable (Razorpay API may be unreachable or payment unknown).
                </p>
              )}
            </div>

            {/* ── Scoring Factors ───────────────────────── */}
            {d.score.factors && d.score.factors.length > 0 && (
              <div className="card card-full">
                <div className="card-header">
                  <span className="card-icon">📊</span>
                  <span className="card-title">Recovery Score Breakdown</span>
                </div>
                <div className="factors-grid">
                  {d.score.factors.map((f) => (
                    <div key={f.factor} className="factor-card" title={f.reason}>
                      <div className="factor-name">{factorLabel(f.factor)}</div>
                      <div className="factor-bar-wrap">
                        <div
                          className="factor-bar"
                          style={{
                            width: `${(f.points / f.maxPoints) * 100}%`,
                            background: factorBarColor(f.points, f.maxPoints),
                          }}
                        />
                      </div>
                      <div>
                        <span className="factor-pts">{f.points}</span>
                        <span className="factor-max"> / {f.maxPoints}</span>
                      </div>
                      {!f.available && (
                        <div className="factor-unavail">Data unavailable</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}
      </main>
    </>
  );
}
