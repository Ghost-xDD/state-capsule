"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";

const EXAMPLE_REPOS = [
  "https://github.com/nicolo-ribaudo/tc39-proposal-await-dictionary",
  "https://github.com/sindresorhus/execa",
];

export function DemoLauncher({ compact = false }: { compact?: boolean }) {
  const hostedReplay = process.env["NEXT_PUBLIC_DEMO_UI_MODE"] === "replay";
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
    <form
      onSubmit={handleSubmit}
      className={
        compact
          ? "border border-white/[0.08] bg-[#111114]/90 p-4 shadow-2xl shadow-black/30"
          : "border border-white/[0.08] bg-[#111114]/80 p-5 shadow-2xl shadow-black/30"
      }
    >
      <label className="block text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
        {hostedReplay ? "Replay source" : "GitHub repository"}
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          ref={inputRef}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={hostedReplay ? "https://github.com/sindresorhus/execa" : "https://github.com/you/your-ts-lib"}
          disabled={loading}
          className="min-h-11 flex-1 border border-white/[0.09] bg-black/30 px-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/10 disabled:opacity-50"
          required
        />
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="inline-flex min-h-11 items-center justify-center gap-2 bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          {loading ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Cloning
            </>
          ) : (
            <>
              {hostedReplay ? "Watch replay" : "Run swarm"}
              <ArrowRight size={15} />
            </>
          )}
        </button>
      </div>

      {error && (
        <p className="mt-3 border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-600">{hostedReplay ? "Captured from" : "Try"}</span>
        {EXAMPLE_REPOS.map((repo) => (
          <button
            key={repo}
            type="button"
            onClick={() => setUrl(repo)}
            disabled={loading}
            className="text-xs text-cyan-300/80 underline-offset-4 transition hover:text-cyan-200 hover:underline disabled:opacity-40"
          >
            {repo.replace("https://github.com/", "")}
          </button>
        ))}
      </div>
    </form>
  );
}
