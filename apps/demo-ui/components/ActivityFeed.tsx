"use client";

import type { ActivityEvent } from "@/lib/run-store";
import {
  Play,
  Skull,
  RotateCcw,
  Save,
  ArrowRight,
  Link2,
  Database,
  Cpu,
  Globe,
  Check,
  Dot,
  type LucideIcon,
} from "lucide-react";

type Meta = {
  Icon: LucideIcon;
  tone: string;
  label: string;
};

const TYPE_META: Record<ActivityEvent["type"], Meta> = {
  phase:      { Icon: Play,      tone: "text-indigo-300",  label: "Phase"      },
  kill:       { Icon: Skull,     tone: "text-red-300",     label: "Kill"       },
  resume:     { Icon: RotateCcw, tone: "text-purple-300",  label: "Resume"     },
  checkpoint: { Icon: Save,      tone: "text-cyan-300",    label: "Checkpoint" },
  handoff:    { Icon: ArrowRight, tone: "text-emerald-300", label: "Handoff"   },
  anchor:     { Icon: Link2,     tone: "text-emerald-300", label: "Anchor"     },
  blob:       { Icon: Database,  tone: "text-purple-300",  label: "Blob"       },
  compute:    { Icon: Cpu,       tone: "text-amber-300",   label: "Compute"    },
  ens:        { Icon: Globe,     tone: "text-sky-300",     label: "ENS"        },
  complete:   { Icon: Check,     tone: "text-emerald-300", label: "Complete"   },
  info:       { Icon: Dot,       tone: "text-zinc-500",    label: "Info"       },
};

function timeAgo(ts: number, now: number): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 1)  return "now";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

export function ActivityFeed({
  events,
  startedAt,
}: {
  events:    ActivityEvent[];
  startedAt: number;
}) {
  const reversed = [...events].reverse();
  const now = Date.now();

  return (
    <div className="bg-surface/60 border border-white/[0.06] rounded-xl flex flex-col overflow-hidden h-full">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-100">Activity</h3>
          <span className="text-xs text-zinc-500">
            {events.length} {events.length === 1 ? "event" : "events"}
          </span>
        </div>
        {events.length > 0 && (
          <span className="text-[11px] text-zinc-500">live</span>
        )}
      </div>

      <ul className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {reversed.length === 0 && (
          <li className="text-sm text-zinc-600 italic px-3 py-4">
            Waiting for first signal…
          </li>
        )}
        {reversed.map((ev, i) => {
          const meta = TYPE_META[ev.type];
          const Icon = meta.Icon;
          return (
            <li
              key={`${ev.ts}-${i}`}
              className="slide-in flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.025] transition-colors"
            >
              <span className={`shrink-0 mt-0.5 ${meta.tone}`}>
                <Icon size={14} strokeWidth={2} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-zinc-200 leading-snug break-words">
                  {ev.message}
                </p>
                {(ev.txHash || ev.capsuleId) && (
                  <p className="text-[11px] text-zinc-500 truncate font-mono mt-0.5">
                    {ev.txHash ?? ev.capsuleId}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums mt-0.5">
                {timeAgo(ev.ts, now)}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="px-4 py-2 border-t border-white/[0.06] text-[11px] text-zinc-500 tabular-nums flex justify-between">
        <span suppressHydrationWarning>
          Started {new Date(startedAt).toLocaleTimeString()}
        </span>
        <span suppressHydrationWarning>
          {((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed
        </span>
      </div>
    </div>
  );
}
