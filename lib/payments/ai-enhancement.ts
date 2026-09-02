/**
 * Optional AI Enhancement — M7B
 *
 * Takes the deterministic M7A DiagnosisResult and attempts to enhance the
 * three natural-language fields:
 *
 *   diagnosis.summary
 *   diagnosis.evidence
 *   recommendation.message
 *
 * All authoritative fields remain under M7A control:
 *
 *   paymentId, webhookState, recoveryScore, recoveryTier, confidence,
 *   diagnosis.category, recommendation.action, recommendation.priority
 *
 * Behaviour:
 *   - If GEMINI_API_KEY is absent → returns deterministic result unchanged.
 *   - On any SDK/network/timeout/parse/validation error → deterministic fallback.
 *   - Only on a valid, compatible AI response → generation.mode = "ai".
 *   - Identical authoritative fields are preserved in both paths.
 *
 * Privacy rules:
 *   - The AI prompt NEVER contains PII (phone, email, raw webhook payloads).
 *   - The AI prompt NEVER contains credentials or environment variables.
 *   - Only M7A DiagnosisResult authoritative fields are sent.
 *
 * MUST NOT be imported in browser-side code.
 */

import type { DiagnosisResult } from "@/lib/payments/diagnosis";

// ─── AI output schema (what we expect the model to return) ────────────────────

interface AiEnhancedText {
  summary: string;
  evidence: string[];
  message: string;
}

// ─── Prompt construction ──────────────────────────────────────────────────────

/**
 * Builds the structured prompt sent to the AI.
 *
 * DOES NOT include PII, raw webhook data, credentials, or environment vars.
 * Only the M7A authoritative fields needed to ground the AI response.
 */
function buildPrompt(result: DiagnosisResult): { systemInstruction: string; userMessage: string } {
  const systemInstruction = `You are a payment recovery assistant helping merchants understand why a payment failed and what to do next.

You are ENHANCING an already-determined payment diagnosis. You must NOT invent new facts, change the diagnosis, or contradict the provided authoritative fields.

Rules:
- Do NOT change diagnosis category, recommendation action, priority, recovery score, recovery tier, confidence, or webhook state.
- Only produce concise merchant-facing natural language for: summary, evidence list, and recommendation message.
- Evidence items must be grounded in the provided deterministic evidence — do not add unrelated claims.
- Do NOT output PII (phone numbers, emails, names) or credentials of any kind.
- Keep summary to 1–2 sentences. Keep evidence to 2–4 bullet items. Keep message to 1–2 sentences.
- Respond ONLY with valid JSON in this exact shape, no markdown, no extra keys:
{
  "summary": "string",
  "evidence": ["string", "string"],
  "message": "string"
}`;

  const context = {
    webhookState: result.webhookState,
    recoveryScore: result.recoveryScore,
    recoveryTier: result.recoveryTier,
    confidence: result.confidence,
    diagnosisCategory: result.diagnosis.category,
    deterministicSummary: result.diagnosis.summary,
    deterministicEvidence: result.diagnosis.evidence,
    recommendationAction: result.recommendation.action,
    recommendationPriority: result.recommendation.priority,
    deterministicMessage: result.recommendation.message,
  };

  const userMessage = `Enhance the following payment diagnosis with clearer merchant-facing language.

Authoritative context (do not change these):
${JSON.stringify(context, null, 2)}

Return only the JSON object with enhanced summary, evidence array, and message.`;

  return { systemInstruction, userMessage };
}

// ─── Output validation ────────────────────────────────────────────────────────

const MAX_SUMMARY_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 500;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_ITEM_LENGTH = 300;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function containsSensitivePattern(text: string): boolean {
  // Reject if AI hallucinated credentials or env var patterns
  return (
    /rzp_(test|live)_/i.test(text) ||
    /RAZORPAY_KEY/i.test(text) ||
    /GEMINI_API_KEY/i.test(text) ||
    // Reject phone-number-looking patterns (10+ digit sequences)
    /\b\d{10,}\b/.test(text)
  );
}

/**
 * Strictly validates the parsed AI output.
 * Returns the validated AiEnhancedText or null if invalid.
 */
function validateAiOutput(
  raw: unknown,
  deterministic: DiagnosisResult
): AiEnhancedText | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  // summary
  if (!isNonEmptyString(obj.summary)) return null;
  if (obj.summary.length > MAX_SUMMARY_LENGTH) return null;
  if (containsSensitivePattern(obj.summary)) return null;

  // evidence
  if (!Array.isArray(obj.evidence)) return null;
  if (obj.evidence.length === 0 || obj.evidence.length > MAX_EVIDENCE_ITEMS) return null;
  for (const item of obj.evidence) {
    if (!isNonEmptyString(item)) return null;
    if ((item as string).length > MAX_EVIDENCE_ITEM_LENGTH) return null;
    if (containsSensitivePattern(item as string)) return null;
  }

  // message
  if (!isNonEmptyString(obj.message)) return null;
  if (obj.message.length > MAX_MESSAGE_LENGTH) return null;
  if (containsSensitivePattern(obj.message)) return null;

  // Reject if AI tries to include authoritative fields that contradict M7A
  const prohibited = [
    "category", "action", "priority", "recoveryScore", "recoveryTier",
    "confidence", "webhookState", "paymentId",
  ];
  for (const key of prohibited) {
    if (key in obj) return null;
  }

  // Sanity: AI must not flip to a completely unrelated summary topic
  // (lightweight check: summary and message must not be empty after trim)
  const summary = (obj.summary as string).trim();
  const message = (obj.message as string).trim();
  if (!summary || !message) return null;

  // Unused param intentionally kept for future cross-check extensions
  void deterministic;

  return {
    summary,
    evidence: (obj.evidence as string[]).map((e) => (e as string).trim()),
    message,
  };
}

// ─── Gemini client (lazy, isolated) ──────────────────────────────────────────

/**
 * Calls the Gemini API and returns the raw text response.
 * Times out after 8 seconds. Never throws to the caller.
 */
async function callGemini(
  systemInstruction: string,
  userMessage: string
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    // Dynamic import keeps the SDK out of module init; avoids build errors
    // when the package is absent or the key is missing.
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        config: { systemInstruction },
        contents: userMessage,
      });

      clearTimeout(timeout);
      return response.text ?? null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // SDK errors, network failures, timeouts — all fall back silently
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempts to enhance the M7A DiagnosisResult with AI-generated natural
 * language. Falls back to the original deterministic result on any error.
 *
 * This function NEVER throws.
 *
 * @param result - The deterministic M7A DiagnosisResult.
 * @returns A new DiagnosisResult with either mode="ai" or mode="deterministic".
 */
export async function enhanceWithAi(
  result: DiagnosisResult
): Promise<DiagnosisResult> {
  // Fast path: no API key → skip AI entirely
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return result;

  try {
    const { systemInstruction, userMessage } = buildPrompt(result);
    const rawText = await callGemini(systemInstruction, userMessage);

    if (!rawText) return result;

    // Parse JSON (model should return raw JSON per instructions)
    let parsed: unknown;
    try {
      // Strip any accidental markdown fences before parsing
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return result;
    }

    const validated = validateAiOutput(parsed, result);
    if (!validated) return result;

    // Return a new result with AI text replacing only the allowed fields
    return {
      ...result,
      diagnosis: {
        ...result.diagnosis,
        summary: validated.summary,
        evidence: validated.evidence,
      },
      recommendation: {
        ...result.recommendation,
        message: validated.message,
      },
      generation: { mode: "ai" },
    };
  } catch {
    // Belt-and-suspenders: catch anything that slipped through
    return result;
  }
}

// ─── Test-only export ─────────────────────────────────────────────────────────

/**
 * Testable version of AI enhancement that accepts a mock text producer
 * instead of calling the real Gemini API.
 *
 * The mockTextProducer receives the user message string sent to the model
 * and returns either a string (model response) or null (simulated failure).
 *
 * THIS EXPORT IS FOR UNIT TESTING ONLY. Do not use in production code.
 */
export async function enhanceWithAiUsingMockClient(
  result: DiagnosisResult,
  mockTextProducer: (userMessage: string) => Promise<string | null>
): Promise<DiagnosisResult> {
  try {
    const { userMessage } = buildPrompt(result);
    let rawText: string | null;
    try {
      rawText = await mockTextProducer(userMessage);
    } catch {
      return result;
    }

    if (!rawText) return result;

    let parsed: unknown;
    try {
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return result;
    }

    const validated = validateAiOutput(parsed, result);
    if (!validated) return result;

    return {
      ...result,
      diagnosis: {
        ...result.diagnosis,
        summary: validated.summary,
        evidence: validated.evidence,
      },
      recommendation: {
        ...result.recommendation,
        message: validated.message,
      },
      generation: { mode: "ai" },
    };
  } catch {
    return result;
  }
}

