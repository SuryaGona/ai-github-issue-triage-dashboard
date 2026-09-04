import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  POST as analyzeIssues,
} from "../../src/app/api/analyze/route";
import {
  POST as importIssues,
} from "../../src/app/api/import/route";
import {
  analysisCache,
  createAnalysisCacheKey,
} from "../../src/lib/analysis-cache";
import { prisma } from "../../src/lib/prisma";

type ImportResponse = {
  success: boolean;
  repository?: {
    owner: string;
    name: string;
    fullName: string;
  };
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
  priority:
    | "Critical"
    | "High"
    | "Medium"
    | "Low";
  effort:
    | "Small"
    | "Medium"
    | "Large";
  suggestedReply: string;
};

const repositoryUrl =
  "https://github.com/acme/widget";

const repositoryApiUrl =
  "https://api.github.com/repos/acme/widget";

const issuesPageUrl = (
  page: number,
) =>
  `https://api.github.com/repos/acme/widget/issues?state=open&per_page=100&page=${page}`;

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

function makeGitHubIssue(
  id: number,
  number: number,
  isPullRequest = false,
) {
  return {
    id,
    number,
    title: `Issue ${number}`,
    body: `Body for issue ${number}`,
    state: "open",
    user: {
      login:
        `user-${number}`,
    },
    html_url: isPullRequest
      ? `https://github.com/acme/widget/pull/${number}`
      : `https://github.com/acme/widget/issues/${number}`,
    created_at:
      "2026-08-01T12:00:00.000Z",
    ...(isPullRequest
      ? {
          pull_request: {
            url:
              `https://api.github.com/repos/acme/widget/pulls/${number}`,
          },
        }
      : {}),
  };
}

const githubIssuesPayload = [
  {
    id: 9101,
    number: 11,
    title: "Crash on startup",
    body:
      "The application crashes during startup.",
    state: "open",
    user: {
      login: "alice",
    },
    html_url:
      "https://github.com/acme/widget/issues/11",
    created_at:
      "2026-08-01T12:00:00.000Z",
  },
  {
    id: 9102,
    number: 12,
    title: "Update dependency",
    body:
      "This is a pull request and must not be imported.",
    state: "open",
    user: {
      login: "bot",
    },
    html_url:
      "https://github.com/acme/widget/pull/12",
    created_at:
      "2026-08-02T12:00:00.000Z",
    pull_request: {
      url:
        "https://api.github.com/repos/acme/widget/pulls/12",
    },
  },
  {
    id: 9103,
    number: 13,
    title: "Documentation typo",
    body:
      "There is a typo in the installation guide.",
    state: "open",
    user: {
      login: "bob",
    },
    html_url:
      "https://github.com/acme/widget/issues/13",
    created_at:
      "2026-08-03T12:00:00.000Z",
  },
];

function requestUrl(
  input:
    | string
    | URL
    | Request,
) {
  if (
    typeof input === "string"
  ) {
    return input;
  }

  if (
    input instanceof URL
  ) {
    return input.toString();
  }

  return input.url;
}

function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<
    string,
    string
  > = {},
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

function geminiResponse(
  results:
    AnalysisFixture[],
) {
  return jsonResponse({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              text:
                JSON.stringify({
                  issues:
                    results,
                }),
            },
          ],
        },
        finishReason:
          "STOP",
      },
    ],
  });
}

function analysisForIssueId(
  issueId: string,
): AnalysisFixture {
  return {
    issueId,
    summary:
      `Summary for ${issueId}`,
    category: "Bug",
    priority: "High",
    effort: "Medium",
    suggestedReply:
      `Reply for ${issueId}`,
  };
}

function geminiRequestedIssueIds(
  init?: RequestInit,
) {
  const body = JSON.parse(
    String(init?.body ?? "{}"),
  );

  return body
    .generationConfig
    .responseJsonSchema
    .properties
    .issues
    .items
    .properties
    .issueId
    .enum as string[];
}

async function resetDatabase() {
  await prisma.issueAnalysis.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.importJob.deleteMany();
  await prisma.repository.deleteMany();
}

function stubGitHubFetch() {
  const fetchMock = vi.fn(
    async (
      input:
        | string
        | URL
        | Request,
    ): Promise<Response> => {
      const url =
        requestUrl(input);

      if (
        url === repositoryApiUrl
      ) {
        return jsonResponse(
          repositoryPayload,
        );
      }

      if (
        url === issuesPageUrl(1)
      ) {
        return jsonResponse(
          githubIssuesPayload,
        );
      }

      throw new Error(
        `Unexpected HTTP request during GitHub fixture: ${url}`,
      );
    },
  );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return fetchMock;
}

function stubGitHubPages(
  pages: Map<
    number,
    unknown[]
  >,
) {
  const fetchMock = vi.fn(
    async (
      input:
        | string
        | URL
        | Request,
    ): Promise<Response> => {
      const url =
        requestUrl(input);

      if (
        url === repositoryApiUrl
      ) {
        return jsonResponse(
          repositoryPayload,
        );
      }

      for (
        const [
          page,
          payload,
        ] of pages.entries()
      ) {
        if (
          url ===
          issuesPageUrl(page)
        ) {
          return jsonResponse(
            payload,
          );
        }
      }

      throw new Error(
        `Unexpected HTTP request during GitHub pagination fixture: ${url}`,
      );
    },
  );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return fetchMock;
}

function stubGeminiFetch(
  results:
    AnalysisFixture[],
) {
  const fetchMock = vi.fn(
    async (
      input:
        | string
        | URL
        | Request,
    ): Promise<Response> => {
      const url =
        requestUrl(input);

      if (
        !url.includes(
          "generativelanguage.googleapis.com",
        )
      ) {
        throw new Error(
          `Unexpected HTTP request during Gemini fixture: ${url}`,
        );
      }

      return geminiResponse(
        results,
      );
    },
  );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return fetchMock;
}

function stubGeminiByRequestedBatch() {
  const requestedBatches:
    string[][] = [];

  const fetchMock = vi.fn(
    async (
      input:
        | string
        | URL
        | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        requestUrl(input);

      if (
        !url.includes(
          "generativelanguage.googleapis.com",
        )
      ) {
        throw new Error(
          `Unexpected HTTP request during Gemini batching fixture: ${url}`,
        );
      }

      const issueIds =
        geminiRequestedIssueIds(
          init,
        );

      requestedBatches.push(
        issueIds,
      );

      return geminiResponse(
        issueIds.map(
          analysisForIssueId,
        ),
      );
    },
  );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return {
    fetchMock,
    requestedBatches,
  };
}

function stubGeminiLaterBatchFailure() {
  const successfulBatchIds:
    string[] = [];

  let requestNumber = 0;

  const fetchMock = vi.fn(
    async (
      input:
        | string
        | URL
        | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        requestUrl(input);

      if (
        !url.includes(
          "generativelanguage.googleapis.com",
        )
      ) {
        throw new Error(
          `Unexpected HTTP request during Gemini failure fixture: ${url}`,
        );
      }

      requestNumber += 1;

      const issueIds =
        geminiRequestedIssueIds(
          init,
        );

      if (
        requestNumber === 1
      ) {
        successfulBatchIds.push(
          ...issueIds,
        );

        return geminiResponse(
          issueIds.map(
            analysisForIssueId,
          ),
        );
      }

      return jsonResponse(
        {
          error: {
            message:
              "temporary Gemini failure",
          },
        },
        500,
        {
          "Retry-After": "0",
        },
      );
    },
  );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return {
    fetchMock,
    successfulBatchIds,
  };
}

function stubGemini429ThenSuccess(
  results:
    AnalysisFixture[],
) {
  let attempt = 0;

  const fetchMock = vi.fn(
    async (
      input:
        | string
        | URL
        | Request,
    ): Promise<Response> => {
      const url =
        requestUrl(input);

      if (
        !url.includes(
          "generativelanguage.googleapis.com",
        )
      ) {
        throw new Error(
          `Unexpected HTTP request during Gemini fixture: ${url}`,
        );
      }

      attempt += 1;

      if (attempt === 1) {
        return jsonResponse(
          {
            error: {
              message:
                "rate limited",
            },
          },
          429,
          {
            "Retry-After": "0",
          },
        );
      }

      return geminiResponse(
        results,
      );
    },
  );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return fetchMock;
}

async function importRepositoryFixture() {
  const response =
    await importIssues(
      new Request(
        "http://localhost/api/import",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            repoUrl:
              repositoryUrl,
          }),
        },
      ),
    );

  const body =
    (await response.json()) as
      ImportResponse;

  expect(
    response.status,
  ).toBe(200);

  expect(
    body.success,
  ).toBe(true);

  expect(
    body.importJobId,
  ).toBeTruthy();

  return {
    response,
    body,
  };
}

function buildAnalysisResults(
  issues: Array<{
    id: string;
  }>,
): AnalysisFixture[] {
  return [
    {
      issueId:
        issues[0].id,
      summary:
        "Startup can fail during application initialization.",
      category: "Bug",
      priority: "High",
      effort: "Medium",
      suggestedReply:
        "The startup path is failing during initialization and needs the failing stage isolated.",
    },
    {
      issueId:
        issues[1].id,
      summary:
        "The installation guide contains a documentation typo.",
      category:
        "Documentation",
      priority: "Low",
      effort: "Small",
      suggestedReply:
        "The typo is isolated to the installation guide and can be corrected directly.",
    },
  ];
}

async function seedAnalysisJob(
  issueCount: number,
) {
  const repository =
    await prisma.repository.create({
      data: {
        owner: "acme",
        name:
          "batch-analysis",
        fullName:
          "acme/batch-analysis",
        githubId:
          BigInt(9500),
      },
    });

  const importJob =
    await prisma.importJob.create({
      data: {
        status: "completed",
        completedAt:
          new Date(),
        repositoryId:
          repository.id,
      },
    });

  const issues = [];

  for (
    let index = 0;
    index < issueCount;
    index++
  ) {
    const number =
      index + 1;

    const saved =
      await prisma.issue.create({
        data: {
          githubIssueId:
            BigInt(
              9600 + index,
            ),
          issueNumber:
            number,
          title:
            `Batch issue ${number}`,
          body:
            `Batch body ${number}`,
          state: "open",
          author:
            `author-${number}`,
          githubUrl:
            `https://github.com/acme/batch-analysis/issues/${number}`,
          createdAtGithub:
            new Date(
              "2026-08-10T12:00:00.000Z",
            ),
          repositoryId:
            repository.id,
        },
      });

    issues.push(saved);
  }

  return {
    repository,
    importJob,
    issues,
  };
}

async function analyzeJob(
  importJobId: string,
) {
  return analyzeIssues(
    new Request(
      "http://localhost/api/analyze",
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
    ),
  );
}

beforeEach(async () => {
  analysisCache.clear();

  vi.unstubAllGlobals();
  vi.unstubAllEnvs();

  vi.stubEnv(
    "GEMINI_API_KEY",
    "integration-test-key",
  );

  await resetDatabase();
});

afterEach(() => {
  analysisCache.clear();

  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  analysisCache.clear();

  await resetDatabase();
  await prisma.$disconnect();
});

describe(
  "real PostgreSQL route integration",
  () => {
    it(
      "imports GitHub issues into PostgreSQL and excludes pull requests",
      async () => {
        const fetchMock =
          stubGitHubFetch();

        const { body } =
          await importRepositoryFixture();

        expect(
          fetchMock,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          body.repository,
        ).toEqual({
          owner: "acme",
          name: "widget",
          fullName:
            "acme/widget",
        });

        expect(
          body.issueCount,
        ).toBe(2);

        expect(
          body.issues,
        ).toHaveLength(2);

        expect(
          body.issues?.map(
            (issue) =>
              issue.number,
          ),
        ).toEqual([
          13,
          11,
        ]);

        const repository =
          await prisma.repository.findUniqueOrThrow(
            {
              where: {
                githubId:
                  BigInt(9001),
              },
            },
          );

        expect(
          repository.fullName,
        ).toBe("acme/widget");

        const importJob =
          await prisma.importJob.findUniqueOrThrow(
            {
              where: {
                id:
                  body.importJobId!,
              },
            },
          );

        expect(
          importJob.status,
        ).toBe("completed");

        const savedIssues =
          await prisma.issue.findMany(
            {
              where: {
                repositoryId:
                  repository.id,
              },
              orderBy: {
                issueNumber:
                  "asc",
              },
            },
          );

        expect(
          savedIssues.map(
            (issue) =>
              issue.issueNumber,
          ),
        ).toEqual([
          11,
          13,
        ]);
      },
    );

    it(
      "imports multiple GitHub pages, excludes pull requests, deduplicates repeated issues, and persists more than 10 issues",
      async () => {
        vi.stubEnv(
          "GITHUB_IMPORT_MAX_ISSUES",
          "23",
        );

        const pageOneRealIssues =
          Array.from(
            {
              length: 20,
            },
            (_, index) =>
              makeGitHubIssue(
                10_000 + index,
                100 + index,
              ),
          );

        const pageOnePullRequests =
          Array.from(
            {
              length: 80,
            },
            (_, index) =>
              makeGitHubIssue(
                20_000 + index,
                200 + index,
                true,
              ),
          );

        const pageTwoNewIssues = [
          makeGitHubIssue(
            30_001,
            301,
          ),
          makeGitHubIssue(
            30_002,
            302,
          ),
          makeGitHubIssue(
            30_003,
            303,
          ),
        ];

        const pages = new Map<
          number,
          unknown[]
        >([
          [
            1,
            [
              ...pageOneRealIssues,
              ...pageOnePullRequests,
            ],
          ],
          [
            2,
            [
              pageOneRealIssues[0],
              ...pageTwoNewIssues,
              makeGitHubIssue(
                30_004,
                304,
                true,
              ),
            ],
          ],
        ]);

        const fetchMock =
          stubGitHubPages(
            pages,
          );

        const { body } =
          await importRepositoryFixture();

        expect(
          fetchMock,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          body.issueCount,
        ).toBe(23);

        expect(
          body.issues,
        ).toHaveLength(23);

        const repository =
          await prisma.repository.findUniqueOrThrow(
            {
              where: {
                githubId:
                  BigInt(9001),
              },
            },
          );

        const savedIssues =
          await prisma.issue.findMany(
            {
              where: {
                repositoryId:
                  repository.id,
              },
            },
          );

        expect(
          savedIssues,
        ).toHaveLength(23);

        expect(
          new Set(
            savedIssues.map(
              (issue) =>
                issue.githubIssueId.toString(),
            ),
          ).size,
        ).toBe(23);

        for (
          const issue of
          pageTwoNewIssues
        ) {
          expect(
            savedIssues.some(
              (saved) =>
                saved.githubIssueId ===
                BigInt(issue.id),
            ),
          ).toBe(true);
        }
      },
    );

    it(
      "stops GitHub issue pagination at the hard page safety boundary",
      async () => {
        vi.stubEnv(
          "GITHUB_IMPORT_MAX_ISSUES",
          "500",
        );

        const pages = new Map<
          number,
          unknown[]
        >();

        for (
          let page = 1;
          page <= 10;
          page++
        ) {
          pages.set(
            page,
            Array.from(
              {
                length: 100,
              },
              (_, index) =>
                makeGitHubIssue(
                  40_000 +
                    page * 1_000 +
                    index,
                  page * 1_000 +
                    index,
                  true,
                ),
            ),
          );
        }

        const fetchMock =
          stubGitHubPages(
            pages,
          );

        const { body } =
          await importRepositoryFixture();

        expect(
          body.issueCount,
        ).toBe(0);

        expect(
          await prisma.issue.count(),
        ).toBe(0);

        expect(
          fetchMock,
        ).toHaveBeenCalledTimes(
          11,
        );

        const requestedUrls =
          fetchMock.mock.calls.map(
            ([input]) =>
              requestUrl(input),
          );

        expect(
          requestedUrls,
        ).not.toContain(
          issuesPageUrl(11),
        );
      },
    );

    it(
      "replaces a repeated repository import with exactly the new snapshot",
      async () => {
        const firstIssue =
          makeGitHubIssue(
            51_001,
            501,
          );

        const secondOldIssue =
          makeGitHubIssue(
            51_002,
            502,
          );

        stubGitHubPages(
          new Map([
            [
              1,
              [
                firstIssue,
                secondOldIssue,
              ],
            ],
          ]),
        );

        const firstImport =
          await importRepositoryFixture();

        const oldIssue =
          await prisma.issue.findUniqueOrThrow(
            {
              where: {
                githubIssueId:
                  BigInt(
                    firstIssue.id,
                  ),
              },
            },
          );

        await prisma.issueAnalysis.create({
          data: {
            issueId:
              oldIssue.id,
            summary:
              "Old analysis",
            category: "Bug",
            priority: "Low",
            effort: "Small",
            suggestedReply:
              "Old reply",
          },
        });

        const newIssue =
          makeGitHubIssue(
            52_001,
            601,
          );

        stubGitHubPages(
          new Map([
            [
              1,
              [newIssue],
            ],
          ]),
        );

        const secondImport =
          await importRepositoryFixture();

        expect(
          secondImport.body.importJobId,
        ).not.toBe(
          firstImport.body.importJobId,
        );

        expect(
          await prisma.importJob.findUnique(
            {
              where: {
                id:
                  firstImport.body
                    .importJobId!,
              },
            },
          ),
        ).toBeNull();

        const repository =
          await prisma.repository.findUniqueOrThrow(
            {
              where: {
                githubId:
                  BigInt(9001),
              },
            },
          );

        const currentIssues =
          await prisma.issue.findMany({
            where: {
              repositoryId:
                repository.id,
            },
          });

        expect(
          currentIssues,
        ).toHaveLength(1);

        expect(
          currentIssues[0]
            .githubIssueId,
        ).toBe(
          BigInt(newIssue.id),
        );

        expect(
          await prisma.issue.findUnique(
            {
              where: {
                githubIssueId:
                  BigInt(
                    firstIssue.id,
                  ),
              },
            },
          ),
        ).toBeNull();

        expect(
          await prisma.issue.findUnique(
            {
              where: {
                githubIssueId:
                  BigInt(
                    secondOldIssue.id,
                  ),
              },
            },
          ),
        ).toBeNull();

        expect(
          await prisma.issueAnalysis.count(),
        ).toBe(0);

        expect(
          await prisma.importJob.count({
            where: {
              repositoryId:
                repository.id,
            },
          }),
        ).toBe(1);
      },
    );

    it(
      "rolls back a failed repeated import and preserves the previous repository snapshot",
      async () => {
        const repository =
          await prisma.repository.create({
            data: {
              owner: "acme",
              name: "widget",
              fullName:
                "acme/widget",
              githubId:
                BigInt(9001),
            },
          });

        const oldJob =
          await prisma.importJob.create({
            data: {
              status:
                "completed",
              completedAt:
                new Date(),
              repositoryId:
                repository.id,
            },
          });

        const oldIssue =
          await prisma.issue.create({
            data: {
              githubIssueId:
                BigInt(60_001),
              issueNumber: 701,
              title:
                "Existing snapshot issue",
              body:
                "Must survive rollback.",
              state: "open",
              author: "alice",
              githubUrl:
                "https://github.com/acme/widget/issues/701",
              createdAtGithub:
                new Date(
                  "2026-08-01T12:00:00.000Z",
                ),
              repositoryId:
                repository.id,
            },
          });

        const oldAnalysis =
          await prisma.issueAnalysis.create({
            data: {
              issueId:
                oldIssue.id,
              summary:
                "Existing analysis",
              category: "Bug",
              priority: "High",
              effort: "Medium",
              suggestedReply:
                "Existing reply",
            },
          });

        const conflictingRepository =
          await prisma.repository.create({
            data: {
              owner: "acme",
              name:
                "conflict",
              fullName:
                "acme/conflict",
              githubId:
                BigInt(90_001),
            },
          });

        const conflictingIssueId =
          BigInt(70_001);

        await prisma.issue.create({
          data: {
            githubIssueId:
              conflictingIssueId,
            issueNumber: 1,
            title:
              "Conflict fixture",
            body:
              "Forces the new import createMany to fail.",
            state: "open",
            author: "bob",
            githubUrl:
              "https://github.com/acme/conflict/issues/1",
            createdAtGithub:
              new Date(
                "2026-08-01T12:00:00.000Z",
              ),
            repositoryId:
              conflictingRepository.id,
          },
        });

        stubGitHubPages(
          new Map([
            [
              1,
              [
                makeGitHubIssue(
                  Number(
                    conflictingIssueId,
                  ),
                  801,
                ),
              ],
            ],
          ]),
        );

        const consoleErrorSpy =
          vi.spyOn(
            console,
            "error",
          ).mockImplementation(
            () => undefined,
          );

        const response =
          await importIssues(
            new Request(
              "http://localhost/api/import",
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/json",
                },
                body:
                  JSON.stringify({
                    repoUrl:
                      repositoryUrl,
                  }),
              },
            ),
          );

        expect(
          response.status,
        ).toBe(500);

        expect(
          await prisma.importJob.findUnique(
            {
              where: {
                id: oldJob.id,
              },
            },
          ),
        ).not.toBeNull();

        expect(
          await prisma.issue.findUnique(
            {
              where: {
                id: oldIssue.id,
              },
            },
          ),
        ).not.toBeNull();

        expect(
          await prisma.issueAnalysis.findUnique(
            {
              where: {
                id:
                  oldAnalysis.id,
              },
            },
          ),
        ).not.toBeNull();

        expect(
          await prisma.importJob.count({
            where: {
              repositoryId:
                repository.id,
            },
          }),
        ).toBe(1);

        expect(
          await prisma.issue.count({
            where: {
              repositoryId:
                repository.id,
            },
          }),
        ).toBe(1);

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "persists a complete Gemini batch and stays idempotent on repeat analysis",
      async () => {
        stubGitHubFetch();

        const { body } =
          await importRepositoryFixture();

        const issues =
          await prisma.issue.findMany({
            orderBy: {
              issueNumber:
                "asc",
            },
          });

        const analysisResults =
          buildAnalysisResults(
            issues,
          );

        const geminiFetch =
          stubGeminiFetch(
            analysisResults,
          );

        const response =
          await analyzeJob(
            body.importJobId!,
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          geminiFetch,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          await prisma.issueAnalysis.count(),
        ).toBe(2);

        const unexpectedFetch =
          vi.fn(
            async (): Promise<Response> => {
              throw new Error(
                "Gemini must not run for an already analyzed job.",
              );
            },
          );

        vi.stubGlobal(
          "fetch",
          unexpectedFetch,
        );

        const repeatedResponse =
          await analyzeJob(
            body.importJobId!,
          );

        expect(
          repeatedResponse.status,
        ).toBe(200);

        expect(
          unexpectedFetch,
        ).not.toHaveBeenCalled();

        expect(
          await prisma.issueAnalysis.count(),
        ).toBe(2);
      },
    );

    it(
      "analyzes 23 issues in 10, 10, and 3 issue Gemini batches and persists every result",
      async () => {
        const {
          importJob,
          issues,
        } =
          await seedAnalysisJob(
            23,
          );

        const {
          fetchMock,
          requestedBatches,
        } =
          stubGeminiByRequestedBatch();

        const response =
          await analyzeJob(
            importJob.id,
          );

        expect(
          response.status,
        ).toBe(200);

        const responseBody =
          (await response.json()) as {
            success: boolean;
            analyzedCount: number;
          };

        expect(
          responseBody.analyzedCount,
        ).toBe(23);

        expect(
          fetchMock,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          requestedBatches.map(
            (batch) =>
              batch.length,
          ),
        ).toEqual([
          10,
          10,
          3,
        ]);

        expect(
          new Set(
            requestedBatches.flat(),
          ),
        ).toEqual(
          new Set(
            issues.map(
              (issue) =>
                issue.id,
            ),
          ),
        );

        expect(
          await prisma.issueAnalysis.count(),
        ).toBe(23);

        const analyzedJob =
          await prisma.importJob.findUniqueOrThrow(
            {
              where: {
                id:
                  importJob.id,
              },
            },
          );

        expect(
          analyzedJob.status,
        ).toBe("analyzed");

        expect(
          analyzedJob.analysisLeaseId,
        ).toBeNull();

        expect(
          analyzedJob.analysisStartedAt,
        ).toBeNull();
      },
    );

    it(
      "does not persist or cache partial analysis when a later Gemini batch fails",
      async () => {
        const {
          importJob,
          issues,
        } =
          await seedAnalysisJob(
            23,
          );

        const {
          fetchMock,
          successfulBatchIds,
        } =
          stubGeminiLaterBatchFailure();

        const consoleLogSpy =
          vi.spyOn(
            console,
            "log",
          ).mockImplementation(
            () => undefined,
          );

        const consoleErrorSpy =
          vi.spyOn(
            console,
            "error",
          ).mockImplementation(
            () => undefined,
          );

        const response =
          await analyzeJob(
            importJob.id,
          );

        expect(
          response.status,
        ).toBe(500);

        expect(
          fetchMock,
        ).toHaveBeenCalledTimes(
          4,
        );

        expect(
          successfulBatchIds,
        ).toHaveLength(10);

        expect(
          await prisma.issueAnalysis.count(),
        ).toBe(0);

        const recoveredJob =
          await prisma.importJob.findUniqueOrThrow(
            {
              where: {
                id:
                  importJob.id,
              },
            },
          );

        expect(
          recoveredJob.status,
        ).toBe("completed");

        expect(
          recoveredJob.analysisLeaseId,
        ).toBeNull();

        expect(
          recoveredJob.analysisStartedAt,
        ).toBeNull();

        const firstSuccessfulIssue =
          issues.find(
            (issue) =>
              issue.id ===
              successfulBatchIds[0],
          );

        expect(
          firstSuccessfulIssue,
        ).toBeDefined();

        expect(
          analysisCache.get(
            createAnalysisCacheKey({
              title:
                firstSuccessfulIssue!
                  .title,
              body:
                firstSuccessfulIssue!
                  .body,
            }),
          ),
        ).toBeUndefined();

        expect(
          consoleLogSpy,
        ).toHaveBeenCalled();

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "recovers from a Gemini 429 rate limit and persists after retry",
      async () => {
        stubGitHubFetch();

        const { body } =
          await importRepositoryFixture();

        const issues =
          await prisma.issue.findMany({
            orderBy: {
              issueNumber:
                "asc",
            },
          });

        const analysisResults =
          buildAnalysisResults(
            issues,
          );

        const geminiFetch =
          stubGemini429ThenSuccess(
            analysisResults,
          );

        const response =
          await analyzeJob(
            body.importJobId!,
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          geminiFetch,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          await prisma.issueAnalysis.count(),
        ).toBe(2);
      },
    );

    it(
      "rolls back persisted analysis when a PostgreSQL transaction fails",
      async () => {
        const repository =
          await prisma.repository.create({
            data: {
              owner: "acme",
              name:
                "rollback-demo",
              fullName:
                "acme/rollback-demo",
              githubId:
                BigInt(9201),
            },
          });

        const issue =
          await prisma.issue.create({
            data: {
              githubIssueId:
                BigInt(9202),
              issueNumber: 21,
              title:
                "Transaction rollback fixture",
              body:
                "Used to prove real PostgreSQL rollback behavior.",
              state: "open",
              author: "alice",
              githubUrl:
                "https://github.com/acme/rollback-demo/issues/21",
              createdAtGithub:
                new Date(
                  "2026-08-04T12:00:00.000Z",
                ),
              repositoryId:
                repository.id,
            },
          });

        await expect(
          prisma.$transaction(
            async (tx) => {
              await tx.issueAnalysis.create(
                {
                  data: {
                    issueId:
                      issue.id,
                    summary:
                      "This row must never survive the transaction.",
                    category:
                      "Bug",
                    priority:
                      "High",
                    effort:
                      "Small",
                    suggestedReply:
                      "This write should be rolled back.",
                  },
                },
              );

              throw new Error(
                "force transaction rollback",
              );
            },
          ),
        ).rejects.toThrow(
          "force transaction rollback",
        );

        expect(
          await prisma.issueAnalysis.count(),
        ).toBe(0);
      },
    );
  },
);