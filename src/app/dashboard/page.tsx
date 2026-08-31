import Link from "next/link";
import { prisma } from "@/lib/prisma";
import DashboardAutoAnalyze from "./DashboardAutoAnalyze";

function priorityClass(priority: string) {
  if (priority === "Critical") return "bg-red-500/10 text-red-300";
  if (priority === "High") return "bg-orange-500/10 text-orange-300";
  if (priority === "Medium") return "bg-amber-500/10 text-amber-300";
  return "bg-sky-500/10 text-sky-300";
}

function categoryClass(category: string) {
  if (category === "Bug") return "bg-rose-500/10 text-rose-300";
  if (category === "Feature") return "bg-indigo-500/10 text-indigo-300";
  if (category === "Documentation") return "bg-cyan-500/10 text-cyan-300";
  if (category === "Performance") return "bg-purple-500/10 text-purple-300";
  if (category === "Security") return "bg-red-500/10 text-red-300";
  if (category === "Build") return "bg-orange-500/10 text-orange-300";
  return "bg-slate-500/10 text-slate-300";
}

function effortClass(effort: string) {
  if (effort === "Small") return "bg-emerald-500/10 text-emerald-300";
  if (effort === "Medium") return "bg-yellow-500/10 text-yellow-300";
  return "bg-violet-500/10 text-violet-300";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const { jobId } = await searchParams;

  const importJob = jobId
    ? await prisma.importJob.findUnique({
        where: { id: jobId },
        include: {
          repository: {
            include: {
              issues: {
                include: { analysis: true },
                orderBy: { importedAt: "desc" },
              },
            },
          },
        },
      })
    : null;

  const latestRepository = importJob?.repository;
  const issues = latestRepository?.issues ?? [];
  const analyzedIssues = issues.filter((issue) => issue.analysis).length;

  const needsAnalysis =
    !!jobId && issues.length > 0 && analyzedIssues < issues.length;

  const aiFailed =
    importJob?.status === "failed" || importJob?.status === "FAILED";

  const aiComplete =
    issues.length > 0 && analyzedIssues === issues.length && !aiFailed;

  const aiStatusClass = aiFailed
    ? "border-red-400/25 bg-red-500/10 text-red-300"
    : aiComplete
      ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-300"
      : "border-white/10 bg-white/[0.04] text-slate-300";

  const aiStatusLabel = aiFailed
    ? "Analysis failed"
    : aiComplete
      ? "Analysis complete"
      : "Analyzing";

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[#020617] px-6 py-10 text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-[700px] w-[700px] rounded-full bg-blue-600/10 blur-3xl" />
        <div className="absolute bottom-[-20%] right-[-10%] h-[600px] w-[600px] rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.12),transparent_30%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(139,92,246,0.10),transparent_35%)]" />
      </div>

      <div className="relative mx-auto w-full max-w-6xl">
        <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-4 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 backdrop-blur-md">
              AI triage dashboard
            </div>

            <h1 className="max-w-3xl bg-gradient-to-b from-white via-slate-100 to-slate-400 bg-clip-text text-5xl font-semibold leading-[1.08] tracking-tight text-transparent">
              Imported GitHub issues.
            </h1>

            <p className="mt-4 max-w-xl text-base leading-7 text-slate-400">
              Review imported issues, AI summaries, priorities, effort
              estimates, and suggested maintainer replies.
            </p>
          </div>

          <Link
            href="/connect"
            className="group relative inline-flex h-fit shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white px-5 py-3 text-sm font-medium text-slate-950 shadow-xl shadow-black/30 transition-all duration-300 hover:-translate-y-0.5 hover:bg-slate-200"
          >
            <span className="relative z-10">Analyze another repo</span>
            <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          </Link>
        </div>

        {!jobId ? (
          <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-black/40 backdrop-blur-2xl">
            <h2 className="text-2xl font-semibold">No import selected</h2>

            <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">
              Connect a public GitHub repository first to import issues into the
              dashboard.
            </p>

            <Link
              href="/connect"
              className="mt-5 inline-flex rounded-xl bg-white px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-slate-200"
            >
              Go to connect
            </Link>
          </div>
        ) : !latestRepository ? (
          <div className="rounded-[28px] border border-red-400/20 bg-red-500/10 p-6 shadow-2xl shadow-black/40 backdrop-blur-2xl">
            <h2 className="text-2xl font-semibold text-red-100">
              Import not found
            </h2>

            <p className="mt-3 max-w-md text-sm leading-6 text-red-200/80">
              This dashboard link does not match a saved import job.
            </p>
          </div>
        ) : (
          <>
            {needsAnalysis && <DashboardAutoAnalyze importJobId={jobId} />}

            <section className="mb-6 grid gap-4 md:grid-cols-3">
              <div className="min-w-0 rounded-[22px] border border-white/10 bg-white/[0.04] p-4 shadow-xl shadow-black/25 backdrop-blur-2xl">
                <p className="text-sm text-slate-500">Repository</p>

                <h2 className="mt-2 break-words text-lg font-semibold text-slate-100">
                  {latestRepository.fullName}
                </h2>
              </div>

              <div className="min-w-0 rounded-[22px] border border-white/10 bg-white/[0.04] p-4 shadow-xl shadow-black/25 backdrop-blur-2xl">
                <p className="text-sm text-slate-500">Imported issues</p>

                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                  {issues.length}
                </h2>
              </div>

              <div
                className={`min-w-0 rounded-[22px] border p-4 shadow-xl shadow-black/25 backdrop-blur-2xl ${aiStatusClass}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm opacity-80">AI status</p>

                  <span className="shrink-0 rounded-full border border-current/20 px-3 py-1 text-xs">
                    {aiStatusLabel}
                  </span>
                </div>

                <h2 className="mt-2 text-lg font-semibold">
                  {analyzedIssues}/{issues.length} analyzed
                </h2>

                <div className="mt-3 h-2 rounded-full bg-white/10">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      aiFailed
                        ? "bg-red-300"
                        : aiComplete
                          ? "bg-emerald-300"
                          : "bg-white/70"
                    }`}
                    style={{
                      width:
                        issues.length > 0
                          ? `${(analyzedIssues / issues.length) * 100}%`
                          : "0%",
                    }}
                  />
                </div>
              </div>
            </section>

            <section className="space-y-3">
              {issues.map((issue) => {
                const analysis = issue.analysis;
                const priority = analysis?.priority ?? "Unknown";
                const category = analysis?.category ?? "Uncategorized";
                const effort = analysis?.effort ?? "Unknown";

                return (
                  <div
                    key={issue.id}
                    className="min-w-0 rounded-[22px] border border-white/10 bg-white/[0.04] p-4 shadow-xl shadow-black/25 backdrop-blur-2xl"
                  >
                    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="break-words text-sm text-slate-500">
                        #{issue.issueNumber} · {issue.author}
                      </p>

                      <span className="w-fit shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300">
                        {issue.state}
                      </span>
                    </div>

                    <h3 className="break-words text-lg font-semibold text-slate-100">
                      {issue.title}
                    </h3>

                    <p className="mt-2 line-clamp-2 break-words text-sm leading-6 text-slate-400">
                      {issue.body || "No issue description provided."}
                    </p>

                    {analysis ? (
                      <div className="mt-3 min-w-0 rounded-2xl border border-white/10 bg-slate-950/40 p-3">
                        <div className="mb-3 flex flex-wrap gap-2">
                          <span
                            className={`rounded-full px-2.5 py-1 text-[11px] ${priorityClass(
                              priority
                            )}`}
                          >
                            Priority · {priority}
                          </span>

                          <span
                            className={`rounded-full px-2.5 py-1 text-[11px] ${categoryClass(
                              category
                            )}`}
                          >
                            Category · {category}
                          </span>

                          <span
                            className={`rounded-full px-2.5 py-1 text-[11px] ${effortClass(
                              effort
                            )}`}
                          >
                            Effort · {effort}
                          </span>
                        </div>

                        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
                            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
                              Summary
                            </p>

                            <div className="mt-2 h-px w-full bg-gradient-to-r from-white/10 via-white/5 to-transparent" />

                            <p className="mt-3 break-words text-sm leading-6 text-slate-300/90">
                              {analysis.summary ?? "No summary provided."}
                            </p>
                          </div>

                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
                            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
                              Suggested reply
                            </p>

                            <div className="mt-2 h-px w-full bg-gradient-to-r from-white/10 via-white/5 to-transparent" />

                            <p className="mt-3 break-words text-sm leading-6 text-slate-300/90">
                              {analysis.suggestedReply ??
                                "No suggested reply provided."}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`mt-3 rounded-2xl border p-3 ${
                          aiFailed
                            ? "border-red-400/20 bg-red-500/10"
                            : "border-amber-400/20 bg-amber-500/10"
                        }`}
                      >
                        <p
                          className={`text-sm ${
                            aiFailed ? "text-red-200" : "text-amber-200"
                          }`}
                        >
                          {aiFailed
                            ? "AI analysis failed."
                            : "Waiting for AI analysis..."}
                        </p>
                      </div>
                    )}

                    <a
                      href={issue.githubUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex text-sm font-medium text-slate-300 transition hover:text-white"
                    >
                      View on GitHub →
                    </a>
                  </div>
                );
              })}
            </section>
          </>
        )}
      </div>
    </main>
  );
}