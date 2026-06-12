import Link from "next/link";

export default function Home() {
  return (
    <main className="relative min-h-dvh overflow-x-hidden bg-[#020617] text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-[700px] w-[700px] rounded-full bg-blue-600/10 blur-3xl" />
        <div className="absolute bottom-[-20%] right-[-10%] h-[600px] w-[600px] rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.12),transparent_30%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(139,92,246,0.10),transparent_35%)]" />
      </div>

      <section className="relative mx-auto flex min-h-dvh w-full max-w-7xl items-center px-6 py-12 sm:py-16">
        <div className="grid w-full min-w-0 items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div className="min-w-0 max-w-2xl">
            <div className="mb-8 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 backdrop-blur-md">
              AI-powered GitHub issue triage
            </div>

            <h1 className="max-w-2xl bg-gradient-to-b from-white via-slate-100 to-slate-400 bg-clip-text text-5xl font-semibold leading-[1.05] tracking-tight text-transparent sm:text-7xl">
              Prioritize GitHub issues with AI.
            </h1>

            <p className="mt-7 max-w-lg text-base leading-7 text-slate-400 sm:text-lg">
              Import repository issues and turn them into clear summaries,
              priorities, and effort estimates.
            </p>

            <div className="mt-10">
              <Link
                href="/connect"
                className="group relative inline-flex items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white px-7 py-3 text-sm font-medium text-slate-950 shadow-2xl shadow-black/30 transition-all duration-300 hover:-translate-y-1 hover:bg-slate-200 hover:shadow-white/10"
              >
                <span className="relative z-10">Get started</span>
                <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
              </Link>
            </div>
          </div>

          <div className="relative flex min-w-0 items-center justify-center">
            <div className="absolute h-[360px] w-[360px] rounded-full bg-violet-500/10 blur-3xl" />

            <div className="relative w-full max-w-[380px] overflow-hidden rounded-[42px] border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-black/40 backdrop-blur-2xl">
              <div className="absolute inset-0 rounded-[42px] bg-[linear-gradient(to_bottom_right,rgba(255,255,255,0.08),transparent_45%)]" />

              <div className="relative z-10 flex min-w-0 items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs text-slate-500">Repository URL</p>

                  <p className="mt-2 truncate text-sm font-medium text-slate-200">
                    https://github.com/company/project
                  </p>
                </div>

                <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_20px_rgba(74,222,128,0.9)]" />
              </div>

              <div className="relative z-10 mt-9 space-y-3">
                {[
                  ["Issue #4281", "High", "bg-red-500/10 text-red-300", "w-4/5", "w-2/3"],
                  ["Issue #3910", "Medium", "bg-amber-500/10 text-amber-300", "w-3/4", "w-1/2"],
                  ["Issue #2874", "Low", "bg-blue-500/10 text-blue-300", "w-2/3", "w-3/5"],
                ].map(([issue, level, badge, firstLine, secondLine]) => (
                  <div
                    key={issue}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-xl"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-slate-500">{issue}</p>

                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] ${badge}`}
                      >
                        {level}
                      </span>
                    </div>

                    <div
                      className={`mt-4 h-2 ${firstLine} rounded-full bg-white/15`}
                    />
                    <div
                      className={`mt-2 h-2 ${secondLine} rounded-full bg-white/10`}
                    />
                  </div>
                ))}
              </div>

              <div className="absolute bottom-[-120px] left-1/2 h-[220px] w-[220px] -translate-x-1/2 rounded-full bg-blue-500/10 blur-3xl" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}