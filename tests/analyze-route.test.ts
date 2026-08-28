import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  importJobFindUnique: vi.fn(),
  issueAnalysisUpsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: {
      findUnique: prismaMocks.importJobFindUnique,
    },
    issueAnalysis: {
      upsert: prismaMocks.issueAnalysisUpsert,
    },
    $transaction: prismaMocks.transaction,
  },
}));

import { POST } from "@/app/api/analyze/route";

const fetchMock = vi.fn();

function analyzeRequest(importJobId?: string) {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      importJobId === undefined ? {} : { importJobId }
    ),
  });
}

function geminiResponse(content: string) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: content,
              },
            ],
          },
        },
      ],
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

function unanalyzedIssue(
  id: string,
  title = `Title for ${id}`,
  body = `Body for ${id}`
) {
  return {
    id,
    title,
    body,
    analysis: null,
  };
}

function validAnalysis(
  issueId: string,
  overrides: Partial<{
    summary: string;
    category:
      | "Bug"
      | "Feature"
      | "Documentation"
      | "Performance"
      | "Security"
      | "Build"
      | "Other";
    priority: "Critical" | "High" | "Medium" | "Low";
    effort: "Small" | "Medium" | "Large";
    suggestedReply: string;
  }> = {}
) {
  return {
    issueId,
    summary: `Summary for ${issueId}`,
    category: "Bug" as const,
    priority: "Medium" as const,
    effort: "Small" as const,
    suggestedReply: `Reply for ${issueId}`,
    ...overrides,
  };
}

function mockImportJob(
  issues: Array<{
    id: string;
    title: string;
    body: string | null;
    analysis: null | { id: string };
  }>
) {
  prismaMocks.importJobFindUnique.mockResolvedValue({
    id: "job-1",
    repository: {
      fullName: "octo/repo",
      issues,
    },
  });
}

async function runRejectedGeminiBatch(result: unknown) {
  vi.useFakeTimers();

  fetchMock.mockImplementation(async () =>
    geminiResponse(JSON.stringify(result))
  );

  const consoleLogSpy = vi
    .spyOn(console, "log")
    .mockImplementation(() => undefined);

  const consoleErrorSpy = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);

  const responsePromise = POST(analyzeRequest("job-1"));

  await vi.runAllTimersAsync();

  const response = await responsePromise;

  expect(response.status).toBe(500);

  await expect(response.json()).resolves.toEqual({
    success: false,
    error:
      "AI analysis failed. This may be a temporary model limit or connection issue.",
  });

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(prismaMocks.issueAnalysisUpsert).not.toHaveBeenCalled();
  expect(prismaMocks.transaction).not.toHaveBeenCalled();

  expect(consoleLogSpy).toHaveBeenCalledWith(
    "Gemini batch attempt 1 failed"
  );
  expect(consoleLogSpy).toHaveBeenCalledWith(
    "Gemini batch attempt 2 failed"
  );
  expect(consoleLogSpy).toHaveBeenCalledWith(
    "Gemini batch attempt 3 failed"
  );

  expect(consoleErrorSpy).toHaveBeenCalled();
}

describe("POST /api/analyze", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");

    prismaMocks.issueAnalysisUpsert.mockImplementation(async ({ create }) => ({
      id: `analysis-${create.issueId}`,
      ...create,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    }));

    prismaMocks.transaction.mockImplementation(
      async (operations: Array<Promise<unknown>>) => Promise.all(operations)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects a request without an importJobId", async () => {
    const response = await POST(analyzeRequest());

    expect(response.status).toBe(400);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "importJobId is required.",
    });

    expect(prismaMocks.importJobFindUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects analysis when the Gemini API key is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");

    const response = await POST(analyzeRequest("job-1"));

    expect(response.status).toBe(500);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "GEMINI_API_KEY is missing from .env.",
    });

    expect(prismaMocks.importJobFindUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("returns 404 when the import job does not exist", async () => {
    prismaMocks.importJobFindUnique.mockResolvedValue(null);

    const response = await POST(analyzeRequest("missing-job"));

    expect(response.status).toBe(404);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Import job not found.",
    });

    expect(prismaMocks.importJobFindUnique).toHaveBeenCalledWith({
      where: {
        id: "missing-job",
      },
      include: {
        repository: {
          include: {
            issues: {
              include: {
                analysis: true,
              },
              take: 10,
              orderBy: {
                importedAt: "desc",
              },
            },
          },
        },
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("skips Gemini when all imported issues already have analyses", async () => {
    mockImportJob([
      {
        id: "issue-1",
        title: "Existing analysis",
        body: "Already analyzed",
        analysis: {
          id: "analysis-1",
        },
      },
    ]);

    const response = await POST(analyzeRequest("job-1"));

    expect(response.status).toBe(200);

    await expect(response.json()).resolves.toEqual({
      success: true,
      repo: "octo/repo",
      analyzedCount: 0,
      message: "All issues already analyzed.",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.issueAnalysisUpsert).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("sends an explicit JSON schema to Gemini and persists one validated result for each requested issue in one transaction", async () => {
    mockImportJob([
      unanalyzedIssue(
        "issue-1",
        "Build crashes on startup",
        "The application exits during initialization."
      ),
      unanalyzedIssue(
        "issue-2",
        "Improve installation docs",
        "The setup guide is missing a required command."
      ),
      {
        id: "issue-3",
        title: "Already analyzed issue",
        body: "This must not be sent back to Gemini.",
        analysis: {
          id: "analysis-existing",
        },
      },
    ]);

    fetchMock.mockResolvedValueOnce(
      geminiResponse(
        JSON.stringify({
          issues: [
            validAnalysis("issue-1", {
              summary: "Application crashes during initialization.",
              category: "Bug",
              priority: "Critical",
              effort: "Medium",
              suggestedReply:
                "The startup failure appears to occur during initialization; a minimal reproduction would help isolate the failing path.",
            }),
            validAnalysis("issue-2", {
              summary: "Installation guide is missing a setup command.",
              category: "Documentation",
              priority: "Low",
              effort: "Small",
              suggestedReply:
                "The installation guide should include the missing setup command in the documented sequence.",
            }),
          ],
        })
      )
    );

    const response = await POST(analyzeRequest("job-1"));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];

    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test-gemini-key"
    );

    expect(options).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const requestBody = JSON.parse(String(options.body));

    expect(requestBody.generationConfig.responseMimeType).toBe(
      "application/json"
    );

    expect(requestBody.generationConfig.responseJsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        issues: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              issueId: {
                type: "string",
                enum: ["issue-1", "issue-2"],
              },
              summary: {
                type: "string",
              },
              category: {
                type: "string",
                enum: [
                  "Bug",
                  "Feature",
                  "Documentation",
                  "Performance",
                  "Security",
                  "Build",
                  "Other",
                ],
              },
              priority: {
                type: "string",
                enum: ["Critical", "High", "Medium", "Low"],
              },
              effort: {
                type: "string",
                enum: ["Small", "Medium", "Large"],
              },
              suggestedReply: {
                type: "string",
              },
            },
            required: [
              "issueId",
              "summary",
              "category",
              "priority",
              "effort",
              "suggestedReply",
            ],
          },
        },
      },
      required: ["issues"],
    });

    const prompt = requestBody.contents[0].parts[0].text as string;

    expect(prompt).toContain('"id": "issue-1"');
    expect(prompt).toContain('"id": "issue-2"');
    expect(prompt).not.toContain('"id": "issue-3"');

    expect(prismaMocks.issueAnalysisUpsert).toHaveBeenCalledTimes(2);
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);

    const transactionOperations = prismaMocks.transaction.mock.calls[0][0];

    expect(transactionOperations).toHaveLength(2);

    expect(prismaMocks.issueAnalysisUpsert).toHaveBeenNthCalledWith(1, {
      where: {
        issueId: "issue-1",
      },
      update: {
        summary: "Application crashes during initialization.",
        category: "Bug",
        priority: "Critical",
        effort: "Medium",
        suggestedReply:
          "The startup failure appears to occur during initialization; a minimal reproduction would help isolate the failing path.",
      },
      create: {
        issueId: "issue-1",
        summary: "Application crashes during initialization.",
        category: "Bug",
        priority: "Critical",
        effort: "Medium",
        suggestedReply:
          "The startup failure appears to occur during initialization; a minimal reproduction would help isolate the failing path.",
      },
    });

    expect(prismaMocks.issueAnalysisUpsert).toHaveBeenNthCalledWith(2, {
      where: {
        issueId: "issue-2",
      },
      update: {
        summary: "Installation guide is missing a setup command.",
        category: "Documentation",
        priority: "Low",
        effort: "Small",
        suggestedReply:
          "The installation guide should include the missing setup command in the documented sequence.",
      },
      create: {
        issueId: "issue-2",
        summary: "Installation guide is missing a setup command.",
        category: "Documentation",
        priority: "Low",
        effort: "Small",
        suggestedReply:
          "The installation guide should include the missing setup command in the documented sequence.",
      },
    });

    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.repo).toBe("octo/repo");
    expect(data.analyzedCount).toBe(2);
    expect(data.analyses).toHaveLength(2);
  });

  it("returns a controlled failure when transactional persistence fails", async () => {
    mockImportJob([
      unanalyzedIssue("issue-1"),
      unanalyzedIssue("issue-2"),
    ]);

    fetchMock.mockResolvedValueOnce(
      geminiResponse(
        JSON.stringify({
          issues: [
            validAnalysis("issue-1"),
            validAnalysis("issue-2"),
          ],
        })
      )
    );

    prismaMocks.transaction.mockRejectedValueOnce(
      new Error("transaction failed")
    );

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await POST(analyzeRequest("job-1"));

    expect(response.status).toBe(500);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error:
        "AI analysis failed. This may be a temporary model limit or connection issue.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prismaMocks.issueAnalysisUpsert).toHaveBeenCalledTimes(2);
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("retries malformed JSON and never starts persistence for an invalid batch", async () => {
    vi.useFakeTimers();

    mockImportJob([
      unanalyzedIssue("issue-1", "Broken build", "Build fails."),
    ]);

    fetchMock.mockImplementation(async () =>
      geminiResponse("{ definitely not valid json")
    );

    const consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const responsePromise = POST(analyzeRequest("job-1"));

    await vi.runAllTimersAsync();

    const response = await responsePromise;

    expect(response.status).toBe(500);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error:
        "AI analysis failed. This may be a temporary model limit or connection issue.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(prismaMocks.issueAnalysisUpsert).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "Gemini batch attempt 1 failed"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "Gemini batch attempt 2 failed"
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "Gemini batch attempt 3 failed"
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("rejects a batch containing an invalid enum value before persistence", async () => {
    mockImportJob([unanalyzedIssue("issue-1")]);

    await runRejectedGeminiBatch({
      issues: [
        {
          ...validAnalysis("issue-1"),
          priority: "Urgent",
        },
      ],
    });
  });

  it("rejects a batch containing an issue ID that was not requested", async () => {
    mockImportJob([unanalyzedIssue("issue-1")]);

    await runRejectedGeminiBatch({
      issues: [validAnalysis("different-issue")],
    });
  });

  it("rejects duplicate issue results before persistence", async () => {
    mockImportJob([
      unanalyzedIssue("issue-1"),
      unanalyzedIssue("issue-2"),
    ]);

    await runRejectedGeminiBatch({
      issues: [
        validAnalysis("issue-1"),
        validAnalysis("issue-1"),
      ],
    });
  });

  it("rejects an incomplete batch before persistence", async () => {
    mockImportJob([
      unanalyzedIssue("issue-1"),
      unanalyzedIssue("issue-2"),
    ]);

    await runRejectedGeminiBatch({
      issues: [validAnalysis("issue-1")],
    });
  });

  it("rejects empty required analysis text before persistence", async () => {
    mockImportJob([unanalyzedIssue("issue-1")]);

    await runRejectedGeminiBatch({
      issues: [
        validAnalysis("issue-1", {
          summary: "   ",
        }),
      ],
    });
  });
});