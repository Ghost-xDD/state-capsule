"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

const EXAMPLE_REPOS = [
  "https://github.com/nicolo-ribaudo/tc39-proposal-await-dictionary",
  "https://github.com/sindresorhus/execa",
];

function GlowDot({ color }: { color: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full mr-2 ${color}`}
      style={{ boxShadow: `0 0 6px currentColor` }}
    />
  );
}

export default function HomePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: url.trim() }),
      });

      const data = (await res.json()) as {
        taskId?: string;
        error?: string;
        relFile?: string;
        totalFiles?: number;
      };

      if (!res.ok || !data.taskId) {
        setError(data.error ?? "Unknown error");
        setLoading(false);
        return;
      }

      router.push(`/run?id=${data.taskId}`);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-16">
      {/* Header */}
      <div className="mb-12 text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
          <span className="text-3xl">⬡</span>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            State Capsule
          </h1>
        </div>
        <p className="text-gray-400 text-lg max-w-lg">
          Paste a GitHub repo — AI agents clone it, find bugs, and generate a
          patch. Every step is checkpointed to{" "}
          <span className="text-indigo-400">0G Storage</span> and anchored
          on-chain.
        </p>
      </div>

      {/* Input card */}
      <div className="w-full max-w-xl">
        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-2xl"
        >
          <label className="block text-xs uppercase tracking-widest text-gray-500 mb-2">
            GitHub Repository URL
          </label>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/you/your-ts-lib"
              disabled={loading}
              className="flex-1 bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              required
            />
            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold px-5 py-3 rounded-xl transition-colors text-sm whitespace-nowrap"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Cloning…
                </span>
              ) : (
                "Run Swarm →"
              )}
            </button>
          </div>

          {error && (
            <p className="mt-3 text-red-400 text-sm border border-red-800 bg-red-950 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Examples */}
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="text-xs text-gray-600">Try:</span>
            {EXAMPLE_REPOS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setUrl(r)}
                disabled={loading}
                className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2 disabled:opacity-40"
              >
                {r.replace("https://github.com/", "")}
              </button>
            ))}
          </div>
        </form>

        {/* Stack badges */}
        <div className="mt-6 flex flex-wrap gap-3 justify-center text-xs text-gray-500">
          {[
            { dot: "bg-blue-400", label: "0G Storage" },
            { dot: "bg-purple-400", label: "0G Compute" },
            { dot: "bg-green-400", label: "ENS Subnames" },
            { dot: "bg-orange-400", label: "AXL / GossipSub" },
            { dot: "bg-pink-400", label: "Kill-and-Resume" },
          ].map(({ dot, label }) => (
            <span
              key={label}
              className="flex items-center bg-gray-900 border border-gray-800 rounded-full px-3 py-1"
            >
              <GlowDot color={dot} />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Footer */}
      <p className="mt-16 text-xs text-gray-700">
        State Capsule — ETHGlobal 2025 ·{" "}
        <a
          href="https://github.com"
          className="hover:text-gray-500 transition-colors"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </p>
    </main>
  );
}
