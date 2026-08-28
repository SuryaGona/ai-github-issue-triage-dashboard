import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  importJobFindMany: vi.fn(),
  importJobCreate: vi.fn(),
  importJobUpdate: vi.fn(),
  repositoryUpsert: vi.fn(),
  repositoryDeleteMany: vi.fn(),
  issueUpsert: vi.fn(),
  issueFindMany: vi.fn(),
  issueDeleteMany: vi.fn(),
  issueAnalysisDeleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: {
      findMany: prismaMocks.importJobFindMany,
      create: prismaMocks.importJobCreate,
      update: prismaMocks.importJobUpdate,
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

const fetchMock = vi.fn();

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function makeGitHubIssue(id: number, isPullRequest = false) {
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

function importRequest(repoUrl: string) {
  return new Request("http://localhost/api/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repoUrl }),
  });
}

describe("POST /api/import", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);

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
    vi.unstubAllGlobals();
  });

  it("rejects an invalid GitHub repository URL before calling GitHub or the database", async () => {
    const response = await POST(importRequest("not-a-github-repository"));

    expect(response.status).toBe(400);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Please enter a valid GitHub repository URL.",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMocks.importJobFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.repositoryUpsert).not.toHaveBeenCalled();
  });

  it("returns 404 when GitHub reports that the repository does not exist", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));

    const response = await POST(
      importRequest("https://github.com/octo/missing-repo")
    );

    expect(response.status).toBe(404);

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "GitHub repository could not be found.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prismaMocks.repositoryUpsert).not.toHaveBeenCalled();
    expect(prismaMocks.issueUpsert).not.toHaveBeenCalled();
  });

  it("filters pull requests, limits imports to 10 issues, and persists only real issues", async () => {
    const pullRequestBeforeIssues = makeGitHubIssue(100, true);
    const realIssues = Array.from({ length: 12 }, (_, index) =>
      makeGitHubIssue(2000 + index)
    );
    const pullRequestAfterIssues = makeGitHubIssue(9999, true);

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: 123456,
          name: "repo",
          full_name: "octo/repo",
          owner: {
            login: "octo",
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          pullRequestBeforeIssues,
          ...realIssues,
          pullRequestAfterIssues,
        ])
      );

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

    const response = await POST(
      importRequest("https://github.com/octo/repo")
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/octo/repo"
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/octo/repo/issues?state=open&per_page=100"
    );

    expect(prismaMocks.repositoryUpsert).toHaveBeenCalledWith({
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

    expect(prismaMocks.issueUpsert).toHaveBeenCalledTimes(10);

    const persistedGitHubIssueIds = prismaMocks.issueUpsert.mock.calls.map(
      ([input]) => input.where.githubIssueId
    );

    expect(persistedGitHubIssueIds).toEqual(
      realIssues.slice(0, 10).map((issue) => BigInt(issue.id))
    );

    expect(persistedGitHubIssueIds).not.toContain(
      BigInt(pullRequestBeforeIssues.id)
    );

    expect(persistedGitHubIssueIds).not.toContain(
      BigInt(pullRequestAfterIssues.id)
    );

    expect(prismaMocks.importJobUpdate).toHaveBeenCalledWith({
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
});