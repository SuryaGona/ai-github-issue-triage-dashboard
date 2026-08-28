"use client";

import Link from "next/link";
import { useState } from "react";

type Issue = {
  id: string;
  number: number;
  title: string;
  state: string;
  author: string;
};

export default function ConnectPage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [submittedRepo, setSubmittedRepo] = useState("");
  const [importJobId, setImportJobId] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError("");
    setSubmittedRepo("");
    setImportJobId("");
    setIssues([]);
    setIsLoading(true);

    const response = await fetch("/api/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repoUrl }),
    });

    let data;

    try {
      data = await response.json();
    } catch {
      setIsLoading(false);
      setError("Server crashed. Check the terminal for the real backend error.");
      return;
    }

    setIsLoading(false);

    if (!response.ok) {
      setError(data.error || "Something went wrong.");
      return;
    }

    setSubmittedRepo(data.repo);
    setImportJobId(data.importJobId);
    setIssues(data.issues || []);
  }

  return (
    <main className="relative min-h-dvh overflow-x-hidden bg-[#020617] text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-[700px] w-[700px] rounded-full bg-blue-600/10 blur-3xl" />
        <div className="absolute bottom-[-20%] right-[-10%] h-[600px] w-[600px] rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.12),transparent_30%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(139,92,246,0.10),transparent_35%)]" />
      </div>

      <section className="relative mx-auto w-full max-w-6xl px-6 py-8">
        <Link
          href="/"
          className="inline-flex text-sm text-slate-400 transition hover:text-white"
        >
          {"\u2190"} Back home
        </Link>

        <div className="mt-10 grid w-full min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
          <div className="min-w-0">
            <div className="mb-5 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 backdrop-blur-md">
              Connect repository
            </div>

            <h1 className="max-w-2xl bg-gradient-to-b from-white via-slate-100 to-slate-400 bg-clip-text text-5xl font-semibold leading-[1.08] tracking-tight text-transparent">
              Choose a repository to analyze.
            </h1>

            <p className="mt-5 max-w-xl text-base leading-7 text-slate-400">
              Paste a public GitHub repository URL and import real issues for AI
              triage.
            </p>

            <form
              onSubmit={handleSubmit}
              className="mt-8 rounded-[24px] border border-white/10 bg-white/[0.04] p-4 shadow-xl shadow-black/25 backdrop-blur-2xl"
            >
              <label className="mb-3 block text-sm text-slate-400">
                Repository URL
              </label>

              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="Paste a public GitHub repo URL"
                  className="min-h-12 min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-4 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-white/40"
                />

                <button
                  type="submit"
                  disabled={isLoading}
                  className="group relative inline-flex min-h-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white px-6 text-sm font-medium text-slate-950 shadow-xl shadow-black/30 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="relative z-10 flex items-center gap-2">
                    {isLoading && (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-slate-950" />
                    )}

                    <span>{isLoading ? "Importing..." : "Analyze"}</span>
                  </div>

                  <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                </button>
              </div>

              <div className="mt-5">
                <p className="text-sm text-slate-400">
                  Click an example to fill the input.
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    "https://github.com/openai/openai-python",
                    "https://github.com/huggingface/transformers",
                    "https://github.com/microsoft/vscode",
                  ].map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setRepoUrl(example)}
                      className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-300 transition hover:border-blue-400/40 hover:bg-blue-500/10 hover:text-blue-200"
                    >
                      {example.replace("https://github.com/", "")} {"\u2192"}
                    </button>
                  ))}
                </div>
              </div>
            </form>

            {error && (
              <div className="mt-5 rounded-2xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-200">
                {error}
              </div>
            )}

            {submittedRepo && (
              <div className="mt-5 rounded-[24px] border border-emerald-400/20 bg-emerald-400/10 p-4 shadow-xl shadow-black/20 backdrop-blur-xl">
                <p className="text-sm font-medium text-emerald-300">
                  Repository imported successfully
                </p>

                <p className="mt-2 break-all text-sm text-emerald-100/80">
                  {submittedRepo}
                </p>
              </div>
            )}
          </div>

          <div className="min-w-0 rounded-[24px] border border-white/10 bg-white/[0.04] p-4 shadow-xl shadow-black/25 backdrop-blur-2xl">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-slate-300">Preview</p>

              <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-400">
                {submittedRepo
                  ? `${issues.length} imported`
                  : isLoading
                    ? "Importing"
                    : "Waiting"}
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {submittedRepo && issues.length === 0 ? (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-400">
                  No open issues found for this repository.
                </div>
              ) : issues.length > 0 ? (
                issues.slice(0, 4).map((issue, index) => (
                  <div
                    key={issue.id}
                    className={`rounded-2xl border border-white/10 bg-white/[0.03] p-4 ${
                      index === 3 ? "opacity-40 blur-[0.5px]" : ""
                    }`}
                  >
                    <p className="line-clamp-2 break-words text-sm font-medium text-slate-200">
                      #{issue.number} {issue.title}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                      <span>{issue.state}</span>
                      <span>{"\u00B7"}</span>
                      <span>{issue.author}</span>
                    </div>
                  </div>
                ))
              ) : (
                <>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="h-2 w-4/5 rounded-full bg-white/15" />
                    <div className="mt-3 h-2 w-2/3 rounded-full bg-white/10" />
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                    <div className="h-2 w-3/4 rounded-full bg-white/15" />
                    <div className="mt-3 h-2 w-1/2 rounded-full bg-white/10" />
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                    <div className="h-2 w-2/3 rounded-full bg-white/15" />
                    <div className="mt-3 h-2 w-3/5 rounded-full bg-white/10" />
                  </div>
                </>
              )}
            </div>

            {importJobId && (
              <Link
                href={`/dashboard?jobId=${importJobId}`}
                className="group relative mt-5 flex w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white px-5 py-3 text-sm font-medium text-slate-950 transition-all duration-300 hover:-translate-y-0.5 hover:bg-slate-200"
              >
                <span className="relative z-10">Open dashboard</span>

                <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
              </Link>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}