"use client";

import { useEffect, useState } from "react";
import type { AgentRole, AgentState } from "@/lib/run-store";
import { AgentPanel } from "./AgentPanel";

const ORDER: AgentRole[] = ["triager", "reproducer", "patcher", "reviewer"];

function HandoffRail({ done, flowing }: { done: boolean; flowing: boolean }) {
  return (
    <div className="relative hidden lg:flex items-center h-full px-1" aria-hidden>
      <div className="relative w-full h-px">
        <div
          className={`absolute inset-0 transition-colors duration-300 ${
            done ? "bg-emerald-500/40" : "bg-white/[0.06]"
          }`}
        />
        {flowing && <div className="absolute inset-0 shimmer" />}
      </div>
    </div>
  );
}

export function AgentMesh({
  agents,
  killFlashKey,
}: {
  agents:       Record<AgentRole, AgentState>;
  killFlashKey: number;
}) {
  const [handoffPulses, setHandoffPulses] = useState<Record<string, number>>({});

  useEffect(() => {
    const next: Record<string, number> = {};
    for (let i = 0; i < ORDER.length - 1; i++) {
      const from = agents[ORDER[i]!];
      const to   = agents[ORDER[i + 1]!];
      if (
        from.status === "done" &&
        (to.status === "active" || to.status === "resuming")
      ) {
        next[`${ORDER[i]}->${ORDER[i + 1]}`] = from.pulse + to.pulse;
      }
    }
    setHandoffPulses(next);
  }, [agents]);

  const reproducer    = agents.reproducer;
  const showDeadGhost = reproducer.killed;
  const showFresh     = reproducer.killed && reproducer.status !== "killed";

  const flowing = (i: number): boolean => {
    const next = agents[ORDER[i + 1]!];
    return (
      handoffPulses[`${ORDER[i]}->${ORDER[i + 1]}`] !== undefined &&
      next.status !== "done"
    );
  };

  return (
    <div className="relative w-full">
      {/* Subtle screen-flash on kill (much gentler than before) */}
      <div
        key={`flash-${killFlashKey}`}
        className={
          killFlashKey > 0
            ? "fixed inset-0 z-50 bg-red-500 pointer-events-none animate-screen-flash"
            : "hidden"
        }
      />

      <div className="grid gap-3 lg:gap-0 lg:grid-cols-[1fr_36px_1fr_36px_1fr_36px_1fr] items-stretch">
        <div><AgentPanel agent={agents.triager} /></div>

        <HandoffRail
          done={agents.triager.status === "done"}
          flowing={flowing(0)}
        />

        {/* Reproducer slot — accommodates the kill-and-resume drama */}
        <div className="relative">
          {showDeadGhost && (
            <div className="absolute inset-0">
              <AgentPanel
                agent={{
                  ...reproducer,
                  status:   "killed",
                  activity: "Process terminated",
                  summary:  reproducer.summary ?? "Killed mid-step",
                }}
                variant="ghost"
              />
            </div>
          )}
          {showFresh && (
            <div className="absolute inset-0">
              <AgentPanel
                agent={reproducer}
                variant="fresh"
                pulseKey={`fresh-${reproducer.pulse}-${killFlashKey}`}
              />
            </div>
          )}
          {!reproducer.killed && (
            <AgentPanel
              agent={reproducer}
              pulseKey={`orig-${reproducer.pulse}`}
            />
          )}
        </div>

        <HandoffRail
          done={agents.reproducer.status === "done"}
          flowing={flowing(1)}
        />

        <div><AgentPanel agent={agents.patcher} /></div>

        <HandoffRail
          done={agents.patcher.status === "done"}
          flowing={flowing(2)}
        />

        <div><AgentPanel agent={agents.reviewer} /></div>
      </div>
    </div>
  );
}
