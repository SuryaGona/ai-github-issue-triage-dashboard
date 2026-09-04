"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AnalysisAttemptResult = {
  success: boolean;
  error: string | null;
};

const analysisRequests = new Map<
  string,
  Promise<AnalysisAttemptResult>
>();

function startAnalysis(
  importJobId: string,
): Promise<AnalysisAttemptResult> {
  const existingRequest =
    analysisRequests.get(importJobId);

  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const response = await fetch(
        "/api/analyze",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            importJobId,
          }),
        },
      );

      const data: unknown =
        await response
          .json()
          .catch(() => null);

      const error =
        data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
          ? data.error
          : null;

      return {
        success: response.ok,
        error,
      };
    } catch {
      return {
        success: false,
        error:
          "AI analysis failed. This may be a temporary model limit or connection issue.",
      };
    }
  })();

  analysisRequests.set(
    importJobId,
    request,
  );

  void request.finally(() => {
    if (
      analysisRequests.get(
        importJobId,
      ) === request
    ) {
      analysisRequests.delete(
        importJobId,
      );
    }
  });

  return request;
}

export default function DashboardAutoAnalyze({
  importJobId,
}: {
  importJobId: string;
}) {
  const router = useRouter();

  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void startAnalysis(
      importJobId,
    ).then((result) => {
      if (!active) {
        return;
      }

      if (!result.success) {
        setError(
          result.error ??
            "AI analysis failed. This may be a temporary model limit or connection issue.",
        );

        return;
      }

      router.refresh();
    });

    return () => {
      active = false;
    };
  }, [importJobId, router]);

  if (error) {
    return (
      <div className="mb-6 rounded-[22px] border border-red-400/25 bg-red-500/10 p-4 text-red-300 shadow-xl shadow-black/25 backdrop-blur-2xl">
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-2.5 rounded-full bg-red-300 shadow-[0_0_18px_rgba(252,165,165,0.8)]" />

          <p className="text-sm font-medium">
            {error}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-[22px] border border-white/10 bg-white/[0.04] p-4 text-slate-300 shadow-xl shadow-black/25 backdrop-blur-2xl">
      <div className="flex items-center gap-3">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white" />

        <p className="text-sm font-medium">
          AI analysis is running. This may take 10 to 20 seconds depending on the repository...
        </p>
      </div>
    </div>
  );
}