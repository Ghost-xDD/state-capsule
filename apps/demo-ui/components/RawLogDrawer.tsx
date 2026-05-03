"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function lineClass(raw: string): string {
  const s = stripAnsi(raw);
  if (/✓|APPROVED|pipeline-complete/i.test(s))   return "text-emerald-300";
  if (/⚠|warn/i.test(s))                          return "text-amber-300";
  if (/💀|kill|KILL/i.test(s))                    return "text-red-300";
  if (/🔄|resum/i.test(s))                        return "text-purple-300";
  if (/▶ Phase/i.test(s))                         return "text-indigo-300 font-semibold";
  if (/═{10}/.test(s))                            return "text-cyan-400";
  if (/^\s*→/.test(s))                            return "text-zinc-500";
  if (/^\[demo-ui\]/.test(s))                     return "text-sky-300";
  if (/error|Error/i.test(s))                     return "text-red-300";
  return "text-zinc-400";
}

export function RawLogDrawer({
  lines,
  open,
  onToggle,
}: {
  lines:    string[];
  open:     boolean;
  onToggle: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (open && autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, open, autoScroll]);

  return (
    <div
      className={`bg-surface/60 border border-white/[0.06] rounded-xl overflow-hidden flex flex-col transition-[height] duration-300 ${
        open ? "h-72" : "h-11"
      }`}
    >
      <button
        onClick={onToggle}
        className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 text-sm text-zinc-300 hover:bg-white/[0.025] transition-colors text-left"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          strokeWidth={2.25}
        />
        <Terminal size={13} className="shrink-0 text-zinc-500" strokeWidth={2} />
        <span className="font-medium">Raw stdout</span>
        <span className="ml-auto flex items-center gap-3">
          {open && (
            <label
              className="flex items-center gap-1.5 text-xs text-zinc-500"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="accent-indigo-500 cursor-pointer"
              />
              Auto-scroll
            </label>
          )}
          <span className="text-xs text-zinc-500 tabular-nums">
            {lines.length} lines
          </span>
        </span>
      </button>

      {open && (
        <div
          className="flex-1 overflow-y-auto bg-canvas/50 p-3 font-mono text-[11.5px] leading-relaxed"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setAutoScroll(atBottom);
          }}
        >
          {lines.length === 0 && (
            <p className="text-zinc-600 italic">Waiting for stdout…</p>
          )}
          {lines.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all ${lineClass(line)}`}
            >
              {stripAnsi(line)}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
