import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  importJobFindUnique: vi.fn(),
  issueAnalysisUpsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: {
      findUnique: prismaMocks.importJobFindUnique,
    },
    issueAnalysis: {
      upsert: prismaMocks.issueAnalysisUpsert,
    },
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
  });

  it("skips Gemini when all imported issues already have analyses", async () => {
    prismaMocks.importJobFindUnique.mockResolvedValue({
      id: "job-1",
      repository: {
        fullName: "octo/repo",
        issues: [
          {
            id: "issue-1",
            title: "Existing analysis",
            body: "Already analyzed",
            analysis: {
              id: "analysis-1",
            },
          },
        ],
      },
    });

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
  });

  it("batches unanalyzed issues through Gemini, parses the JSON result, and persists each analysis", async () => {
    prismaMocks.importJobFindUnique.mockResolvedValue({
      id: "job-1",
      repository: {
        fullName: "octo/repo",
        issues: [
          {
            id: "issue-1",
            title: "Build crashes on startup",
            body: "The application exits during initialization.",
            analysis: null,
          },
          {
            id: "issue-2",
            title: "Improve installation docs",
            body: "The setup guide is missing a required command.",
            analysis: null,
          },
          {
            id: "issue-3",
            title: "Already analyzed issue",
            body: "This issue must not be sent back to Gemini.",
            analysis: {
              id: "analysis-existing",
            },
          },
        ],
      },
    });

    fetchMock.mockResolvedValueOnce(
      geminiResponse(
        JSON.stringify({
          issues: [
            {
              issueId: "issue-1",
              summary: "Application crashes during initialization.",
              category: "Bug",
              priority: "Critical",
              effort: "Medium",
              suggestedReply:
                "The startup failure appears to occur during initialization; a minimal reproduction would help isolate the failing path.",
            },
            {
              issueId: "issue-2",
              summary: "Installation guide is missing a setup command.",
              category: "Documentation",
              priority: "Low",
              effort: "Small",
              suggestedReply:
                "The installation guide should include the missing setup command in the documented sequence.",
            },
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

    expect(requestBody.generationConfig).toEqual({
      responseMimeType: "application/json",
    });

    const prompt = requestBody.contents[0].parts[0].text as string;

    expect(prompt).toContain('"id": "issue-1"');
    expect(prompt).toContain('"id": "issue-2"');
    expect(prompt).not.toContain('"id": "issue-3"');

    expect(prismaMocks.issueAnalysisUpsert).toHaveBeenCalledTimes(2);

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

  it("retries malformed Gemini JSON and returns a controlled error without persisting partial analysis", async () => {
    vi.useFakeTimers();

    prismaMocks.importJobFindUnique.mockResolvedValue({
      id: "job-1",
      repository: {
        fullName: "octo/repo",
        issues: [
          {
            id: "issue-1",
            title: "Broken build",
            body: "Build fails.",
            analysis: null,
          },
        ],
      },
    });

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
});