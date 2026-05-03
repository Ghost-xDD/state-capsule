/**
 * run-store.ts — In-process store for active pipeline runs.
 *
 * Parses raw stdout lines from the demo pipeline into structured agent
 * state, an activity feed, and capsule metadata. The Next.js SSE route
 * reads this store; both the POST /api/run handler (which spawns the
 * child process) and the GET /api/run/[id]/stream handler (which serves
 * SSE) share the same module-level Map.
 *
 * Single-server demo only — would need Redis/DB for multi-replica.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentRole = "triager" | "reproducer" | "patcher" | "reviewer";

export type AgentStatus =
  | "idle"
  | "active"
  | "done"
  | "killed"
  | "resuming"
  | "error";

export interface AgentState {
  role: AgentRole;
  status: AgentStatus;
  /** Most recent activity line (e.g. "Generating patch…") */
  activity: string | null;
  /** Headline result for the panel (e.g. "3 bugs found") */
  summary: string | null;
  /** Output count for badge (bugs / tests / fixes) */
  count: number | null;
  /** True when the reproducer has been killed once (drives drama animation) */
  killed: boolean;
  /** Trigger value: bumped each time the panel transitions; used to fire CSS animations on the client */
  pulse: number;
}

export type ActivityType =
  | "phase"
  | "kill"
  | "resume"
  | "checkpoint"
  | "handoff"
  | "anchor"
  | "blob"
  | "compute"
  | "ens"
  | "complete"
  | "info";

export interface ActivityEvent {
  ts: number;
  type: ActivityType;
  agent?: AgentRole;
  message: string;
  capsuleId?: string;
  txHash?: string;
}

export interface CapsuleInfo {
  taskId: string;
  capsuleIds: string[];
  logRoots: string[];
  ensSub: string | null;
  txHashes: string[];
  verdict: string | null;
  patch: string | null;
  computeSummary: string | null;
  computeModel: string | null;
}

export interface RunEntry {
  repoUrl: string;
  repoFile: string;
  lines: string[];
  /** Incomplete trailing line from last stdout chunk (stream may split mid-line). */
  lineCarry: string;
  done: boolean;
  error: string | null;
  capsule: CapsuleInfo;
  agents: Record<AgentRole, AgentState>;
  activity: ActivityEvent[];
  startedAt: number;
}

// ── Store ─────────────────────────────────────────────────────────────────────

const store = new Map<string, RunEntry>();

function defaultAgent(role: AgentRole): AgentState {
  return {
    role,
    status: "idle",
    activity: null,
    summary: null,
    count: null,
    killed: false,
    pulse: 0,
  };
}

export function create(taskId: string, repoUrl: string, repoFile: string): void {
  store.set(taskId, {
    repoUrl,
    repoFile,
    lines: [],
    lineCarry: "",
    done: false,
    error: null,
    startedAt: Date.now(),
    capsule: {
      taskId,
      capsuleIds: [],
      logRoots: [],
      ensSub: null,
      txHashes: [],
      verdict: null,
      patch: null,
      computeSummary: null,
      computeModel: null,
    },
    agents: {
      triager:    defaultAgent("triager"),
      reproducer: defaultAgent("reproducer"),
      patcher:    defaultAgent("patcher"),
      reviewer:   defaultAgent("reviewer"),
    },
    activity: [],
  });
}

// ── ANSI regex ────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const strip = (s: string) => s.replace(ANSI_RE, "");

// ── Parsers ───────────────────────────────────────────────────────────────────

function bumpAgent(entry: RunEntry, role: AgentRole, patch: Partial<AgentState>): void {
  const cur = entry.agents[role];
  entry.agents[role] = { ...cur, ...patch, pulse: cur.pulse + 1 };
}

function pushActivity(entry: RunEntry, ev: Omit<ActivityEvent, "ts">): void {
  entry.activity.push({ ts: Date.now(), ...ev });
  // Cap the feed so the SSE payload doesn't balloon during very long runs.
  if (entry.activity.length > 200) entry.activity.splice(0, entry.activity.length - 200);
}

function setStatus(
  entry: RunEntry,
  role: AgentRole,
  status: AgentStatus,
  activity?: string,
): void {
  bumpAgent(entry, role, {
    status,
    ...(activity !== undefined ? { activity } : {}),
  });
}

function parseLine(entry: RunEntry, raw: string): void {
  const line = strip(raw);
  const info = entry.capsule;

  // ── Capsule chain (any "capsule : 0x…" line) ────────────────────────────
  const capsuleMatch = line.match(/capsule[\s_]*[:_]?id?\s*[:=]\s*(0x[0-9a-f]{16,})/i)
    || line.match(/capsule\s*:\s*(0x[0-9a-f]{16,})/i);
  if (capsuleMatch) {
    const id = capsuleMatch[1]!;
    if (!info.capsuleIds.includes(id)) info.capsuleIds.push(id);
  }

  // ── 0G blob roots ────────────────────────────────────────────────────────
  const rootMatch = line.match(/root=(0x[0-9a-f]{64})/i);
  if (rootMatch) {
    const r = rootMatch[1]!;
    if (!info.logRoots.includes(r)) {
      info.logRoots.push(r);
      pushActivity(entry, {
        type:    "blob",
        message: `Blob uploaded to 0G Storage`,
        txHash:  r,
      });
    }
  }

  // ── Tx hashes ────────────────────────────────────────────────────────────
  const txMatch = line.match(/[Hh]ash[:\s]+(0x[0-9a-f]{64})/);
  if (txMatch) {
    const h = txMatch[1]!;
    if (!info.txHashes.includes(h)) info.txHashes.push(h);
  }

  // ── ENS subname ──────────────────────────────────────────────────────────
  const ensMatch = line.match(/published\s*:\s*([a-z0-9-]+\.[a-z0-9-]+\.eth[^\s]*)/i);
  if (ensMatch) {
    info.ensSub = ensMatch[1]!;
    pushActivity(entry, {
      type:    "ens",
      message: `ENS pointer published: ${info.ensSub}`,
    });
  }

  // ── 0G Compute ───────────────────────────────────────────────────────────
  const attestedMatch = line.match(/attested\s*:\s*(\S+)\s+confidence=(\S+)/i);
  if (attestedMatch) {
    info.computeModel = attestedMatch[1]!;
    pushActivity(entry, {
      type:    "compute",
      message: `0G Compute attested via ${attestedMatch[1]} (confidence: ${attestedMatch[2]})`,
    });
  }
  const summaryMatch = line.match(/summary\s*:\s*(.{20,})/i);
  if (summaryMatch && info.computeModel && !info.computeSummary) {
    info.computeSummary = summaryMatch[1]!.replace(/…$/, "").trim();
  }

  // ── Patch JSON (extract patched_source) ──────────────────────────────────
  const patchMatch = line.match(/\[patcher:patch\]\s+(.+)/);
  if (patchMatch) {
    try {
      const obj = JSON.parse(patchMatch[1]!) as {
        patched_source?: string;
        unified_diff?: string;
      };
      if (obj.unified_diff) {
        info.patch = obj.unified_diff;
      } else if (obj.patched_source) {
        info.patch = obj.patched_source;
      }
    } catch {/* ignore */}
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  if (/APPROVED|pipeline-complete/.test(line)) info.verdict = "pipeline-complete";

  // ── Phase banners ─────────────────────────────────────────────────────────
  if (/▶ Phase: Triager/.test(line)) {
    setStatus(entry, "triager", "active", "bug identification");
    pushActivity(entry, { type: "phase", agent: "triager", message: "Triager started — scanning source" });
    return;
  }
  if (/▶ Phase: Reproducer — step 1/.test(line)) {
    setStatus(entry, "reproducer", "active", "planning test strategy");
    pushActivity(entry, { type: "phase", agent: "reproducer", message: "Reproducer started — step 1: planning" });
    return;
  }
  if (/▶ Phase: Reproducer — fresh container/.test(line)) {
    setStatus(entry, "reproducer", "resuming", "fresh container booting");
    pushActivity(entry, { type: "resume", agent: "reproducer", message: "🔄 Fresh container — restoring from 0G" });
    return;
  }
  if (/▶ Phase: Patcher/.test(line)) {
    setStatus(entry, "patcher", "active", "generating patch");
    pushActivity(entry, { type: "phase", agent: "patcher", message: "Patcher started — generating fix" });
    return;
  }
  if (/▶ Phase: Reviewer/.test(line)) {
    setStatus(entry, "reviewer", "active", "reviewing patch");
    pushActivity(entry, { type: "phase", agent: "reviewer", message: "Reviewer started — final verdict" });
    return;
  }

  // ── Triager outputs ───────────────────────────────────────────────────────
  const triageScan = line.match(/\[triager\] Triaging source \((\d+) chars\)/);
  if (triageScan) {
    bumpAgent(entry, "triager", { activity: `scanning ${triageScan[1]} chars` });
    return;
  }
  const triageFound = line.match(/\[triager\] Found (\d+) bug\(s\)(?::\s+(.+))?/);
  if (triageFound) {
    const count = parseInt(triageFound[1]!, 10);
    bumpAgent(entry, "triager", {
      summary: `${count} bug${count === 1 ? "" : "s"} found`,
      count,
      activity: triageFound[2] ?? null,
    });
    pushActivity(entry, {
      type:    "info",
      agent:   "triager",
      message: `Triager identified ${count} bug${count === 1 ? "" : "s"}${triageFound[2] ? `: ${triageFound[2].slice(0, 80)}` : ""}`,
    });
    return;
  }

  // ── Reproducer outputs ────────────────────────────────────────────────────
  if (/\[reproducer\] Step 1 — Planning/.test(line)) {
    bumpAgent(entry, "reproducer", { activity: "planning tests" });
    return;
  }
  const planMatch = line.match(/\[reproducer\] Plan: (.+?)\s*—\s*(\d+) test/);
  if (planMatch) {
    const n = parseInt(planMatch[2]!, 10);
    bumpAgent(entry, "reproducer", { summary: `${n} tests planned`, count: n });
    pushActivity(entry, { type: "info", agent: "reproducer", message: `Reproducer planned ${n} test cases` });
    return;
  }
  if (/step-1 checkpoint → 0G/.test(line)) {
    pushActivity(entry, { type: "checkpoint", agent: "reproducer", message: "✓ Step-1 checkpoint persisted to 0G" });
    return;
  }
  if (/💀.*[Cc]ontainer killed/.test(line)) {
    bumpAgent(entry, "reproducer", {
      status:   "killed",
      killed:   true,
      activity: "💀 container died mid-execution",
      summary:  "killed after step-1",
    });
    pushActivity(entry, {
      type:    "kill",
      agent:   "reproducer",
      message: "💀 Container killed — reproducer mid-step",
    });
    return;
  }
  if (/🔄 Booting fresh container/.test(line)) {
    bumpAgent(entry, "reproducer", { status: "resuming", activity: "booting fresh container…" });
    return;
  }
  if (/🔄 Restoring capsule from 0G/.test(line)) {
    bumpAgent(entry, "reproducer", { activity: "restoring capsule from 0G…" });
    return;
  }
  if (/Detected.*planning-done.*skipping step 1/.test(line)) {
    bumpAgent(entry, "reproducer", { activity: "checkpoint detected — skipping step 1" });
    return;
  }
  if (/\[reproducer\] 🔄 Resuming from planning-done/.test(line)) {
    bumpAgent(entry, "reproducer", { activity: "resumed from checkpoint" });
    return;
  }
  if (/\[reproducer\] Step 2 — Writing/.test(line)) {
    bumpAgent(entry, "reproducer", { status: "active", activity: "writing reproduction tests" });
    return;
  }
  const wroteMatch = line.match(/\[reproducer\] Wrote (\d+) test\(s\)/);
  if (wroteMatch) {
    const n = parseInt(wroteMatch[1]!, 10);
    bumpAgent(entry, "reproducer", { summary: `${n} tests written`, count: n });
    pushActivity(entry, { type: "info", agent: "reproducer", message: `Reproducer wrote ${n} reproduction tests` });
    return;
  }

  // ── Patcher outputs ───────────────────────────────────────────────────────
  if (/\[patcher\] Generating patch/.test(line)) {
    bumpAgent(entry, "patcher", { activity: "generating patch with LLM" });
    return;
  }
  const patchedMatch = line.match(/\[patcher\] Applied (\d+) fix/);
  if (patchedMatch) {
    const n = parseInt(patchedMatch[1]!, 10);
    bumpAgent(entry, "patcher", { summary: `${n} fixes applied`, count: n });
    pushActivity(entry, { type: "info", agent: "patcher", message: `Patcher applied ${n} fixes` });
    return;
  }
  const patchDiffMatch = line.match(/\[patcher\] Patch diff: \+(\d+) -(\d+)/);
  if (patchDiffMatch) {
    const adds = parseInt(patchDiffMatch[1]!, 10);
    const dels = parseInt(patchDiffMatch[2]!, 10);
    bumpAgent(entry, "patcher", {
      activity: `generated diff (+${adds} -${dels})`,
      summary: `+${adds} -${dels}`,
    });
    pushActivity(entry, {
      type: "info",
      agent: "patcher",
      message: `Patcher generated a non-empty diff (+${adds} -${dels})`,
    });
    return;
  }

  // ── Reviewer outputs ──────────────────────────────────────────────────────
  if (/\[reviewer\] Reviewing/.test(line)) {
    bumpAgent(entry, "reviewer", { activity: "reviewing diff" });
    return;
  }
  const reviewerVerdict = line.match(/\[reviewer\]\s+(APPROVED|REWORK|REJECTED)/);
  if (reviewerVerdict) {
    bumpAgent(entry, "reviewer", { summary: reviewerVerdict[1]!.toLowerCase() });
  }

  // ── Handoff ✓ <agent> done → <next> ──────────────────────────────────────
  const handoff = line.match(/✓\s+(\w+)\s+done\s+→\s+(\w+)/);
  if (handoff) {
    const from = handoff[1]!.toLowerCase() as AgentRole;
    const to   = handoff[2]!.toLowerCase() as AgentRole;
    if (from in entry.agents) bumpAgent(entry, from, { status: "done" });
    pushActivity(entry, {
      type:    "handoff",
      agent:   from,
      message: `${from[0]!.toUpperCase() + from.slice(1)} → ${to[0]!.toUpperCase() + to.slice(1)}`,
    });
    return;
  }

  // ── Final approval / pipeline-complete ──────────────────────────────────
  if (/✓\s+APPROVED\s+—\s+pipeline complete/.test(line)) {
    bumpAgent(entry, "reviewer", { status: "done", summary: "approved" });
    pushActivity(entry, { type: "complete", message: "✓ Pipeline complete — patch APPROVED" });
    return;
  }

  // ── Anchor confirmations from chain ──────────────────────────────────────
  const anchorMatch = line.match(/anchored.*(0x[0-9a-f]{64})/i);
  if (anchorMatch) {
    pushActivity(entry, { type: "anchor", message: "On-chain anchor confirmed", txHash: anchorMatch[1]! });
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function append(taskId: string, chunk: string): void {
  const entry = store.get(taskId);
  if (!entry) return;

  entry.lineCarry += chunk;
  for (;;) {
    const nl = entry.lineCarry.indexOf("\n");
    if (nl === -1) break;
    let line = entry.lineCarry.slice(0, nl);
    entry.lineCarry = entry.lineCarry.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") continue;
    entry.lines.push(line);
    parseLine(entry, line);
  }
}

/** Flush any trailing bytes without a final newline (process exit). */
function flushLineCarry(entry: RunEntry): void {
  if (entry.lineCarry === "") return;
  let line = entry.lineCarry;
  entry.lineCarry = "";
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (line === "") return;
  entry.lines.push(line);
  parseLine(entry, line);
}

export function markDone(taskId: string, error?: string): void {
  const entry = store.get(taskId);
  if (!entry) return;
  flushLineCarry(entry);
  entry.done = true;
  if (error) entry.error = error;
}

export function get(taskId: string): RunEntry | undefined {
  return store.get(taskId);
}

export function list(): { taskId: string; repoUrl: string; done: boolean; startedAt: number }[] {
  return [...store.entries()].map(([taskId, e]) => ({
    taskId,
    repoUrl:    e.repoUrl,
    done:       e.done,
    startedAt:  e.startedAt,
  }));
}
