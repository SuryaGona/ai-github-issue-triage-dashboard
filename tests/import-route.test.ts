import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const prismaMocks = vi.hoisted(() => ({
  importJobFindMany: vi.fn(),
  importJobCreate: vi.fn(),
  importJobUpdate: vi.fn(),
  importJobDeleteMany: vi.fn(),

  repositoryUpsert: vi.fn(),
  repositoryDeleteMany: vi.fn(),

  issueUpsert: vi.fn(),
  issueFindMany: vi.fn(),
  issueDeleteMany: vi.fn(),

  issueAnalysisDeleteMany: vi.fn(),
}));

const httpMocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  isRetryableHttpStatus: vi.fn(),
  retryDelayMs: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("@/lib/http", () => ({
  fetchWithTimeout: httpMocks.fetchWithTimeout,
  isRetryableHttpStatus: httpMocks.isRetryableHttpStatus,
  retryDelayMs: httpMocks.retryDelayMs,
  wait: httpMocks.wait,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: {
      findMany: prismaMocks.importJobFindMany,
      create: prismaMocks.importJobCreate,
      update: prismaMocks.importJobUpdate,
      deleteMany: prismaMocks.importJobDeleteMany,
    },
    repository: {
      upsert: prismaMocks.repositoryUpsert,
      deleteMany: prismaMocks.repositoryDeleteMany,
    },
    issue: {
      upsert: prismaMocks.issueUpsert,
      findMany: prismaMocks.issueFindMany,
      deleteMany: prismaMocks.issueDeleteMany,
    },
    issueAnalysis: {
      deleteMany: prismaMocks.issueAnalysisDeleteMany,
    },
  },
}));

import { POST } from "@/app/api/import/route";

function jsonResponse(
  data: unknown,
  status = 200,
  headers: HeadersInit = {}
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function makeRepositoryResponse() {
  return {
    id: 123456,
    name: "repo",
    full_name: "octo/repo",
    owner: {
      login: "octo",
    },
  };
}

function makeGitHubIssue(
  id: number,
  isPullRequest = false
) {
  return {
    id,
    number: id,
    title: `Issue ${id}`,
    body: `Body for issue ${id}`,
    state: "open",
    html_url: `https://github.com/octo/repo/issues/${id}`,
    created_at: "2026-08-01T12:00:00.000Z",
    user: {
      login: `user-${id}`,
    },
    ...(isPullRequest
      ? {
          pull_request: {
            url: `https://api.github.com/repos/octo/repo/pulls/${id}`,
          },
        }
      : {}),
  };
}

function importRequest(
  repoUrl: string,
  signal?: AbortSignal
) {
  return new Request("http://localhost/api/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repoUrl,
    }),
    signal,
  });
}

function mockSuccessfulGitHubImport(
  issues: ReturnType<typeof makeGitHubIssue>[] = []
) {
  httpMocks.fetchWithTimeout
    .mockResolvedValueOnce(
      jsonResponse(makeRepositoryResponse())
    )
    .mockResolvedValueOnce(
      jsonResponse(issues)
    );
}

describe("POST /api/import", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    httpMocks.isRetryableHttpStatus.mockImplementation(
      (status: number) =>
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500
    );

    httpMocks.retryDelayMs.mockImplementation(
      (attempt: number, baseDelayMs: number) =>
        baseDelayMs * 2 ** (attempt - 1)
    );

    httpMocks.wait.mockResolvedValue(undefined);

    prismaMocks.importJobFindMany.mockResolvedValue([]);

    prismaMocks.repositoryUpsert.mockResolvedValue({
      id: "repository-1",
      fullName: "octo/repo",
    });

    prismaMocks.importJobCreate.mockResolvedValue({
      id: "import-job-1",
    });

    prismaMocks.importJobUpdate.mockResolvedValue({
      id: "import-job-1",
      status: "completed",
    });

    prismaMocks.issueUpsert.mockResolvedValue({
      id: "saved-issue",
    });

    prismaMocks.issueFindMany.mockResolvedValue([]);

    prismaMocks.importJobDeleteMany.mockResolvedValue({
      count: 0,
    });

    prismaMocks.repositoryDeleteMany.mockResolvedValue({
      count: 0,
    });

    prismaMocks.issueDeleteMany.mockResolvedValue({
      count: 0,
    });

    prismaMocks.issueAnalysisDeleteMany.mockResolvedValue({
      count: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an invalid GitHub repository URL before calling GitHub or the database", async () => {
    const response = await POST(
      importRequest("not-a-github-repository")
    );

    expect(response.status).toBe(400);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Please enter a valid GitHub repository URL.",
    });

    expect(
      httpMocks.fetchWithTimeout
    ).not.toHaveBeenCalled();

    expect(
      prismaMocks.importJobFindMany
    ).not.toHaveBeenCalled();

    expect(
      prismaMocks.repositoryUpsert
    ).not.toHaveBeenCalled();
  });

  it("returns 404 without retrying when GitHub reports that the repository does not exist", async () => {
    httpMocks.fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({}, 404)
    );

    const response = await POST(
      importRequest(
        "https://github.com/octo/missing-repo"
      )
    );

    expect(response.status).toBe(404);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "GitHub repository could not be found.",
    });

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(1);

    expect(httpMocks.wait).not.toHaveBeenCalled();

    expect(
      prismaMocks.repositoryUpsert
    ).not.toHaveBeenCalled();

    expect(
      prismaMocks.issueUpsert
    ).not.toHaveBeenCalled();
  });

  it("uses an 8 second timeout, filters pull requests, limits imports to 10 issues, and persists only real issues", async () => {
    const pullRequestBeforeIssues =
      makeGitHubIssue(100, true);

    const realIssues = Array.from(
      { length: 12 },
      (_, index) => makeGitHubIssue(2000 + index)
    );

    const pullRequestAfterIssues =
      makeGitHubIssue(9999, true);

    mockSuccessfulGitHubImport([
      pullRequestBeforeIssues,
      ...realIssues,
      pullRequestAfterIssues,
    ]);

    prismaMocks.issueFindMany.mockResolvedValue(
      realIssues.slice(0, 10).map((issue, index) => ({
        id: `issue-${index + 1}`,
        issueNumber: issue.number,
        title: issue.title,
        githubUrl: issue.html_url,
        state: issue.state,
        author: issue.user.login,
        createdAtGithub: new Date(issue.created_at),
      }))
    );

    const request = importRequest(
      "https://github.com/octo/repo"
    );

    const response = await POST(request);

    expect(response.status).toBe(200);

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(2);

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/octo/repo",
      {
        signal: request.signal,
      },
      8_000
    );

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/octo/repo/issues?state=open&per_page=100",
      {
        signal: request.signal,
      },
      8_000
    );

    expect(
      prismaMocks.repositoryUpsert
    ).toHaveBeenCalledWith({
      where: {
        fullName: "octo/repo",
      },
      update: {
        owner: "octo",
        name: "repo",
        githubId: BigInt(123456),
      },
      create: {
        owner: "octo",
        name: "repo",
        fullName: "octo/repo",
        githubId: BigInt(123456),
      },
    });

    expect(
      prismaMocks.issueUpsert
    ).toHaveBeenCalledTimes(10);

    const persistedGitHubIssueIds =
      prismaMocks.issueUpsert.mock.calls.map(
        ([input]) => input.where.githubIssueId
      );

    expect(persistedGitHubIssueIds).toEqual(
      realIssues
        .slice(0, 10)
        .map((issue) => BigInt(issue.id))
    );

    expect(persistedGitHubIssueIds).not.toContain(
      BigInt(pullRequestBeforeIssues.id)
    );

    expect(persistedGitHubIssueIds).not.toContain(
      BigInt(pullRequestAfterIssues.id)
    );

    expect(
      prismaMocks.importJobUpdate
    ).toHaveBeenCalledWith({
      where: {
        id: "import-job-1",
      },
      data: {
        status: "completed",
        completedAt: expect.any(Date),
      },
    });

    const data = await response.json();

    expect(data).toMatchObject({
      success: true,
      repo: "octo/repo",
      issueCount: 10,
      importJobId: "import-job-1",
    });

    expect(data.issues).toHaveLength(10);
  });

  it("retries a transient GitHub 500 with exponential backoff", async () => {
    httpMocks.fetchWithTimeout
      .mockResolvedValueOnce(
        new Response("temporary failure", {
          status: 500,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(makeRepositoryResponse())
      )
      .mockResolvedValueOnce(
        jsonResponse([])
      );

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(200);

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(3);

    expect(
      httpMocks.retryDelayMs
    ).toHaveBeenCalledWith(1, 500);

    expect(httpMocks.wait).toHaveBeenCalledWith(500);
  });

  it("honors Retry-After when GitHub returns 429", async () => {
    httpMocks.fetchWithTimeout
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: {
            "retry-after": "2",
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(makeRepositoryResponse())
      )
      .mockResolvedValueOnce(
        jsonResponse([])
      );

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(200);

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(3);

    expect(httpMocks.wait).toHaveBeenCalledTimes(1);

    expect(httpMocks.wait).toHaveBeenCalledWith(2_000);
  });

  it("retries a GitHub 403 rate limit response before succeeding", async () => {
    httpMocks.fetchWithTimeout
      .mockResolvedValueOnce(
        new Response("secondary rate limit", {
          status: 403,
          headers: {
            "retry-after": "1",
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(makeRepositoryResponse())
      )
      .mockResolvedValueOnce(
        jsonResponse([])
      );

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(200);

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(3);

    expect(httpMocks.wait).toHaveBeenCalledTimes(1);

    expect(httpMocks.wait).toHaveBeenCalledWith(1_000);
  });

  it("retries a transient network failure with exponential backoff", async () => {
    httpMocks.fetchWithTimeout
      .mockRejectedValueOnce(
        new Error("network reset")
      )
      .mockResolvedValueOnce(
        jsonResponse(makeRepositoryResponse())
      )
      .mockResolvedValueOnce(
        jsonResponse([])
      );

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(200);

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(3);

    expect(
      httpMocks.retryDelayMs
    ).toHaveBeenCalledWith(1, 500);

    expect(httpMocks.wait).toHaveBeenCalledWith(500);
  });

  it("does not retry a permanent GitHub 400 response", async () => {
    httpMocks.fetchWithTimeout.mockResolvedValueOnce(
      new Response("bad request", {
        status: 400,
      })
    );

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(502);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error:
        "GitHub repository lookup is temporarily unavailable.",
    });

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(1);

    expect(httpMocks.wait).not.toHaveBeenCalled();

    expect(
      prismaMocks.repositoryUpsert
    ).not.toHaveBeenCalled();
  });

  it("returns 429 after an exhausted GitHub API rate limit is retried", async () => {
    httpMocks.fetchWithTimeout.mockImplementation(
      async () =>
        new Response("rate limited", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
          },
        })
    );

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(429);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error:
        "GitHub API rate limit reached. Please try again later.",
    });

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(3);

    expect(httpMocks.wait).toHaveBeenCalledTimes(2);

    expect(
      httpMocks.retryDelayMs
    ).toHaveBeenNthCalledWith(1, 1, 500);

    expect(
      httpMocks.retryDelayMs
    ).toHaveBeenNthCalledWith(2, 2, 500);

    expect(
      prismaMocks.repositoryUpsert
    ).not.toHaveBeenCalled();
  });

  it("protects active analysis leases during both old-session lookup and deletion", async () => {
    prismaMocks.importJobFindMany
      .mockResolvedValueOnce([
        {
          id: "old-import-job",
          repositoryId: "old-repository",
        },
      ])
      .mockResolvedValueOnce([
        {
          repositoryId: "old-repository",
        },
      ]);

    mockSuccessfulGitHubImport([]);

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(200);

    expect(
      prismaMocks.importJobFindMany
    ).toHaveBeenNthCalledWith(1, {
      where: {
        startedAt: {
          lt: expect.any(Date),
        },
        OR: [
          {
            status: {
              not: "analyzing",
            },
          },
          {
            status: "analyzing",
            analysisStartedAt: null,
          },
          {
            status: "analyzing",
            analysisStartedAt: {
              lt: expect.any(Date),
            },
          },
        ],
      },
      select: {
        id: true,
        repositoryId: true,
      },
    });

    expect(
      prismaMocks.importJobDeleteMany
    ).toHaveBeenCalledWith({
      where: {
        id: {
          in: ["old-import-job"],
        },
        OR: [
          {
            status: {
              not: "analyzing",
            },
          },
          {
            status: "analyzing",
            analysisStartedAt: null,
          },
          {
            status: "analyzing",
            analysisStartedAt: {
              lt: expect.any(Date),
            },
          },
        ],
      },
    });

    expect(
      prismaMocks.importJobFindMany
    ).toHaveBeenNthCalledWith(2, {
      where: {
        repositoryId: {
          in: ["old-repository"],
        },
      },
      select: {
        repositoryId: true,
      },
    });

    expect(
      prismaMocks.repositoryDeleteMany
    ).not.toHaveBeenCalled();
  });

  it("does not retry GitHub when the incoming request has already been aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    httpMocks.fetchWithTimeout.mockRejectedValueOnce(
      new DOMException(
        "The operation was aborted.",
        "AbortError"
      )
    );

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await POST(
      importRequest(
        "https://github.com/octo/repo",
        controller.signal
      )
    );

    expect(response.status).toBe(500);

    expect(
      httpMocks.fetchWithTimeout
    ).toHaveBeenCalledTimes(1);

    expect(httpMocks.wait).not.toHaveBeenCalled();

    expect(
      prismaMocks.repositoryUpsert
    ).not.toHaveBeenCalled();

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("does not blindly retry an ambiguous database write failure", async () => {
    mockSuccessfulGitHubImport([]);

    prismaMocks.repositoryUpsert.mockRejectedValueOnce(
      new Error("database write failed")
    );

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(500);

    expect(
      prismaMocks.repositoryUpsert
    ).toHaveBeenCalledTimes(1);

    expect(
      prismaMocks.importJobCreate
    ).not.toHaveBeenCalled();

    expect(
      prismaMocks.issueUpsert
    ).not.toHaveBeenCalled();

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});