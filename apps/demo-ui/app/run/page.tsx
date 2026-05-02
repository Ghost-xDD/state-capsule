"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import type { CapsuleInfo } from "@/lib/run-store";

// ── ANSI stripping ────────────────────────────────────────────────────────────
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

// ── Line classifier (for coloring) ───────────────────────────────────────────
function lineClass(raw: string): string {
  const s = stripAnsi(raw);
  if (/✓|APPROVED|pipeline-complete/i.test(s)) return "text-green-400";
  if (/⚠|warn/i.test(s)) return "text-yellow-400";
  if (/💀|kill|KILL/i.test(s)) return "text-red-400";
  if (/🔄|resum/i.test(s)) return "text-purple-400";
  if (/▶ Phase/i.test(s)) return "text-indigo-300 font-bold";
  if (/═{10}/.test(s)) return "text-cyan-500";
  if (/^\s*→/.test(s)) return "text-gray-400";
  if (/^\[demo-ui\]/.test(s)) return "text-sky-400";
  if (/error|Error/i.test(s)) return "text-red-300";
  return "text-gray-300";
}

// ── Truncate long hex strings for display ────────────────────────────────────
const short = (s: string) =>
  s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;

// ── CapsuleInfo sidebar ───────────────────────────────────────────────────────
function Sidebar({
  capsule,
  done,
  elapsed,
  repoUrl,
  error,
}: {
  capsule: CapsuleInfo | null;
  done: boolean;
  elapsed: number | null;
  repoUrl: string | null;
  error: string | null;
}) {
  const statusColor = done
    ? error
      ? "bg-red-500"
      : "bg-green-500"
    : "bg-yellow-400 animate-pulse";
  const statusLabel = done ? (error ? "failed" : "complete") : "running";

  return (
    <aside className="flex flex-col gap-4 h-full overflow-y-auto pr-1">
      {/* Status */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} />
          <span className="text-xs uppercase tracking-widest text-gray-400">
            {statusLabel}
          </span>
          {elapsed && (
            <span className="ml-auto text-xs text-gray-600">
              {(elapsed / 1000).toFixed(1)}s
            </span>
          )}
        </div>
        {repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-indigo-400 hover:underline break-all"
          >
            {repoUrl.replace("https://github.com/", "")}
          </a>
        )}
      </div>

      {/* Verdict */}
      {capsule?.verdict && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm font-bold text-center ${
            capsule.verdict === "pipeline-complete"
              ? "border-green-700 bg-green-950 text-green-400"
              : "border-yellow-700 bg-yellow-950 text-yellow-400"
          }`}
        >
          {capsule.verdict === "pipeline-complete" ? "✓ PATCH APPROVED" : capsule.verdict}
        </div>
      )}

      {/* ENS pointer */}
      {capsule?.ensSub && (
        <InfoBlock label="ENS Pointer" icon="🌐">
          <a
            href={`https://app.ens.domains/${capsule.ensSub}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-indigo-400 hover:underline break-all"
          >
            {capsule.ensSub}
          </a>
        </InfoBlock>
      )}

      {/* Capsule chain */}
      {capsule && capsule.capsuleIds.length > 0 && (
        <InfoBlock label="Capsule Chain" icon="⬡">
          <ol className="space-y-1">
            {capsule.capsuleIds.map((id, i) => (
              <li key={id} className="flex items-center gap-2 text-xs">
                <span className="text-gray-600 w-4 text-right shrink-0">{i + 1}</span>
                <code className="text-cyan-400 break-all">{short(id)}</code>
              </li>
            ))}
          </ol>
        </InfoBlock>
      )}

      {/* 0G log roots */}
      {capsule && capsule.logRoots.length > 0 && (
        <InfoBlock label="0G Blob Roots" icon="🗄">
          <ul className="space-y-1">
            {capsule.logRoots.map((lr) => (
              <li key={lr}>
                <code className="text-purple-400 text-xs break-all">{short(lr)}</code>
              </li>
            ))}
          </ul>
        </InfoBlock>
      )}

      {/* On-chain tx hashes */}
      {capsule && capsule.txHashes.length > 0 && (
        <InfoBlock label="On-chain Txs" icon="⛓">
          <ul className="space-y-1">
            {capsule.txHashes.map((tx) => (
              <li key={tx}>
                <a
                  href={`https://chainscan-galileo.0g.ai/tx/${tx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-green-400 hover:underline break-all"
                >
                  {short(tx)}
                </a>
              </li>
            ))}
          </ul>
        </InfoBlock>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-xs text-red-400 break-all">
          {error}
        </div>
      )}
    </aside>
  );
}

function InfoBlock({
  label,
  icon,
  children,
}: {
  label: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="text-xs uppercase tracking-widest text-gray-500 mb-3 flex items-center gap-2">
        <span>{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}

// ── Diff viewer ───────────────────────────────────────────────────────────────
function PatchPanel({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-800 text-xs text-gray-500 uppercase tracking-widest">
        Generated Patch
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed max-h-72 overflow-y-auto">
        {lines.map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith("+")
                ? "text-green-400"
                : line.startsWith("-")
                ? "text-red-400"
                : "text-gray-400"
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

// ── SSE event types ───────────────────────────────────────────────────────────
interface LineEvent {
  type: "line";
  text: string;
}
interface DoneEvent {
  type: "done";
  capsule: CapsuleInfo;
  error: string | null;
  elapsed: number;
}
interface ErrorEvent {
  type: "error";
  msg: string;
}
type SseEvent = LineEvent | DoneEvent | ErrorEvent;

// ── Main page ─────────────────────────────────────────────────────────────────
function RunPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const taskId = params.get("id");

  const [lines, setLines] = useState<string[]>([]);
  const [capsule, setCapsule] = useState<CapsuleInfo | null>(null);
  const [done, setDone] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Extract repo URL from the first [demo-ui] line
  const processLine = useCallback((line: string) => {
    const m = line.match(/\[demo-ui\] Cloned (https:\/\/github\.com\/[^\s]+)/);
    if (m) setRepoUrl(m[1]!);
    setLines((prev) => [...prev, line]);
  }, []);

  useEffect(() => {
    if (!taskId) return;

    const es = new EventSource(`/api/run/${taskId}/stream`);

    es.onmessage = (ev) => {
      const event = JSON.parse(ev.data as string) as SseEvent;

      if (event.type === "line") {
        processLine(event.text);
      } else if (event.type === "done") {
        setCapsule(event.capsule);
        setDone(true);
        setElapsed(event.elapsed);
        if (event.error) setError(event.error);
        es.close();
      } else if (event.type === "error") {
        setError(event.msg);
        setDone(true);
        es.close();
      }
    };

    es.onerror = () => {
      if (!done) setError("Connection lost");
      es.close();
    };

    return () => es.close();
  }, [taskId, processLine, done]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  };

  if (!taskId) {
    return (
      <div className="flex items-center justify-center min-h-screen text-gray-500">
        No task ID in URL.{" "}
        <button onClick={() => router.push("/")} className="ml-2 text-indigo-400 underline">
          Go home
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-6 py-3 border-b border-gray-800 bg-gray-950 shrink-0">
        <button
          onClick={() => router.push("/")}
          className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          ← back
        </button>
        <span className="text-xs text-gray-600 font-mono">
          task:{" "}
          <span className="text-gray-400">{taskId.slice(0, 8)}…</span>
        </span>
        <div className="flex-1" />
        <span className="text-xs text-gray-600">
          {lines.length} lines
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                bottomRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
              className="ml-3 text-indigo-400 hover:underline"
            >
              ↓ scroll to bottom
            </button>
          )}
        </span>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Log panel */}
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto bg-gray-950 p-4 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 && (
            <p className="text-gray-600 animate-pulse">Waiting for output…</p>
          )}
          {lines.map((line, i) => (
            <div key={i} className={`ansi-line ${lineClass(line)}`}>
              {stripAnsi(line)}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Sidebar */}
        <div className="w-80 shrink-0 border-l border-gray-800 bg-gray-950 overflow-y-auto p-4">
          <Sidebar
            capsule={capsule}
            done={done}
            elapsed={elapsed}
            repoUrl={repoUrl}
            error={error}
          />
          {capsule?.patch && (
            <div className="mt-4">
              <PatchPanel patch={capsule.patch} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RunPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen text-gray-600 text-sm">
          Loading…
        </div>
      }
    >
      <RunPageInner />
    </Suspense>
  );
}
