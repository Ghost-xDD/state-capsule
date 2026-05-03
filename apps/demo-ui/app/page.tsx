import Link from 'next/link';
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircuitBoard,
  Database,
  Hexagon,
  Network,
  RadioTower,
  RefreshCcw,
  ShieldCheck,
} from 'lucide-react';

const proofRows = [
  ['task_id', 'support-ticket-482', 'stable'],
  ['capsule.head', '0x8cf2...19ab', '0G KV'],
  ['current_holder', 'agent-b', 'portable'],
  ['next_action', 'continue from checkpoint', 'signed'],
];

const flow = [
  {
    label: 'Agent A',
    detail: 'publishes signed capsule',
    tone: 'text-cyan-300',
  },
  {
    label: 'Runtime',
    detail: 'process crashes or hands off',
    tone: 'text-red-300',
  },
  {
    label: 'Agent B',
    detail: 'restores verified state',
    tone: 'text-emerald-300',
  },
  {
    label: 'Adapter',
    detail: 'resumes framework loop',
    tone: 'text-amber-300',
  },
  {
    label: 'Observer',
    detail: 'verifies capsule chain',
    tone: 'text-violet-300',
  },
];

const capabilities = [
  {
    icon: RefreshCcw,
    title: 'Crash-resumable agents',
    body: 'Every specialist writes the facts, constraints, decisions, and next action another process needs to continue without replaying the whole investigation.',
  },
  {
    icon: ShieldCheck,
    title: 'Verifiable handoffs',
    body: 'Capsules are signed, chained, anchored, and summarized through 0G Compute so receivers can trust what changed and why.',
  },
  {
    icon: Network,
    title: 'Real swarm topology',
    body: 'Triager, Reproducer, Patcher, and Reviewer coordinate over AXL as separate nodes with separate failure domains.',
  },
];

const stack = [
  ['0G Storage', 'Mutable capsule head plus append-only log'],
  ['0G Chain', 'Registry anchors for capsule lineage'],
  ['0G Compute', 'Sealed summaries for fast restore'],
  ['Gensyn AXL', 'Live multi-node coordination'],
  ['ENS', 'Human-readable task pointers'],
  ['Adapters', 'OpenClaw, LangChain, Vercel AI SDK'],
];

function ProductProof() {
  return (
    <div className="relative border border-white/[0.08] bg-[#101014] shadow-2xl shadow-black/30">
      <div className="flex h-10 items-center gap-2 border-b border-white/[0.07] px-4">
        <span className="h-2.5 w-2.5 bg-red-400/70" />
        <span className="h-2.5 w-2.5 bg-amber-300/70" />
        <span className="h-2.5 w-2.5 bg-emerald-300/70" />
        <span className="ml-auto font-mono text-[11px] text-zinc-600">
          state-capsule-sdk
        </span>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="border-b border-white/[0.07] p-5 lg:border-b-0 lg:border-r">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                Protocol trace
              </p>
              <h2 className="mt-1 text-lg font-semibold text-zinc-100">
                The next process starts with verified state.
              </h2>
            </div>
            <RadioTower size={18} className="text-cyan-300" />
          </div>

          <div className="space-y-2">
            {flow.map((step, index) => (
              <div
                key={step.label}
                className="grid grid-cols-[1.25rem_1fr] items-start gap-3"
              >
                <div className="flex flex-col items-center">
                  <span
                    className={`mt-1 h-2.5 w-2.5 border border-current ${step.tone}`}
                  />
                  {index < flow.length - 1 && (
                    <span className="mt-1 h-8 w-px bg-white/[0.09]" />
                  )}
                </div>
                <div className="min-w-0 pb-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium text-zinc-100">
                      {step.label}
                    </p>
                    <p className="font-mono text-[11px] text-zinc-600">
                      +{(index * 17 + 4).toString().padStart(2, '0')}s
                    </p>
                  </div>
                  <p className="mt-0.5 text-sm text-zinc-500">{step.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                Capsule primitive
              </p>
              <h2 className="mt-1 text-lg font-semibold text-zinc-100">
                Minimal, portable, framework-agnostic.
              </h2>
            </div>
            <Database size={18} className="text-emerald-300" />
          </div>

          <div className="border border-white/[0.07] bg-black/20">
            {proofRows.map(([key, value, source]) => (
              <div
                key={key}
                className="grid grid-cols-[1fr_auto] gap-3 border-b border-white/[0.06] px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="font-mono text-[12px] text-zinc-200">{key}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-cyan-300/80">
                    {value}
                  </p>
                </div>
                <span className="self-center border border-white/[0.08] px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                  {source}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-3 border border-white/[0.07] bg-black/20">
            {['64 KB soft cap', 'signed writes', 'schema migration'].map(
              (stat) => (
                <div
                  key={stat}
                  className="border-r border-white/[0.06] p-3 last:border-r-0"
                >
                  <p className="text-sm font-semibold text-zinc-100">{stat}</p>
                  <p className="mt-1 text-[11px] text-zinc-600">sdk contract</p>
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[#0a0a0c] text-zinc-100">
      <header className="border-b border-white/[0.06]">
        <nav className="mx-auto flex h-16 max-w-7xl items-center px-5 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <Hexagon size={18} className="text-cyan-300" strokeWidth={2} />
            <span className="text-sm font-semibold tracking-tight">
              State Capsule
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-5 text-sm">
            <a
              href="#architecture"
              className="hidden text-zinc-400 transition hover:text-zinc-100 sm:inline"
            >
              Architecture
            </a>
            <a
              href="#sdk"
              className="hidden text-zinc-400 transition hover:text-zinc-100 sm:inline"
            >
              SDK
            </a>
            <Link
              href="/demo"
              className="inline-flex h-9 items-center gap-2 border border-white/[0.1] px-3 text-zinc-100 transition hover:border-cyan-300/50 hover:text-cyan-200"
            >
              Demo
              <ArrowRight size={14} />
            </Link>
          </div>
        </nav>
      </header>

      <section className="border-b border-white/[0.06]">
        <div className="mx-auto max-w-7xl px-5 py-14 sm:px-6 lg:py-20">
          <div className="mx-auto max-w-4xl text-center">
            <div className="mb-5 inline-flex w-fit items-center gap-2 border border-emerald-300/20 bg-emerald-300/[0.06] px-3 py-1.5 text-xs font-medium text-emerald-200">
              <CheckCircle2 size={13} />
              Durable state for agent runtimes.
            </div>
            <h1 className="text-5xl font-semibold leading-[1.02] tracking-tight text-white sm:text-6xl">
              Continuity protocol for agent swarms
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-zinc-400">
              State Capsule is an SDK and protocol for checkpointing, restoring,
              and verifying agent work across processes, frameworks, and nodes.
            </p>
            <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
              <Link
                href="/demo"
                className="inline-flex h-11 items-center justify-center gap-2 bg-zinc-100 px-5 text-sm font-semibold text-zinc-950 transition hover:bg-white"
              >
                Try MaintainerSwarm
                <ArrowRight size={15} />
              </Link>
              <a
                href="#architecture"
                className="inline-flex h-11 items-center justify-center gap-2 border border-white/[0.1] px-5 text-sm font-semibold text-zinc-200 transition hover:border-cyan-300/50 hover:text-cyan-200"
              >
                View architecture
              </a>
            </div>
          </div>

          <div className="mt-12">
            <ProductProof />
          </div>
        </div>
      </section>

      <section className="border-b border-white/[0.06]">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-8 sm:grid-cols-3 sm:px-6">
          {capabilities.map(({ icon: Icon, title, body }) => (
            <article
              key={title}
              className="border border-white/[0.07] bg-white/[0.015] p-5"
            >
              <Icon size={18} className="text-cyan-300" />
              <h2 className="mt-5 text-base font-semibold text-zinc-100">
                {title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-b border-white/[0.06] bg-white/[0.012]">
        <div className="mx-auto grid max-w-7xl gap-6 px-5 py-10 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
              Demo application
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">
              MaintainerSwarm is the proof, not the product.
            </h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['SDK', 'create, update, restore, verify, subscribe'],
              [
                'Protocol',
                'signed capsule chain with storage and anchor hooks',
              ],
              ['Demo', 'open-source maintenance swarm built on top'],
            ].map(([title, body]) => (
              <div
                key={title}
                className="border border-white/[0.07] bg-[#101014] p-4"
              >
                <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="architecture" className="border-b border-white/[0.06]">
        <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                Architecture
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">
                Durability and coordination are separate on purpose.
              </h2>
              <p className="mt-4 text-base leading-7 text-zinc-400">
                State Capsule owns durable task state. Storage, chain anchors,
                task pointers, and live coordination are pluggable integration
                layers around the same capsule contract.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {stack.map(([name, description]) => (
                <div
                  key={name}
                  className="border border-white/[0.07] bg-[#101014] p-4"
                >
                  <div className="flex items-center gap-2">
                    <CircuitBoard size={15} className="text-amber-300" />
                    <h3 className="text-sm font-semibold text-zinc-100">
                      {name}
                    </h3>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-zinc-500">
                    {description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="sdk">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:px-6 lg:grid-cols-[1fr_1fr]">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
              SDK surface
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">
              A small primitive with serious failure semantics.
            </h2>
            <p className="mt-4 text-base leading-7 text-zinc-400">
              MaintainerSwarm uses the same SDK surface available to any agent
              runtime. The adapters wire checkpoints into existing frameworks
              instead of asking teams to rewrite their stack.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {['OpenClaw', 'LangChain', 'Vercel AI SDK', 'LlamaIndex'].map(
                (item) => (
                  <span
                    key={item}
                    className="border border-white/[0.08] px-3 py-1.5 text-xs text-zinc-400"
                  >
                    {item}
                  </span>
                ),
              )}
            </div>
          </div>

          <div className="border border-white/[0.08] bg-[#101014]">
            <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
              <Boxes size={15} className="text-violet-300" />
              <span className="text-sm font-medium text-zinc-200">
                restoreCapsule.ts
              </span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[12px] leading-6 text-zinc-300">
              {`const capsule = await restoreCapsule(taskId, {
  verifyChain: true,
  sealedSummary: true,
});

await updateCapsule(capsule, {
  facts: [...capsule.facts, reproWindow],
  next_action: "apply narrowed race fix",
  created_by: "reproducer-02",
});`}
            </pre>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-6 text-sm text-zinc-600 sm:flex-row sm:items-center sm:px-6">
          <span>State Capsule</span>
          <span className="hidden sm:inline">/</span>
          <span>SDK and protocol for crash-resilient agents</span>
          <Link
            href="/demo"
            className="text-cyan-300/80 transition hover:text-cyan-200 sm:ml-auto"
          >
            Open demo
          </Link>
        </div>
      </footer>
    </main>
  );
}
