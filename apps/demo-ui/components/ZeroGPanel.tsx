"use client";

import type { CapsuleInfo } from "@/lib/run-store";
import {
  Hexagon,
  Database,
  Link2,
  Globe,
  Cpu,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";

const short = (s: string) =>
  s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;

function Stat({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-2xl font-semibold tabular-nums text-zinc-100">
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mt-0.5">
        {label}
      </div>
    </div>
  );
}

function Section({
  Icon,
  label,
  children,
}: {
  Icon:     LucideIcon;
  label:    string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3 border-t border-white/[0.05]">
      <div className="flex items-center gap-2 mb-2 text-[11px] uppercase tracking-wider text-zinc-500">
        <Icon size={12} strokeWidth={2} />
        {label}
      </div>
      <div className="text-[13px]">{children}</div>
    </div>
  );
}

export function ZeroGPanel({ capsule }: { capsule: CapsuleInfo }) {
  const blobCount = capsule.logRoots.length;
  const txCount   = capsule.txHashes.length;
  const capCount  = capsule.capsuleIds.length;
  const empty     = capCount === 0 && blobCount === 0 && txCount === 0;

  return (
    <div className="bg-surface/60 border border-white/[0.06] rounded-xl flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-100">0G Layer</h3>
          <span className="text-xs text-zinc-500">storage · chain · compute</span>
        </div>
      </div>

      {/* Top stats */}
      <div className="px-4 py-4 flex items-stretch gap-4">
        <Stat value={capCount}  label="Capsules" />
        <div className="w-px bg-white/[0.05]" />
        <Stat value={blobCount} label="Blobs" />
        <div className="w-px bg-white/[0.05]" />
        <Stat value={txCount}   label="On-chain txs" />
      </div>

      {empty && (
        <div className="px-4 py-6 text-sm text-zinc-600 text-center border-t border-white/[0.05]">
          No on-chain activity yet…
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {capsule.capsuleIds.length > 0 && (
          <Section Icon={Hexagon} label="Capsule chain">
            <ol className="space-y-1">
              {capsule.capsuleIds.slice(-4).map((id, i) => {
                const idx = capsule.capsuleIds.length - Math.min(4, capsule.capsuleIds.length) + i + 1;
                return (
                  <li key={id} className="flex items-center gap-3 font-mono">
                    <span className="text-zinc-600 w-4 text-right text-xs tabular-nums">
                      {idx}
                    </span>
                    <code className="text-cyan-300/90 text-xs">{short(id)}</code>
                  </li>
                );
              })}
            </ol>
          </Section>
        )}

        {capsule.logRoots.length > 0 && (
          <Section Icon={Database} label="Blob roots">
            <ul className="space-y-1">
              {capsule.logRoots.slice(-4).map((r) => (
                <li key={r} className="font-mono">
                  <code className="text-purple-300/90 text-xs">{short(r)}</code>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {capsule.txHashes.length > 0 && (
          <Section Icon={Link2} label="On-chain txs">
            <ul className="space-y-1">
              {capsule.txHashes.slice(-4).map((tx) => (
                <li key={tx} className="font-mono">
                  <a
                    href={`https://chainscan-galileo.0g.ai/tx/${tx}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-300/90 hover:text-emerald-200 inline-flex items-center gap-1 text-xs"
                  >
                    {short(tx)}
                    <ExternalLink size={11} strokeWidth={2} />
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {capsule.ensSub && (
          <Section Icon={Globe} label="ENS pointer">
            <a
              href={`https://app.ens.domains/${capsule.ensSub}`}
              target="_blank"
              rel="noreferrer"
              className="text-sky-300/90 hover:text-sky-200 font-mono text-xs break-all inline-flex items-center gap-1"
            >
              {capsule.ensSub}
              <ExternalLink size={11} strokeWidth={2} />
            </a>
          </Section>
        )}

        {capsule.computeModel && (
          <Section Icon={Cpu} label="Sealed compute">
            <p className="font-mono text-amber-300/90 text-xs break-all">
              {capsule.computeModel}
            </p>
            {capsule.computeSummary && (
              <p className="text-zinc-400 text-xs mt-1.5 leading-snug">
                {capsule.computeSummary.slice(0, 160)}
                {capsule.computeSummary.length > 160 ? "…" : ""}
              </p>
            )}
          </Section>
        )}
      </div>
    </div>
  );
}
