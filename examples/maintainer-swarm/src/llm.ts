/**
 * llm.ts — Thin LLM wrapper for MaintainerSwarm agents.
 *
 * Provider priority (first key found wins):
 *   1. OPENAI_API_KEY    → OpenAI  (gpt-4o-mini or OPENAI_MODEL)
 *   2. ANTHROPIC_API_KEY → Anthropic (claude-3-5-haiku or ANTHROPIC_MODEL)
 *   3. GROQ_API_KEY      → Groq via OpenAI-compatible API
 *
 * Modes (STATE_CAPSULE_MODE):
 *   live   (default) — call provider, return response
 *   record            — call provider, append to transcript JSONL
 *   replay            — read from transcript JSONL, throw on miss
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Public types ──────────────────────────────────────────────────────────────

export interface LLMRequest {
  /** Human-readable tag used as the replay/record key (e.g. "triager:task-123"). */
  tag: string;
  system: string;
  user: string;
  maxTokens?: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

type Mode = "live" | "record" | "replay";

const MODE = (process.env["STATE_CAPSULE_MODE"] ?? "live") as Mode;
const TRANSCRIPT =
  process.env["STATE_CAPSULE_REPLAY_TRANSCRIPT"] ??
  "./examples/maintainer-swarm/replay/golden.jsonl";

// ── Provider dispatch ─────────────────────────────────────────────────────────

type Provider = "openai" | "anthropic" | "groq";

function detectProvider(): Provider {
  if (process.env["OPENAI_API_KEY"])    return "openai";
  if (process.env["ANTHROPIC_API_KEY"]) return "anthropic";
  if (process.env["GROQ_API_KEY"])      return "groq";
  throw new Error(
    "No LLM key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY.",
  );
}

async function callOpenAICompat(
  req: LLMRequest,
  apiKey: string,
  opts: { baseURL?: string; defaultModel: string },
): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  const model = process.env["OPENAI_MODEL"] ?? opts.defaultModel;
  const completion = await client.chat.completions.create({
    model,
    max_tokens: req.maxTokens ?? 2048,
    messages: [
      { role: "system", content: req.system },
      { role: "user",   content: req.user   },
    ],
  });
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("Empty response from OpenAI-compatible API");
  return text;
}

async function callAnthropic(req: LLMRequest): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
  const model  = process.env["ANTHROPIC_MODEL"] ?? "claude-3-5-haiku-20241022";
  const msg = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? 2048,
    system:     req.system,
    messages:   [{ role: "user", content: req.user }],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("Empty response from Anthropic");
  return block.text;
}

async function dispatchProvider(req: LLMRequest): Promise<string> {
  const provider = detectProvider();
  switch (provider) {
    case "openai":
      return callOpenAICompat(req, process.env["OPENAI_API_KEY"]!, {
        defaultModel: "gpt-4o-mini",
      });
    case "anthropic":
      return callAnthropic(req);
    case "groq":
      return callOpenAICompat(req, process.env["GROQ_API_KEY"]!, {
        baseURL:      "https://api.groq.com/openai/v1",
        defaultModel: "llama-3.3-70b-versatile",
      });
  }
}

// ── Transcript helpers ────────────────────────────────────────────────────────

interface TranscriptEntry {
  tag:      string;
  response: string;
}

let _transcriptCache: Map<string, string> | null = null;

function loadTranscript(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(TRANSCRIPT)) return map;
  const lines = readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      if (!map.has(entry.tag)) map.set(entry.tag, entry.response);
    } catch { /* skip malformed lines */ }
  }
  return map;
}

function transcript(): Map<string, string> {
  _transcriptCache ??= loadTranscript();
  return _transcriptCache;
}

function appendTranscript(tag: string, response: string): void {
  const dir = dirname(TRANSCRIPT);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry: TranscriptEntry = { tag, response };
  appendFileSync(TRANSCRIPT, JSON.stringify(entry) + "\n", "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call the LLM with a system+user prompt pair.
 *
 * In replay mode the transcript must already contain an entry for `req.tag`;
 * in record mode the call is forwarded to the provider and the response is
 * appended to the transcript for later replay.
 */
export async function callLLM(req: LLMRequest): Promise<string> {
  if (MODE === "replay") {
    const cached = transcript().get(req.tag);
    if (!cached) {
      throw new Error(
        `[llm] No replay entry for tag "${req.tag}". Run in record mode first.`,
      );
    }
    console.log(`[llm] replay hit: ${req.tag}`);
    return cached;
  }

  const response = await dispatchProvider(req);

  if (MODE === "record") {
    appendTranscript(req.tag, response);
    console.log(`[llm] recorded: ${req.tag}`);
  }

  return response;
}

/**
 * Extract a JSON object or array from an LLM response.
 * Handles markdown code-fenced blocks and leading/trailing prose.
 */
export function extractJSON(text: string): string {
  // Strip ```json ... ``` or ``` ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();

  // Fall back: slice from the first structural character to the last
  const firstBrace   = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const start =
    firstBrace === -1   ? firstBracket :
    firstBracket === -1 ? firstBrace   :
    Math.min(firstBrace, firstBracket);

  const lastBrace   = text.lastIndexOf("}");
  const lastBracket = text.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);

  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1).trim();
  }

  return text.trim();
}
