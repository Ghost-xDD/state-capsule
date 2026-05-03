"use client";

import type { AgentRole, AgentState, AgentStatus } from "@/lib/run-store";
import {
  Search,
  FlaskConical,
  Wrench,
  ShieldCheck,
  Skull,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";

type Meta = {
  name: string;
  subtitle: string;
  Icon: LucideIcon;
};

const META: Record<AgentRole, Meta> = {
  triager:    { name: "Triager",    subtitle: "Bug identification",     Icon: Search       },
  reproducer: { name: "Reproducer", subtitle: "Reproduction synthesis", Icon: FlaskConical },
  patcher:    { name: "Patcher",    subtitle: "Fix generation",         Icon: Wrench       },
  reviewer:   { name: "Reviewer",   subtitle: "Patch verdict",          Icon: ShieldCheck  },
};

type StatusStyle = {
  ring:    string;
  dot:     string;
  label:   string;
  pillBg:  string;
  pillTxt: string;
  iconBg:  string;
  iconFg:  string;
  border:  string;
};

function styleFor(status: AgentStatus): StatusStyle {
  switch (status) {
    case "active":
      return {
        ring:    "ring-active",
        dot:     "bg-indigo-400 pulse-dot",
        label:   "Active",
        pillBg:  "bg-indigo-500/10",
        pillTxt: "text-indigo-300",
        iconBg:  "bg-indigo-500/10",
        iconFg:  "text-indigo-300",
        border:  "border-indigo-500/30",
      };
    case "resuming":
      return {
        ring:    "ring-resuming",
        dot:     "bg-purple-400 pulse-dot",
        label:   "Resuming",
        pillBg:  "bg-purple-500/10",
        pillTxt: "text-purple-300",
        iconBg:  "bg-purple-500/10",
        iconFg:  "text-purple-300",
        border:  "border-purple-500/30",
      };
    case "done":
      return {
        ring:    "ring-done",
        dot:     "bg-emerald-400",
        label:   "Done",
        pillBg:  "bg-emerald-500/10",
        pillTxt: "text-emerald-300",
        iconBg:  "bg-emerald-500/10",
        iconFg:  "text-emerald-300",
        border:  "border-emerald-500/20",
      };
    case "killed":
      return {
        ring:    "ring-killed",
        dot:     "bg-red-400",
        label:   "Killed",
        pillBg:  "bg-red-500/10",
        pillTxt: "text-red-300",
        iconBg:  "bg-red-500/10",
        iconFg:  "text-red-300",
        border:  "border-red-500/30",
      };
    case "error":
      return {
        ring:    "",
        dot:     "bg-red-500",
        label:   "Error",
        pillBg:  "bg-red-500/10",
        pillTxt: "text-red-300",
        iconBg:  "bg-red-500/10",
        iconFg:  "text-red-300",
        border:  "border-red-500/30",
      };
    case "idle":
    default:
      return {
        ring:    "",
        dot:     "bg-zinc-600",
        label:   "Idle",
        pillBg:  "bg-white/[0.03]",
        pillTxt: "text-zinc-500",
        iconBg:  "bg-white/[0.03]",
        iconFg:  "text-zinc-500",
        border:  "border-white/[0.06]",
      };
  }
}

export function AgentPanel({
  agent,
  variant = "normal",
  pulseKey,
}: {
  agent:     AgentState;
  variant?:  "normal" | "ghost" | "fresh";
  pulseKey?: number | string;
}) {
  const meta  = META[agent.role];
  const s     = styleFor(agent.status);
  const Icon  = variant === "ghost" ? Skull : variant === "fresh" ? RotateCcw : meta.Icon;

  const isGhost = variant === "ghost";
  const isFresh = variant === "fresh";

  const containerClass = [
    "relative h-full rounded-xl border bg-surface/80 backdrop-blur-sm transition-colors duration-300",
    s.border,
    s.ring,
    agent.status === "killed" ? "animate-kill-shake" : "",
    isGhost ? "opacity-30 pointer-events-none border-red-500/20" : "",
    isFresh ? "animate-container-rise" : "",
    "p-4 flex flex-col gap-3",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div key={pulseKey} className={containerClass}>
      {isFresh && (
        <div className="absolute -top-2.5 left-4 px-2 py-0.5 rounded-full bg-purple-500/20 border border-purple-400/30 text-purple-200 text-[10px] font-medium tracking-wide">
          Fresh container
        </div>
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${s.iconBg} ${s.iconFg} border ${s.border}`}
        >
          <Icon size={18} strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-100 leading-tight">
            {meta.name}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 truncate">
            {meta.subtitle}
          </p>
        </div>
        <div
          className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${s.pillBg} ${s.pillTxt}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
          {s.label}
        </div>
      </div>

      {/* Activity */}
      <div className="text-[13px] text-zinc-400 min-h-[2.4rem] leading-snug">
        {isGhost ? (
          <span className="text-red-300/80 italic">Process terminated</span>
        ) : agent.activity ? (
          <span className="block">{agent.activity}</span>
        ) : (
          <span className="text-zinc-600 italic">Awaiting handoff…</span>
        )}
      </div>

      {/* Footer / output */}
      <div className="mt-auto pt-3 border-t border-white/[0.05] min-h-[2.5rem] flex items-end">
        {agent.summary ? (
          <div className="flex items-baseline gap-2 min-w-0">
            {agent.count !== null && (
              <span className="text-2xl font-semibold tabular-nums text-zinc-100">
                {agent.count}
              </span>
            )}
            <span className="text-xs text-zinc-500 truncate">
              {agent.summary}
            </span>
          </div>
        ) : (
          <span className="text-xs text-zinc-600">No output yet</span>
        )}
      </div>
    </div>
  );
}
