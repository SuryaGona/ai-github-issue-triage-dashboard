import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const prismaMocks = vi.hoisted(() => ({
  transaction: vi.fn(),

  importJobFindMany: vi.fn(),
  importJobFindFirst: vi.fn(),
  importJobCreate: vi.fn(),
  importJobUpdate: vi.fn(),
  importJobDeleteMany: vi.fn(),

  repositoryFindUnique: vi.fn(),
  repositoryUpsert: vi.fn(),
  repositoryDeleteMany: vi.fn(),

  issueCreateMany: vi.fn(),
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
  fetchWithTimeout:
    httpMocks.fetchWithTimeout,
  isRetryableHttpStatus:
    httpMocks.isRetryableHttpStatus,
  retryDelayMs:
    httpMocks.retryDelayMs,
  wait: httpMocks.wait,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction:
      prismaMocks.transaction,

    importJob: {
      findMany:
        prismaMocks.importJobFindMany,
      findFirst:
        prismaMocks.importJobFindFirst,
      create:
        prismaMocks.importJobCreate,
      update:
        prismaMocks.importJobUpdate,
      deleteMany:
        prismaMocks.importJobDeleteMany,
    },

    repository: {
      findUnique:
        prismaMocks.repositoryFindUnique,
      upsert:
        prismaMocks.repositoryUpsert,
      deleteMany:
        prismaMocks.repositoryDeleteMany,
    },

    issue: {
      createMany:
        prismaMocks.issueCreateMany,
      findMany:
        prismaMocks.issueFindMany,
      deleteMany:
        prismaMocks.issueDeleteMany,
    },

    issueAnalysis: {
      deleteMany:
        prismaMocks.issueAnalysisDeleteMany,
    },
  },
}));

import { POST } from "@/app/api/import/route";

type TransactionClientMock = {
  importJob: {
    findFirst:
      typeof prismaMocks.importJobFindFirst;
    create:
      typeof prismaMocks.importJobCreate;
    update:
      typeof prismaMocks.importJobUpdate;
    deleteMany:
      typeof prismaMocks.importJobDeleteMany;
  };
  repository: {
    findUnique:
      typeof prismaMocks.repositoryFindUnique;
    upsert:
      typeof prismaMocks.repositoryUpsert;
  };
  issue: {
    createMany:
      typeof prismaMocks.issueCreateMany;
    findMany:
      typeof prismaMocks.issueFindMany;
    deleteMany:
      typeof prismaMocks.issueDeleteMany;
  };
  issueAnalysis: {
    deleteMany:
      typeof prismaMocks.issueAnalysisDeleteMany;
  };
};

const expectedGitHubHeaders = {
  Accept:
    "application/vnd.github+json",
  "X-GitHub-Api-Version":
    "2026-03-10",
  "User-Agent":
    "ai-issue-triage-dashboard",
};

function transactionClient():
  TransactionClientMock {
  return {
    importJob: {
      findFirst:
        prismaMocks.importJobFindFirst,
      create:
        prismaMocks.importJobCreate,
      update:
        prismaMocks.importJobUpdate,
      deleteMany:
        prismaMocks.importJobDeleteMany,
    },
    repository: {
      findUnique:
        prismaMocks.repositoryFindUnique,
      upsert:
        prismaMocks.repositoryUpsert,
    },
    issue: {
      createMany:
        prismaMocks.issueCreateMany,
      findMany:
        prismaMocks.issueFindMany,
      deleteMany:
        prismaMocks.issueDeleteMany,
    },
    issueAnalysis: {
      deleteMany:
        prismaMocks.issueAnalysisDeleteMany,
    },
  };
}

function jsonResponse(
  data: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json",
        ...headers,
      },
    },
  );
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
  isPullRequest = false,
) {
  return {
    id,
    number: id,
    title: `Issue ${id}`,
    body: `Body for issue ${id}`,
    state: "open",
    html_url:
      `https://github.com/octo/repo/issues/${id}`,
    created_at:
      "2026-08-01T12:00:00.000Z",
    user: {
      login: `user-${id}`,
    },
    ...(isPullRequest
      ? {
          pull_request: {
            url:
              `https://api.github.com/repos/octo/repo/pulls/${id}`,
          },
        }
      : {}),
  };
}

function savedIssue(
  issue: ReturnType<
    typeof makeGitHubIssue
  >,
  id = `saved-${issue.id}`,
) {
  return {
    id,
    issueNumber: issue.number,
    title: issue.title,
    githubUrl: issue.html_url,
    state: issue.state,
    author: issue.user.login,
    createdAtGithub:
      new Date(issue.created_at),
  };
}

function importRequest(
  repoUrl: string,
  signal?: AbortSignal,
) {
  return new Request(
    "http://localhost/api/import",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        repoUrl,
      }),
      signal,
    },
  );
}

function mockSuccessfulGitHubImport(
  issues:
    ReturnType<
      typeof makeGitHubIssue
    >[] = [],
) {
  httpMocks.fetchWithTimeout
    .mockResolvedValueOnce(
      jsonResponse(
        makeRepositoryResponse(),
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse(issues),
    );
}

describe(
  "POST /api/import",
  () => {
    beforeEach(() => {
      vi.resetAllMocks();

      httpMocks.isRetryableHttpStatus.mockImplementation(
        (status: number) =>
          status === 408 ||
          status === 425 ||
          status === 429 ||
          status >= 500,
      );

      httpMocks.retryDelayMs.mockImplementation(
        (
          attempt: number,
          baseDelayMs: number,
        ) =>
          baseDelayMs *
          2 ** (attempt - 1),
      );

      httpMocks.wait.mockResolvedValue(
        undefined,
      );

      prismaMocks.importJobFindMany.mockResolvedValue(
        [],
      );

      prismaMocks.importJobFindFirst.mockResolvedValue(
        null,
      );

      prismaMocks.repositoryFindUnique.mockResolvedValue(
        null,
      );

      prismaMocks.repositoryUpsert.mockResolvedValue(
        {
          id: "repository-1",
          fullName: "octo/repo",
        },
      );

      prismaMocks.importJobCreate.mockResolvedValue(
        {
          id: "import-job-1",
        },
      );

      prismaMocks.importJobUpdate.mockResolvedValue(
        {
          id: "import-job-1",
          status: "completed",
        },
      );

      prismaMocks.issueCreateMany.mockResolvedValue(
        {
          count: 0,
        },
      );

      prismaMocks.issueFindMany.mockResolvedValue(
        [],
      );

      prismaMocks.importJobDeleteMany.mockResolvedValue(
        {
          count: 0,
        },
      );

      prismaMocks.repositoryDeleteMany.mockResolvedValue(
        {
          count: 0,
        },
      );

      prismaMocks.issueDeleteMany.mockResolvedValue(
        {
          count: 0,
        },
      );

      prismaMocks.issueAnalysisDeleteMany.mockResolvedValue(
        {
          count: 0,
        },
      );

      prismaMocks.transaction.mockImplementation(
        async (
          callback: (
            tx: TransactionClientMock,
          ) => Promise<unknown>,
        ) =>
          callback(
            transactionClient(),
          ),
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });

    it(
      "rejects an invalid GitHub repository URL before calling GitHub or the database",
      async () => {
        const response = await POST(
          importRequest(
            "not-a-github-repository",
          ),
        );

        expect(
          response.status,
        ).toBe(400);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "Please enter a valid GitHub repository URL.",
        });

        expect(
          httpMocks.fetchWithTimeout,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "rejects GitHub repository URLs containing query strings before calling GitHub or the database",
      async () => {
        const response = await POST(
          importRequest(
            "https://github.com/octo/repo?tab=issues",
          ),
        );

        expect(
          response.status,
        ).toBe(400);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "Please enter a valid GitHub repository URL.",
        });

        expect(
          httpMocks.fetchWithTimeout,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "returns 404 without retrying when GitHub reports that the repository does not exist",
      async () => {
        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          jsonResponse({}, 404),
        );

        const response = await POST(
          importRequest(
            "https://github.com/octo/missing-repo",
          ),
        );

        expect(
          response.status,
        ).toBe(404);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "GitHub repository could not be found.",
        });

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          httpMocks.wait,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "rejects malformed GitHub repository data without writing to the database",
      async () => {
        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          jsonResponse({
            id: "not-a-number",
            name: "repo",
            full_name: "octo/repo",
            owner: {
              login: "octo",
            },
          }),
        );

        const consoleErrorSpy =
          vi.spyOn(
            console,
            "error",
          ).mockImplementation(
            () => undefined,
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(502);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "GitHub repository data is temporarily unavailable.",
        });

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "rejects malformed GitHub issue data without persisting a partial import",
      async () => {
        httpMocks.fetchWithTimeout
          .mockResolvedValueOnce(
            jsonResponse(
              makeRepositoryResponse(),
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse([
              {
                ...makeGitHubIssue(
                  7000,
                ),
                created_at:
                  "not-a-date",
              },
            ]),
          );

        const consoleErrorSpy =
          vi.spyOn(
            console,
            "error",
          ).mockImplementation(
            () => undefined,
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(502);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "GitHub issues are temporarily unavailable.",
        });

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.issueCreateMany,
        ).not.toHaveBeenCalled();

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "paginates GitHub issues, filters pull requests, deduplicates issues, and imports up to the safe limit",
      async () => {
        const pageOneRealIssues =
          Array.from(
            {
              length: 98,
            },
            (_, index) =>
              makeGitHubIssue(
                2000 + index,
              ),
          );

        const pageOne = [
          makeGitHubIssue(
            100,
            true,
          ),
          ...pageOneRealIssues,
          makeGitHubIssue(
            101,
            true,
          ),
        ];

        const duplicateIssue =
          pageOneRealIssues[0];

        const pageTwoRealIssues = [
          makeGitHubIssue(3000),
          makeGitHubIssue(3001),
          makeGitHubIssue(3002),
        ];

        const pageTwo = [
          duplicateIssue,
          ...pageTwoRealIssues,
          makeGitHubIssue(
            9999,
            true,
          ),
        ];

        httpMocks.fetchWithTimeout
          .mockResolvedValueOnce(
            jsonResponse(
              makeRepositoryResponse(),
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse(pageOne),
          )
          .mockResolvedValueOnce(
            jsonResponse(pageTwo),
          );

        const expectedImportedIssues = [
          ...pageOneRealIssues,
          pageTwoRealIssues[0],
          pageTwoRealIssues[1],
        ];

        prismaMocks.issueFindMany.mockResolvedValue(
          expectedImportedIssues.map(
            (issue, index) =>
              savedIssue(
                issue,
                `issue-${index + 1}`,
              ),
          ),
        );

        const request =
          importRequest(
            "https://github.com/octo/repo",
          );

        const response =
          await POST(request);

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenNthCalledWith(
          1,
          "https://api.github.com/repos/octo/repo",
          {
            headers:
              expectedGitHubHeaders,
            signal:
              request.signal,
          },
          8_000,
        );

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenNthCalledWith(
          2,
          "https://api.github.com/repos/octo/repo/issues?state=open&per_page=100&page=1",
          {
            headers:
              expectedGitHubHeaders,
            signal:
              request.signal,
          },
          8_000,
        );

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenNthCalledWith(
          3,
          "https://api.github.com/repos/octo/repo/issues?state=open&per_page=100&page=2",
          {
            headers:
              expectedGitHubHeaders,
            signal:
              request.signal,
          },
          8_000,
        );

        expect(
          prismaMocks.repositoryUpsert,
        ).toHaveBeenCalledWith({
          where: {
            githubId:
              BigInt(123456),
          },
          update: {
            owner: "octo",
            name: "repo",
            fullName:
              "octo/repo",
          },
          create: {
            owner: "octo",
            name: "repo",
            fullName:
              "octo/repo",
            githubId:
              BigInt(123456),
          },
        });

        expect(
          prismaMocks.issueCreateMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        const createManyInput =
          prismaMocks
            .issueCreateMany
            .mock.calls[0][0];

        expect(
          createManyInput.data,
        ).toHaveLength(100);

        const persistedIds =
          createManyInput.data.map(
            (issue: {
              githubIssueId: bigint;
            }) =>
              issue.githubIssueId,
          );

        expect(
          persistedIds,
        ).toEqual(
          expectedImportedIssues.map(
            (issue) =>
              BigInt(issue.id),
          ),
        );

        expect(
          persistedIds,
        ).not.toContain(
          BigInt(100),
        );

        expect(
          persistedIds,
        ).not.toContain(
          BigInt(101),
        );

        expect(
          persistedIds,
        ).not.toContain(
          BigInt(9999),
        );

        expect(
          persistedIds.filter(
            (id: bigint) =>
              id ===
              BigInt(
                duplicateIssue.id,
              ),
          ),
        ).toHaveLength(1);

        expect(
          prismaMocks.issueFindMany,
        ).toHaveBeenCalledWith({
          where: {
            repositoryId:
              "repository-1",
            githubIssueId: {
              in:
                expectedImportedIssues.map(
                  (issue) =>
                    BigInt(
                      issue.id,
                    ),
                ),
            },
          },
          orderBy: [
            {
              createdAtGithub:
                "desc",
            },
            {
              issueNumber:
                "desc",
            },
          ],
        });

        const data =
          await response.json();

        expect(data).toMatchObject({
          success: true,
          repo: "octo/repo",
          issueCount: 100,
          importJobId:
            "import-job-1",
        });

        expect(
          data.issues,
        ).toHaveLength(100);
      },
    );

    it(
      "does not persist a partial import when a later GitHub issues page exhausts rate-limit retries",
      async () => {
        const firstPage = [
          ...Array.from(
            {
              length: 99,
            },
            (_, index) =>
              makeGitHubIssue(
                4000 + index,
              ),
          ),
          makeGitHubIssue(
            4999,
            true,
          ),
        ];

        httpMocks.fetchWithTimeout
          .mockResolvedValueOnce(
            jsonResponse(
              makeRepositoryResponse(),
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse(firstPage),
          )
          .mockResolvedValueOnce(
            new Response(
              "rate limited",
              {
                status: 429,
              },
            ),
          )
          .mockResolvedValueOnce(
            new Response(
              "rate limited",
              {
                status: 429,
              },
            ),
          )
          .mockResolvedValueOnce(
            new Response(
              "rate limited",
              {
                status: 429,
              },
            ),
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(429);

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "retries a transient GitHub 500 with exponential backoff",
      async () => {
        httpMocks.fetchWithTimeout
          .mockResolvedValueOnce(
            new Response(
              "temporary failure",
              {
                status: 500,
              },
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse(
              makeRepositoryResponse(),
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse([]),
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.retryDelayMs,
        ).toHaveBeenCalledWith(
          1,
          500,
        );

        expect(
          httpMocks.wait,
        ).toHaveBeenCalledWith(
          500,
        );
      },
    );

    it(
      "honors Retry-After when GitHub returns 429",
      async () => {
        httpMocks.fetchWithTimeout
          .mockResolvedValueOnce(
            new Response(
              "rate limited",
              {
                status: 429,
                headers: {
                  "retry-after":
                    "2",
                },
              },
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse(
              makeRepositoryResponse(),
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse([]),
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.wait,
        ).toHaveBeenCalledWith(
          2_000,
        );
      },
    );

    it(
      "retries a GitHub 403 rate limit response before succeeding",
      async () => {
        httpMocks.fetchWithTimeout
          .mockResolvedValueOnce(
            new Response(
              "secondary rate limit",
              {
                status: 403,
                headers: {
                  "retry-after":
                    "1",
                },
              },
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse(
              makeRepositoryResponse(),
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse([]),
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.wait,
        ).toHaveBeenCalledWith(
          1_000,
        );
      },
    );

    it(
      "retries a transient network failure with exponential backoff",
      async () => {
        httpMocks.fetchWithTimeout
          .mockRejectedValueOnce(
            new Error(
              "network reset",
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse(
              makeRepositoryResponse(),
            ),
          )
          .mockResolvedValueOnce(
            jsonResponse([]),
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.retryDelayMs,
        ).toHaveBeenCalledWith(
          1,
          500,
        );
      },
    );

    it(
      "does not retry a permanent GitHub 400 response",
      async () => {
        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          new Response(
            "bad request",
            {
              status: 400,
            },
          ),
        );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(502);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          httpMocks.wait,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "returns 429 after an exhausted GitHub API rate limit is retried",
      async () => {
        httpMocks.fetchWithTimeout.mockImplementation(
          async () =>
            new Response(
              "rate limited",
              {
                status: 403,
                headers: {
                  "x-ratelimit-remaining":
                    "0",
                },
              },
            ),
        );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(429);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "protects active analysis leases during old-session cleanup",
      async () => {
        prismaMocks.importJobFindMany
          .mockResolvedValueOnce([
            {
              id:
                "old-import-job",
              repositoryId:
                "old-repository",
            },
          ])
          .mockResolvedValueOnce([
            {
              repositoryId:
                "old-repository",
            },
          ]);

        mockSuccessfulGitHubImport(
          [],
        );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(200);

        expect(
          prismaMocks.importJobFindMany,
        ).toHaveBeenNthCalledWith(
          1,
          {
            where: {
              startedAt: {
                lt: expect.any(
                  Date,
                ),
              },
              OR: [
                {
                  status: {
                    not:
                      "analyzing",
                  },
                },
                {
                  status:
                    "analyzing",
                  analysisStartedAt:
                    null,
                },
                {
                  status:
                    "analyzing",
                  analysisStartedAt:
                    {
                      lt:
                        expect.any(
                          Date,
                        ),
                    },
                },
              ],
            },
            select: {
              id: true,
              repositoryId:
                true,
            },
          },
        );

        expect(
          prismaMocks.repositoryDeleteMany,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "atomically replaces an existing repository snapshot before creating the new import",
      async () => {
        const incomingIssue =
          makeGitHubIssue(7001);

        prismaMocks.repositoryFindUnique.mockResolvedValue(
          {
            id: "repository-1",
          },
        );

        prismaMocks.issueFindMany.mockResolvedValue(
          [
            savedIssue(
              incomingIssue,
              "new-issue",
            ),
          ],
        );

        mockSuccessfulGitHubImport(
          [incomingIssue],
        );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(200);

        expect(
          prismaMocks.importJobFindFirst,
        ).toHaveBeenCalledWith({
          where: {
            repositoryId:
              "repository-1",
            status: "analyzing",
            analysisStartedAt: {
              gte:
                expect.any(Date),
            },
          },
          select: {
            id: true,
          },
        });

        expect(
          prismaMocks.issueAnalysisDeleteMany,
        ).toHaveBeenCalledWith({
          where: {
            issue: {
              is: {
                repositoryId:
                  "repository-1",
              },
            },
          },
        });

        expect(
          prismaMocks.issueDeleteMany,
        ).toHaveBeenCalledWith({
          where: {
            repositoryId:
              "repository-1",
          },
        });

        expect(
          prismaMocks.importJobDeleteMany,
        ).toHaveBeenCalledWith({
          where: {
            repositoryId:
              "repository-1",
          },
        });

        expect(
          prismaMocks.issueCreateMany,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    it(
      "rejects replacement while the same repository has a live analysis lease",
      async () => {
        prismaMocks.repositoryFindUnique.mockResolvedValue(
          {
            id: "repository-1",
          },
        );

        prismaMocks.importJobFindFirst.mockResolvedValue(
          {
            id: "active-job",
          },
        );

        mockSuccessfulGitHubImport(
          [],
        );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(409);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "This repository is currently being analyzed. Wait for that analysis to finish before importing it again.",
        });

        expect(
          prismaMocks.repositoryUpsert,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.issueDeleteMany,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "does not retry GitHub when the incoming request has already been aborted",
      async () => {
        const controller =
          new AbortController();

        controller.abort();

        httpMocks.fetchWithTimeout.mockRejectedValueOnce(
          new DOMException(
            "The operation was aborted.",
            "AbortError",
          ),
        );

        const consoleErrorSpy =
          vi.spyOn(
            console,
            "error",
          ).mockImplementation(
            () => undefined,
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
            controller.signal,
          ),
        );

        expect(
          response.status,
        ).toBe(500);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          httpMocks.wait,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "does not blindly retry an ambiguous database transaction failure",
      async () => {
        mockSuccessfulGitHubImport(
          [],
        );

        prismaMocks.repositoryUpsert.mockRejectedValueOnce(
          new Error(
            "database write failed",
          ),
        );

        const consoleErrorSpy =
          vi.spyOn(
            console,
            "error",
          ).mockImplementation(
            () => undefined,
          );

        const response = await POST(
          importRequest(
            "https://github.com/octo/repo",
          ),
        );

        expect(
          response.status,
        ).toBe(500);

        expect(
          prismaMocks.transaction,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.repositoryUpsert,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.importJobCreate,
        ).not.toHaveBeenCalled();

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );
  },
);