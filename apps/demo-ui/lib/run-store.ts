/**
 * run-store.ts — In-process store for active pipeline runs.
 *
 * Lives as a module-level singleton so both the POST /api/run route (which
 * spawns the child process) and the GET /api/run/[id]/stream route (which
 * reads stdout) share the same Map without an external store.
 *
 * Safe for a single-server demo; would need Redis/DB for multi-replica.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CapsuleInfo {
  taskId: string;
  capsuleIds: string[];
  logRoots: string[];
  ensSub: string | null;
  txHashes: string[];
  verdict: string | null;
  patch: string | null;
}

export interface RunEntry {
  repoUrl: string;
  repoFile: string;
  lines: string[];
  done: boolean;
  error: string | null;
  capsule: CapsuleInfo;
  startedAt: number;
}

// ── Store ─────────────────────────────────────────────────────────────────────

const store = new Map<string, RunEntry>();

export function create(taskId: string, repoUrl: string, repoFile: string): void {
  store.set(taskId, {
    repoUrl,
    repoFile,
    lines: [],
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
    },
  });
}

// ── ANSI regex ────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const strip = (s: string) => s.replace(ANSI_RE, "");

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseLine(info: CapsuleInfo, raw: string): void {
  const line = strip(raw);

  const capsuleMatch = line.match(/capsule\s*:\s*([0-9a-f]{16,})/i);
  if (capsuleMatch) {
    const id = capsuleMatch[1]!;
    if (!info.capsuleIds.includes(id)) info.capsuleIds.push(id);
  }

  const logRootMatch = line.match(/log_root\s*:\s*(0x[0-9a-f]{64})/i);
  if (logRootMatch) {
    const lr = logRootMatch[1]!;
    if (!info.logRoots.includes(lr)) info.logRoots.push(lr);
  }

  const ensMatch = line.match(/published\s*:\s*([a-z0-9-]+\.[a-z0-9-]+\.eth[^\s]*)/i);
  if (ensMatch) info.ensSub = ensMatch[1]!;

  // Transaction hashes from "Transaction submitted, hash: 0x..."
  const txMatch = line.match(/[Hh]ash[:\s]+(0x[0-9a-f]{64})/);
  if (txMatch) {
    const h = txMatch[1]!;
    if (!info.txHashes.includes(h)) info.txHashes.push(h);
  }

  // Also catch hashes from "[chain] anchored..." lines
  const chainMatch = line.match(/anchored[^0x]*(0x[0-9a-f]{64})/i);
  if (chainMatch) {
    const h = chainMatch[1]!;
    if (!info.txHashes.includes(h)) info.txHashes.push(h);
  }

  if (/pipeline-complete|APPROVED/i.test(line)) info.verdict = "pipeline-complete";
  if (/verdict\s*:\s*(\S+)/i.test(line)) {
    info.verdict = line.match(/verdict\s*:\s*(\S+)/i)![1]!;
  }

  // Extract patch from patcher log
  const patchMatch = line.match(/\[patcher:patch\]\s+(.+)/);
  if (patchMatch) {
    try {
      const obj = JSON.parse(patchMatch[1]!) as { patched_source?: string };
      if (obj.patched_source) info.patch = obj.patched_source;
    } catch {
      // ignore
    }
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function append(taskId: string, chunk: string): void {
  const entry = store.get(taskId);
  if (!entry) return;
  for (const line of chunk.split("\n")) {
    if (line === "") continue;
    entry.lines.push(line);
    parseLine(entry.capsule, line);
  }
}

export function markDone(taskId: string, error?: string): void {
  const entry = store.get(taskId);
  if (!entry) return;
  entry.done = true;
  if (error) entry.error = error;
}

export function get(taskId: string): RunEntry | undefined {
  return store.get(taskId);
}

export function list(): { taskId: string; repoUrl: string; done: boolean; startedAt: number }[] {
  return [...store.entries()].map(([taskId, e]) => ({
    taskId,
    repoUrl: e.repoUrl,
    done: e.done,
    startedAt: e.startedAt,
  }));
}
