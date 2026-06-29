"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AnalyzeStatus = "loading" | "success" | "error";

export default function DashboardAutoAnalyze({
  importJobId,
}: {
  importJobId: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<AnalyzeStatus>("loading");
  const [message, setMessage] = useState(
  "AI analysis is running. This may take 10–20 seconds depending on the repository..."
);

  useEffect(() => {
    let cancelled = false;

    async function runAnalysis() {
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            importJobId,
          }),
        });

        const data = await response.json();

        if (cancelled) return;

        if (!response.ok) {
          setStatus("error");
          setMessage(data.error || "AI analysis failed.");
          return;
        }

        setStatus("success");
        setMessage("AI analysis complete.");
        router.refresh();
      } catch {
        if (cancelled) return;

        setStatus("error");
        setMessage("AI analysis failed. Please refresh and try again.");
      }
    }

    runAnalysis();

    return () => {
      cancelled = true;
    };
  }, [importJobId, router]);

  const isLoading = status === "loading";
  const isError = status === "error";
  const isSuccess = status === "success";

  return (
    <div
      className={`mb-6 rounded-[22px] border p-4 shadow-xl shadow-black/25 backdrop-blur-2xl ${
        isError
          ? "border-red-400/25 bg-red-500/10 text-red-300"
          : isSuccess
            ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-300"
            : "border-white/10 bg-white/[0.04] text-slate-300"
      }`}
    >
      <div className="flex items-center gap-3">
        {isLoading && (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        )}

        {isError && (
          <div className="h-2.5 w-2.5 rounded-full bg-red-300 shadow-[0_0_18px_rgba(252,165,165,0.8)]" />
        )}

        {isSuccess && (
          <div className="h-2.5 w-2.5 rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.8)]" />
        )}

        <p className="text-sm font-medium">{message}</p>
      </div>

      
    </div>
  );
}
