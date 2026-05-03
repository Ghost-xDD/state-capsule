"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ArrowLeft, Hexagon, ExternalLink, CheckCircle2, AlertTriangle } from "lucide-react";
import type { AgentRole, AgentState, ActivityEvent, CapsuleInfo } from "@/lib/run-store";
import { AgentMesh } from "@/components/AgentMesh";
import { ActivityFeed } from "@/components/ActivityFeed";
import { ZeroGPanel } from "@/components/ZeroGPanel";
import { PatchPanel } from "@/components/PatchPanel";
import { RawLogDrawer } from "@/components/RawLogDrawer";

type SseEvent =
  | { type: "line";    text: string }
  | { type: "agents";  agents: Record<AgentRole, AgentState>; capsule: CapsuleInfo }
  | { type: "activity"; event: ActivityEvent }
  | { type: "done";    capsule: CapsuleInfo; agents: Record<AgentRole, AgentState>; error: string | null; elapsed: number }
  | { type: "error";   msg: string };

function makeIdleAgents(): Record<AgentRole, AgentState> {
  const idle = (role: AgentRole): AgentState => ({
    role, status: "idle", activity: null, summary: null, count: null, killed: false, pulse: 0,
  });
  return {
    triager:    idle("triager"),
    reproducer: idle("reproducer"),
    patcher:    idle("patcher"),
    reviewer:   idle("reviewer"),
  };
}

function makeEmptyCapsule(taskId: string): CapsuleInfo {
  return {
    taskId,
    capsuleIds:      [],
    logRoots:        [],
    ensSub:          null,
    txHashes:        [],
    verdict:         null,
    patch:           null,
    computeSummary:  null,
    computeModel:    null,
  };
}

function RunPageInner() {
  const params  = useSearchParams();
  const router  = useRouter();
  const taskId  = params.get("id");

  const [lines,     setLines]     = useState<string[]>([]);
  const [agents,    setAgents]    = useState<Record<AgentRole, AgentState>>(() => makeIdleAgents());
  const [capsule,   setCapsule]   = useState<CapsuleInfo>(() => makeEmptyCapsule(taskId ?? "?"));
  const [activity,  setActivity]  = useState<ActivityEvent[]>([]);
  const [done,      setDone]      = useState(false);
  const [elapsed,   setElapsed]   = useState<number | null>(null);
  const [error,     setError]     = useState<string | null>(null);
  const [repoUrl,   setRepoUrl]   = useState<string | null>(null);
  const [startedAt] = useState<number>(() => Date.now());
  const [rawOpen,   setRawOpen]   = useState(false);
  const [killFlash, setKillFlash] = useState(0);

  const prevKilled = useRef(false);
  useEffect(() => {
    const nowKilled = agents.reproducer.killed;
    if (nowKilled && !prevKilled.current) {
      setKillFlash((k) => k + 1);
    }
    prevKilled.current = nowKilled;
  }, [agents.reproducer.killed]);

  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!taskId) return;

    const es = new EventSource(`/api/run/${taskId}/stream`);

    es.onmessage = (ev) => {
      const event = JSON.parse(ev.data as string) as SseEvent;

      switch (event.type) {
        case "line": {
          const m = event.text.match(/\[demo-ui\] Cloned (https:\/\/github\.com\/[^\s]+)/);
          if (m) setRepoUrl(m[1]!);
          setLines((prev) => [...prev, event.text]);
          break;
        }
        case "agents": {
          setAgents(event.agents);
          setCapsule(event.capsule);
          break;
        }
        case "activity": {
          setActivity((prev) => [...prev, event.event]);
          break;
        }
        case "done": {
          setAgents(event.agents);
          setCapsule(event.capsule);
          setDone(true);
          setElapsed(event.elapsed);
          if (event.error) setError(event.error);
          es.close();
          break;
        }
        case "error": {
          setError(event.msg);
          setDone(true);
          es.close();
          break;
        }
      }
    };

    es.onerror = () => {
      if (!done) setError("Connection lost");
      es.close();
    };

    return () => es.close();
  }, [taskId, done]);

  if (!taskId) {
    return (
      <div className="flex items-center justify-center min-h-screen text-zinc-400">
        No task ID in URL.
        <button
          onClick={() => router.push("/")}
          className="ml-2 text-indigo-400 hover:text-indigo-300 underline"
        >
          Go home
        </button>
      </div>
    );
  }

  const statusDot = done
    ? error
      ? "bg-red-500"
      : "bg-emerald-500"
    : "bg-amber-400 pulse-dot";
  const statusLabel = done ? (error ? "Failed" : "Complete") : "Running";

  return (
    <div className="min-h-screen bg-canvas text-zinc-100 flex flex-col">
      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-canvas/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center gap-4">
          <button
            onClick={() => router.push("/")}
            className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <ArrowLeft size={14} strokeWidth={2.25} />
            Back
          </button>

          <div className="h-5 w-px bg-white/[0.08]" />

          <div className="flex items-center gap-2 min-w-0">
            <Hexagon size={16} className="text-indigo-400 shrink-0" strokeWidth={2} />
            <span className="text-sm font-medium text-zinc-100">State Capsule</span>
          </div>

          <div className="h-5 w-px bg-white/[0.08]" />

          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
            <span className="text-xs font-medium text-zinc-300">{statusLabel}</span>
          </div>

          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1 truncate max-w-[28rem]"
            >
              <span className="truncate font-mono">
                {repoUrl.replace("https://github.com/", "")}
              </span>
              <ExternalLink size={11} strokeWidth={2} className="shrink-0" />
            </a>
          )}

          <div className="ml-auto flex items-center gap-5 text-xs text-zinc-500 font-mono tabular-nums">
            <span>
              <span className="text-zinc-600">task </span>
              {taskId.slice(0, 8)}
            </span>
            <span suppressHydrationWarning>
              {elapsed !== null
                ? `${(elapsed / 1000).toFixed(1)}s`
                : `${((Date.now() - startedAt) / 1000).toFixed(0)}s`}
            </span>
            <span>
              {lines.length}
              <span className="text-zinc-600"> lines</span>
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto px-6 pt-6 pb-6 flex-1 flex flex-col gap-6">
        {/* ── Section header ───────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 leading-tight">
              Maintainer swarm
            </h1>
            <p className="text-sm text-zinc-500 mt-0.5">
              Four agents · capsules flow left to right · every state anchored to 0G
            </p>
          </div>
        </div>

        {/* ── Agent mesh ───────────────────────────────────────────────────── */}
        <AgentMesh agents={agents} killFlashKey={killFlash} />

        {/* Verdict / error banner */}
        {capsule.verdict && (
          <div
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
              capsule.verdict === "pipeline-complete"
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
                : "border-amber-500/30 bg-amber-500/5 text-amber-200"
            }`}
          >
            {capsule.verdict === "pipeline-complete" ? (
              <CheckCircle2 size={16} strokeWidth={2} className="shrink-0" />
            ) : (
              <AlertTriangle size={16} strokeWidth={2} className="shrink-0" />
            )}
            <span className="text-sm font-medium">
              {capsule.verdict === "pipeline-complete"
                ? "Patch approved · Pipeline complete"
                : capsule.verdict}
            </span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
            <AlertTriangle size={16} strokeWidth={2} className="shrink-0 mt-0.5" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {/* ── Bottom split ─────────────────────────────────────────────────── */}
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-[1.4fr_1fr] flex-1 min-h-0">
          <div className="min-h-[20rem] flex flex-col">
            <ActivityFeed events={activity} startedAt={startedAt} />
          </div>

          <div className="min-h-[20rem] flex flex-col gap-4">
            <ZeroGPanel capsule={capsule} />
            {capsule.patch && <PatchPanel patch={capsule.patch} />}
          </div>
        </div>

        {/* ── Raw log ──────────────────────────────────────────────────────── */}
        <RawLogDrawer lines={lines} open={rawOpen} onToggle={() => setRawOpen((o) => !o)} />
      </main>
    </div>
  );
}

export default function RunPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen text-zinc-500 text-sm">
          Loading…
        </div>
      }
    >
      <RunPageInner />
    </Suspense>
  );
}
