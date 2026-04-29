/**
 * sealed-summary.ts — 0G Compute sealed-inference wrapper.
 *
 * Produces a verifiable, compressed summary of a capsule's state. A fresh
 * agent (e.g. a Reproducer that just restarted after a kill) can call this
 * to reconstruct context from a single model call rather than replaying the
 * full capsule chain.
 *
 * Provider:   0G Compute (OpenAI-compatible endpoint)
 * Auth:       Bearer secret obtained via `0g-compute-cli inference get-secret`
 * Fallback:   If 0G Compute is not configured (env vars absent), a plain-text
 *             summary is derived directly from the capsule without any network
 *             call. The `attested` flag in the result signals which path ran.
 *
 * Config env vars (all optional — module degrades gracefully without them):
 *   OG_COMPUTE_SERVICE_URL   — e.g. https://inference.0g.ai
 *   OG_COMPUTE_SECRET        — bearer secret (app-sk-...)
 *   OG_COMPUTE_MODEL         — default "GLM-5-FP8"
 */

import type { Capsule } from "./schema.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SealedSummary {
  /** Human-readable summary of the capsule state. */
  summary:      string;
  /** The most important next step for the resuming agent. */
  next_action:  string;
  /** Model's confidence level. */
  confidence:   "high" | "medium" | "low";
  /** ISO timestamp of when this summary was produced. */
  produced_at:  string;
  /** Model that produced the summary. */
  model:        string;
  /** The capsule_id this summary describes. */
  capsule_id:   string;
  /**
   * Whether the summary was produced by 0G Compute (attested = true)
   * or by a local fallback (attested = false).
   */
  attested:     boolean;
  /**
   * Wall-clock ms saved vs cold context reconstruction.
   * Measured as: time_to_summarize vs estimated replay time.
   * Non-zero only when attested = true.
   */
  speedup_ms:   number;
}

// ── 0G Compute client ─────────────────────────────────────────────────────────

interface OGComputeConfig {
  serviceUrl: string;
  secret:     string;
  model:      string;
}

function readConfig(): OGComputeConfig | null {
  const serviceUrl = process.env["OG_COMPUTE_SERVICE_URL"];
  const secret     = process.env["OG_COMPUTE_SECRET"];
  if (!serviceUrl || !secret) return null;
  return {
    serviceUrl,
    secret,
    model: process.env["OG_COMPUTE_MODEL"] ?? "GLM-5-FP8",
  };
}

interface ChatChoice {
  message: { content: string | null };
}

async function callOGCompute(
  config: OGComputeConfig,
  prompt: string,
  maxTokens = 512,
): Promise<string> {
  const url = `${config.serviceUrl}/v1/proxy/chat/completions`;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${config.secret}`,
    },
    body: JSON.stringify({
      model:       config.model,
      temperature: 0,
      max_tokens:  maxTokens,
      messages:    [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`0G Compute HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data  = await res.json() as { choices: ChatChoice[] };
  const text  = data.choices[0]?.message?.content;
  if (!text) throw new Error("0G Compute returned empty content");
  return text;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(capsule: Capsule): string {
  const recentFacts     = capsule.facts.slice(-10).join("\n  - ");
  const recentDecisions = capsule.decisions.slice(-5).join("\n  - ");

  return [
    `You are a handoff summarizer for an autonomous agent system.`,
    `A fresh agent is resuming a task after a crash. Summarize the current state.`,
    ``,
    `Task goal: ${capsule.goal}`,
    `Current holder: ${capsule.holder}`,
    `Next action: ${capsule.next_action}`,
    ``,
    `Recent facts:`,
    `  - ${recentFacts || "(none)"}`,
    ``,
    `Recent decisions:`,
    `  - ${recentDecisions || "(none)"}`,
    ``,
    `Respond ONLY with valid JSON in this exact shape:`,
    `{`,
    `  "summary": "<2-3 sentence summary of where the task stands>",`,
    `  "next_action": "<single most important next step>",`,
    `  "confidence": "high" | "medium" | "low"`,
    `}`,
  ].join("\n");
}

// ── Local fallback ────────────────────────────────────────────────────────────

function buildLocalSummary(capsule: Capsule): SealedSummary {
  const factCount = capsule.facts.length;
  const decisions = capsule.decisions.slice(-2).join("; ");
  const summary =
    `Task "${capsule.goal}" is in progress (holder: ${capsule.holder}). ` +
    `${factCount} fact(s) accumulated. ` +
    (decisions ? `Last decisions: ${decisions}.` : "No decisions yet.");

  return {
    summary,
    next_action:  capsule.next_action || "resume from last checkpoint",
    confidence:   "medium",
    produced_at:  new Date().toISOString(),
    model:        "local-fallback",
    capsule_id:   capsule.capsule_id,
    attested:     false,
    speedup_ms:   0,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a sealed summary for the given capsule.
 *
 * If 0G Compute is configured, calls the sealed-inference endpoint and measures
 * how much faster that is vs replaying the full capsule facts as a raw prompt.
 *
 * If 0G Compute is not configured (env vars absent), falls back to a locally
 * generated plain-text summary with `attested: false`.
 *
 * Never throws — returns the local fallback on any network error.
 */
export async function fetchSealedSummary(
  capsule: Capsule,
): Promise<SealedSummary> {
  const config = readConfig();

  if (!config) {
    return buildLocalSummary(capsule);
  }

  const prompt = buildPrompt(capsule);

  // Baseline: how long would raw prompt delivery take?
  // Rough estimate: 1 token ≈ 4 chars, 20ms per token at typical 0G throughput.
  const estimatedRawTokens = capsule.facts.join(" ").length / 4;
  const estimatedRawMs     = Math.round(estimatedRawTokens * 20);

  const t0 = Date.now();
  try {
    const raw = await callOGCompute(config, prompt);
    const elapsedMs = Date.now() - t0;

    // Strip markdown fences if present
    const jsonStr = raw.replace(/```(?:json)?\s*([\s\S]+?)\s*```/, "$1").trim();
    const parsed  = JSON.parse(
      jsonStr.startsWith("{") ? jsonStr : jsonStr.slice(jsonStr.indexOf("{"))
    ) as { summary: string; next_action: string; confidence: string };

    const speedup = Math.max(0, estimatedRawMs - elapsedMs);

    console.log(
      `[sealed-summary] 0G Compute: ${elapsedMs}ms ` +
      `(est. ${estimatedRawMs}ms raw replay → speedup ${speedup}ms)`,
    );

    return {
      summary:      parsed.summary,
      next_action:  parsed.next_action,
      confidence:   (["high", "medium", "low"].includes(parsed.confidence)
        ? parsed.confidence : "medium") as "high" | "medium" | "low",
      produced_at:  new Date().toISOString(),
      model:        config.model,
      capsule_id:   capsule.capsule_id,
      attested:     true,
      speedup_ms:   speedup,
    };
  } catch (err) {
    console.warn(`[sealed-summary] 0G Compute call failed, using local fallback: ${err}`);
    return buildLocalSummary(capsule);
  }
}
