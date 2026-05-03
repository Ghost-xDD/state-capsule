"use client";

import { GitPullRequest, Copy, Check } from "lucide-react";
import { useState } from "react";

export function PatchPanel({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  const [copied, setCopied] = useState(false);

  const adds = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const dels = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(patch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* no-op */
    }
  }

  return (
    <div className="bg-surface/60 border border-white/[0.06] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitPullRequest size={14} className="text-zinc-400" strokeWidth={2} />
          <h3 className="text-sm font-medium text-zinc-100">Generated patch</h3>
          <span className="text-xs text-zinc-500">{lines.length} lines</span>
          {(adds > 0 || dels > 0) && (
            <span className="ml-1 inline-flex items-center gap-1.5 text-[11px] font-mono">
              <span className="text-emerald-400">+{adds}</span>
              <span className="text-red-400">−{dels}</span>
            </span>
          )}
        </div>
        <button
          onClick={copy}
          className="text-xs text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/[0.04] transition-colors"
        >
          {copied ? (
            <>
              <Check size={12} /> Copied
            </>
          ) : (
            <>
              <Copy size={12} /> Copy
            </>
          )}
        </button>
      </div>

      <pre className="overflow-auto p-4 text-xs leading-relaxed max-h-72 font-mono">
        {lines.map((line, i) => {
          const isAdd  = line.startsWith("+") && !line.startsWith("+++");
          const isDel  = line.startsWith("-") && !line.startsWith("---");
          const isHead = line.startsWith("@@");
          const isFile = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ");
          const cls = isAdd
            ? "text-emerald-300 bg-emerald-500/[0.06]"
            : isDel
            ? "text-red-300 bg-red-500/[0.06]"
            : isHead
            ? "text-cyan-400"
            : isFile
            ? "text-zinc-500"
            : "text-zinc-400";
          return (
            <span key={i} className={`block ${cls}`}>
              {line || "\u00A0"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
