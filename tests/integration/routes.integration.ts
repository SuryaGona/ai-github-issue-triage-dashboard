import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { POST as analyzeIssues } from "../../src/app/api/analyze/route";
import { POST as importIssues } from "../../src/app/api/import/route";
import { prisma } from "../../src/lib/prisma";

type ImportResponse = {
  success: boolean;
  repo?: string;
  issueCount?: number;
  importJobId?: string;
  issues?: Array<{
    id: string;
    number: number;
    title: string;
    url: string;
    state: string;
    author: string;
    createdAt: string;
  }>;
  error?: string;
};

type AnalysisFixture = {
  issueId: string;
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
};

const repositoryUrl = "https://github.com/acme/widget";
const repositoryApiUrl = "https://api.github.com/repos/acme/widget";
const issuesApiUrl =
  "https://api.github.com/repos/acme/widget/issues?state=open&per_page=100";

const repositoryPayload = {
  id: 9001,
  name: "widget",
  full_name: "acme/widget",
  private: false,
  html_url: repositoryUrl,
  owner: {
    login: "acme",
  },
};

const githubIssuesPayload = [
  {
    id: 9101,
    number: 11,
    title: "Crash on startup",
    body: "The application crashes during startup.",
    state: "open",
    user: {
      login: "alice",
    },
    html_url: "https://github.com/acme/widget/issues/11",
    created_at: "2026-08-01T12:00:00.000Z",
  },
  {
    id: 9102,
    number: 12,
    title: "Update dependency",
    body: "This is a pull request and must not be imported.",
    state: "open",
    user: {
      login: "bot",
    },
    html_url: "https://github.com/acme/widget/pull/12",
    created_at: "2026-08-02T12:00:00.000Z",
    pull_request: {
      url: "https://api.github.com/repos/acme/widget/pulls/12",
    },
  },
  {
    id: 9103,
    number: 13,
    title: "Documentation typo",
    body: "There is a typo in the installation guide.",
    state: "open",
    user: {
      login: "bob",
    },
    html_url: "https://github.com/acme/widget/issues/13",
    created_at: "2026-08-03T12:00:00.000Z",
  },
];

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function geminiResponse(results: AnalysisFixture[]) {
  return jsonResponse({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              text: JSON.stringify({
                issues: results,
              }),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  });
}

async function resetDatabase() {
  await prisma.issueAnalysis.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.importJob.deleteMany();
  await prisma.repository.deleteMany();
}

function stubGitHubFetch() {
  const fetchMock = vi.fn(
    async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input);

      if (url === repositoryApiUrl) {
        return jsonResponse(repositoryPayload);
      }

      if (url === issuesApiUrl) {
        return jsonResponse(githubIssuesPayload);
      }

      throw new Error(
        `Unexpected HTTP request during GitHub fixture: ${url}`,
      );
    },
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function stubGeminiFetch(results: AnalysisFixture[]) {
  const fetchMock = vi.fn(
    async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input);

      if (!url.includes("generativelanguage.googleapis.com")) {
        throw new Error(
          `Unexpected HTTP request during Gemini fixture: ${url}`,
        );
      }

      return geminiResponse(results);
    },
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function stubGemini429ThenSuccess(results: AnalysisFixture[]) {
  let attempt = 0;

  const fetchMock = vi.fn(
    async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input);

      if (!url.includes("generativelanguage.googleapis.com")) {
        throw new Error(
          `Unexpected HTTP request during Gemini fixture: ${url}`,
        );
      }

      attempt += 1;

      if (attempt === 1) {
        return jsonResponse(
          {
            error: {
              message: "rate limited",
            },
          },
          429,
          {
            "Retry-After": "0",
          },
        );
      }

      return geminiResponse(results);
    },
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

async function importRepositoryFixture() {
  const response = await importIssues(
    new Request("http://localhost/api/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoUrl: repositoryUrl,
      }),
    }),
  );

  const body = (await response.json()) as ImportResponse;

  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  expect(body.importJobId).toBeTruthy();

  return {
    response,
    body,
  };
}

function buildAnalysisResults(
  issues: Array<{ id: string }>,
): AnalysisFixture[] {
  return [
    {
      issueId: issues[0].id,
      summary: "Startup can fail during application initialization.",
      category: "Bug",
      priority: "High",
      effort: "Medium",
      suggestedReply:
        "The startup path is failing during initialization and needs the failing stage isolated.",
    },
    {
      issueId: issues[1].id,
      summary: "The installation guide contains a documentation typo.",
      category: "Documentation",
      priority: "Low",
      effort: "Small",
      suggestedReply:
        "The typo is isolated to the installation guide and can be corrected directly.",
    },
  ];
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await resetDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe("real PostgreSQL route integration", () => {
  it("imports GitHub issues into PostgreSQL and excludes pull requests", async () => {
    const fetchMock = stubGitHubFetch();

    const { body } = await importRepositoryFixture();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body.repo).toBe("acme/widget");
    expect(body.issueCount).toBe(2);
    expect(body.issues).toHaveLength(2);
    expect(body.issues?.map((issue) => issue.number)).toEqual([13, 11]);

    const repository = await prisma.repository.findUnique({
      where: {
        fullName: "acme/widget",
      },
    });

    expect(repository).not.toBeNull();
    expect(repository?.owner).toBe("acme");
    expect(repository?.name).toBe("widget");
    expect(repository?.githubId).toBe(BigInt(9001));

    const importJob = await prisma.importJob.findUnique({
      where: {
        id: body.importJobId!,
      },
    });

    expect(importJob).not.toBeNull();
    expect(importJob?.status).toBe("completed");
    expect(importJob?.completedAt).not.toBeNull();

    const savedIssues = await prisma.issue.findMany({
      where: {
        repositoryId: repository!.id,
      },
      orderBy: {
        issueNumber: "asc",
      },
    });

    expect(savedIssues).toHaveLength(2);
    expect(savedIssues.map((issue) => issue.issueNumber)).toEqual([11, 13]);
    expect(savedIssues.some((issue) => issue.issueNumber === 12)).toBe(false);
    expect(savedIssues[0].githubIssueId).toBe(BigInt(9101));
    expect(savedIssues[1].githubIssueId).toBe(BigInt(9103));
  });

  it("persists a complete Gemini batch and stays idempotent on repeat analysis", async () => {
    stubGitHubFetch();

    const { body } = await importRepositoryFixture();

    const issues = await prisma.issue.findMany({
      orderBy: {
        issueNumber: "asc",
      },
    });

    expect(issues).toHaveLength(2);

    const analysisResults = buildAnalysisResults(issues);

    const geminiFetch = stubGeminiFetch(analysisResults);

    const response = await analyzeIssues(
      new Request("http://localhost/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          importJobId: body.importJobId,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(geminiFetch).toHaveBeenCalledTimes(1);

    const savedAnalyses = await prisma.issueAnalysis.findMany();

    expect(savedAnalyses).toHaveLength(2);

    for (const expected of analysisResults) {
      const saved = savedAnalyses.find(
        (analysis) => analysis.issueId === expected.issueId,
      );

      expect(saved).toMatchObject({
        issueId: expected.issueId,
        summary: expected.summary,
        category: expected.category,
        priority: expected.priority,
        effort: expected.effort,
        suggestedReply: expected.suggestedReply,
      });
    }

    const completedJob = await prisma.importJob.findUniqueOrThrow({
      where: {
        id: body.importJobId!,
      },
    });

    expect(completedJob.status).toBe("analyzed");
    expect(completedJob.analysisLeaseId).toBeNull();
    expect(completedJob.analysisStartedAt).toBeNull();

    const unexpectedFetch = vi.fn(async (): Promise<Response> => {
      throw new Error(
        "Gemini must not run for an already analyzed job.",
      );
    });

    vi.stubGlobal("fetch", unexpectedFetch);

    const repeatedResponse = await analyzeIssues(
      new Request("http://localhost/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          importJobId: body.importJobId,
        }),
      }),
    );

    expect(repeatedResponse.status).toBe(200);
    expect(unexpectedFetch).not.toHaveBeenCalled();
    expect(await prisma.issueAnalysis.count()).toBe(2);
  });

  it("recovers from a Gemini 429 rate limit and persists after retry", async () => {
    stubGitHubFetch();

    const { body } = await importRepositoryFixture();

    const issues = await prisma.issue.findMany({
      orderBy: {
        issueNumber: "asc",
      },
    });

    expect(issues).toHaveLength(2);

    const analysisResults = buildAnalysisResults(issues);

    const geminiFetch =
      stubGemini429ThenSuccess(analysisResults);

    const response = await analyzeIssues(
      new Request("http://localhost/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          importJobId: body.importJobId,
        }),
      }),
    );

    expect(response.status).toBe(200);

    expect(geminiFetch).toHaveBeenCalledTimes(2);

    expect(
      await prisma.issueAnalysis.count(),
    ).toBe(2);

    const analyzedJob =
      await prisma.importJob.findUniqueOrThrow({
        where: {
          id: body.importJobId!,
        },
      });

    expect(analyzedJob.status).toBe("analyzed");
    expect(analyzedJob.analysisLeaseId).toBeNull();
    expect(analyzedJob.analysisStartedAt).toBeNull();
  });

  it("rolls back persisted analysis when a PostgreSQL transaction fails", async () => {
    const repository = await prisma.repository.create({
      data: {
        owner: "acme",
        name: "rollback-demo",
        fullName: "acme/rollback-demo",
        githubId: BigInt(9201),
      },
    });

    const issue = await prisma.issue.create({
      data: {
        githubIssueId: BigInt(9202),
        issueNumber: 21,
        title: "Transaction rollback fixture",
        body: "Used to prove real PostgreSQL rollback behavior.",
        state: "open",
        author: "alice",
        githubUrl:
          "https://github.com/acme/rollback-demo/issues/21",
        createdAtGithub: new Date("2026-08-04T12:00:00.000Z"),
        repositoryId: repository.id,
      },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.issueAnalysis.create({
          data: {
            issueId: issue.id,
            summary:
              "This row must never survive the transaction.",
            category: "Bug",
            priority: "High",
            effort: "Small",
            suggestedReply:
              "This write should be rolled back.",
          },
        });

        throw new Error("force transaction rollback");
      }),
    ).rejects.toThrow("force transaction rollback");

    expect(await prisma.issueAnalysis.count()).toBe(0);
  });
});