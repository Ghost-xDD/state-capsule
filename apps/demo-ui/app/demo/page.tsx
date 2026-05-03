import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  GitBranch,
  Hexagon,
  Network,
  ShieldCheck,
} from "lucide-react";
import { DemoLauncher } from "@/components/DemoLauncher";

const hostedReplay =
  process.env["DEMO_UI_MODE"] === "replay" || process.env["VERCEL"] === "1";

const demoSteps = hostedReplay ? [
  "Stream a hosted replay captured from a live run",
  "Show the forced Reproducer kill and restore",
  "Preserve the restored test plan after restart",
  "Display generated patch and reviewer verdict",
] : [
  "Clone target repository",
  "Run four-agent maintainer swarm",
  "Checkpoint capsule state to 0G",
  "Stream recovery trace and generated patch",
];

export default function DemoPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0c] text-zinc-100">
      <header className="border-b border-white/[0.06]">
        <nav className="mx-auto flex h-16 max-w-6xl items-center px-5 sm:px-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-zinc-400 transition hover:text-zinc-100"
          >
            <ArrowLeft size={15} />
            Back
          </Link>
          <div className="mx-auto flex items-center gap-2">
            <Hexagon size={17} className="text-cyan-300" />
            <span className="text-sm font-semibold text-zinc-100">
              State Capsule
            </span>
          </div>
          <div className="w-12" />
        </nav>
      </header>

      <section className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:py-20">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
            MaintainerSwarm demo
          </p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            {hostedReplay
              ? "Watch the captured continuity demo."
              : "Paste a repo and watch the continuity layer do real work."}
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-zinc-400">
            {hostedReplay
              ? "The hosted version streams a deterministic replay captured from a live MaintainerSwarm run. Local mode still runs the pipeline directly."
              : "The demo clones a GitHub repository, starts the specialist swarm, streams each capsule update, and lands on the run dashboard when the task is created."}
          </p>

          <div className="mt-8 grid gap-3">
            {demoSteps.map((step) => (
              <div key={step} className="flex items-center gap-3 text-sm text-zinc-300">
                <CheckCircle2 size={15} className="text-emerald-300" />
                {step}
              </div>
            ))}
          </div>
        </div>

        <div className="self-start">
          <DemoLauncher />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              [Network, "AXL mesh", "four specialist nodes"],
              [Database, "State capsules", "signed checkpoint chain"],
              [ShieldCheck, "Signed capsules", "verified handoffs"],
              [GitBranch, "Patch output", "reviewed local diff"],
            ].map(([Icon, title, body]) => {
              const TypedIcon = Icon as typeof Network;
              return (
                <div key={title as string} className="border border-white/[0.07] bg-white/[0.015] p-4">
                  <TypedIcon size={16} className="text-cyan-300" />
                  <p className="mt-3 text-sm font-semibold text-zinc-100">
                    {title as string}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">{body as string}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </main>
  );
}
