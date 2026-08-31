import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const prismaMocks = vi.hoisted(() => ({
  importJobUpdateMany: vi.fn(),
  importJobFindUnique: vi.fn(),
  transaction: vi.fn(),
  txIssueAnalysisCreateMany: vi.fn(),
  txIssueAnalysisFindMany: vi.fn(),
  txImportJobUpdateMany: vi.fn(),
}));

const httpMocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  isRetryableHttpStatus: vi.fn(),
  retryDelayMs: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("@/lib/http", () => ({
  fetchWithTimeout: httpMocks.fetchWithTimeout,
  isRetryableHttpStatus:
    httpMocks.isRetryableHttpStatus,
  retryDelayMs: httpMocks.retryDelayMs,
  wait: httpMocks.wait,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: {
      updateMany:
        prismaMocks.importJobUpdateMany,
      findUnique:
        prismaMocks.importJobFindUnique,
    },
    $transaction: prismaMocks.transaction,
  },
}));

import { POST } from "@/app/api/analyze/route";
import { analysisCache } from "@/lib/analysis-cache";

function analyzeRequest(
  importJobId?: string,
  signal?: AbortSignal,
) {
  return new Request(
    "http://localhost/api/analyze",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        importJobId === undefined
          ? {}
          : { importJobId },
      ),
      signal,
    },
  );
}

function geminiResponse(
  content: string,
) {
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
    },
  );
}

function unanalyzedIssue(
  id: string,
  title = `Title for ${id}`,
  body = `Body for ${id}`,
) {
  return {
    id,
    title,
    body,
    analysis: null,
  };
}

function analyzedIssue(id: string) {
  return {
    id,
    title: `Title for ${id}`,
    body: `Body for ${id}`,
    analysis: {
      id: `analysis-${id}`,
    },
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
  }> = {},
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

function mockReadyImportJob(
  issues: Array<{
    id: string;
    title: string;
    body: string | null;
    analysis: null | { id: string };
  }>,
) {
  prismaMocks.importJobFindUnique.mockResolvedValue(
    {
      id: "job-1",
      status: "analyzing",
      repository: {
        fullName: "octo/repo",
        issues,
      },
    },
  );
}

function getClaimInput() {
  return prismaMocks.importJobUpdateMany
    .mock.calls[0][0];
}

function getClaimedLeaseId() {
  const leaseId =
    getClaimInput().data.analysisLeaseId;

  expect(typeof leaseId).toBe("string");
  expect(leaseId.length).toBeGreaterThan(0);

  return leaseId as string;
}

function expectLeaseRefreshCall(
  callIndex: number,
  leaseId: string,
) {
  expect(
    prismaMocks.importJobUpdateMany,
  ).toHaveBeenNthCalledWith(
    callIndex,
    {
      where: {
        id: "job-1",
        status: "analyzing",
        analysisLeaseId:
          leaseId,
      },
      data: {
        analysisStartedAt:
          expect.any(Date),
      },
    },
  );
}

async function expectControlledFailure(
  response: Response,
) {
  expect(response.status).toBe(500);

  await expect(
    response.json(),
  ).resolves.toEqual({
    success: false,
    error:
      "AI analysis failed. This may be a temporary model limit or connection issue.",
  });
}

async function runRejectedGeminiBatch(
  result: unknown,
) {
  mockReadyImportJob([
    unanalyzedIssue("issue-1"),
  ]);

  httpMocks.fetchWithTimeout.mockResolvedValue(
    geminiResponse(
      JSON.stringify(result),
    ),
  );

  const consoleLogSpy = vi
    .spyOn(console, "log")
    .mockImplementation(
      () => undefined,
    );

  const consoleErrorSpy = vi
    .spyOn(console, "error")
    .mockImplementation(
      () => undefined,
    );

  const response = await POST(
    analyzeRequest("job-1"),
  );

  await expectControlledFailure(response);

  expect(
    httpMocks.fetchWithTimeout,
  ).toHaveBeenCalledTimes(3);

  expect(
    httpMocks.wait,
  ).toHaveBeenCalledTimes(2);

  expect(
    prismaMocks.transaction,
  ).not.toHaveBeenCalled();

  const leaseId =
    getClaimedLeaseId();

  expect(
    prismaMocks.importJobUpdateMany,
  ).toHaveBeenCalledTimes(2);

  expect(
    prismaMocks.importJobUpdateMany,
  ).toHaveBeenNthCalledWith(2, {
    where: {
      id: "job-1",
      status: "analyzing",
      analysisLeaseId: leaseId,
    },
    data: {
      status: "completed",
      analysisLeaseId: null,
      analysisStartedAt: null,
    },
  });

  expect(
    consoleLogSpy,
  ).toHaveBeenCalledWith(
    "Gemini batch attempt 1 failed",
  );

  expect(
    consoleLogSpy,
  ).toHaveBeenCalledWith(
    "Gemini batch attempt 2 failed",
  );

  expect(
    consoleLogSpy,
  ).toHaveBeenCalledWith(
    "Gemini batch attempt 3 failed",
  );

  expect(
    consoleErrorSpy,
  ).toHaveBeenCalled();
}

describe(
  "POST /api/analyze",
  () => {
    beforeEach(() => {
      vi.resetAllMocks();
      analysisCache.clear();

      vi.stubEnv(
        "GEMINI_API_KEY",
        "test-gemini-key",
      );

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

      prismaMocks.importJobUpdateMany.mockResolvedValue(
        {
          count: 1,
        },
      );

      prismaMocks.txImportJobUpdateMany.mockResolvedValue(
        {
          count: 1,
        },
      );

      prismaMocks.txIssueAnalysisCreateMany.mockImplementation(
        async ({
          data,
        }: {
          data: unknown[];
        }) => ({
          count: data.length,
        }),
      );

      prismaMocks.txIssueAnalysisFindMany.mockImplementation(
        async () => {
          const calls =
            prismaMocks
              .txIssueAnalysisCreateMany
              .mock.calls;

          const latestCall =
            calls[
              calls.length - 1
            ];

          const rows =
            latestCall?.[0]?.data ?? [];

          return rows.map(
            (
              row: {
                issueId: string;
                summary: string;
                category: string;
                priority: string;
                effort: string;
                suggestedReply: string;
              },
              index: number,
            ) => ({
              id:
                `analysis-${row.issueId}`,
              ...row,
              createdAt: new Date(
                `2026-08-01T00:00:${String(
                  index,
                ).padStart(
                  2,
                  "0",
                )}.000Z`,
              ),
            }),
          );
        },
      );

      prismaMocks.transaction.mockImplementation(
        async (
          callback: (tx: {
            issueAnalysis: {
              createMany:
                typeof prismaMocks.txIssueAnalysisCreateMany;
              findMany:
                typeof prismaMocks.txIssueAnalysisFindMany;
            };
            importJob: {
              updateMany:
                typeof prismaMocks.txImportJobUpdateMany;
            };
          }) => Promise<unknown>,
        ) =>
          callback({
            issueAnalysis: {
              createMany:
                prismaMocks.txIssueAnalysisCreateMany,
              findMany:
                prismaMocks.txIssueAnalysisFindMany,
            },
            importJob: {
              updateMany:
                prismaMocks.txImportJobUpdateMany,
            },
          }),
      );
    });

    afterEach(() => {
      analysisCache.clear();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });

    it(
      "rejects a request without an importJobId before claiming work",
      async () => {
        const response = await POST(
          analyzeRequest(),
        );

        expect(
          response.status,
        ).toBe(400);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "importJobId is required.",
        });

        expect(
          prismaMocks.importJobUpdateMany,
        ).not.toHaveBeenCalled();

        expect(
          httpMocks.fetchWithTimeout,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "rejects analysis when the Gemini API key is missing before claiming work",
      async () => {
        vi.stubEnv(
          "GEMINI_API_KEY",
          "",
        );

        const response = await POST(
          analyzeRequest("job-1"),
        );

        expect(
          response.status,
        ).toBe(500);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "AI analysis is not configured.",
        });

        expect(
          prismaMocks.importJobUpdateMany,
        ).not.toHaveBeenCalled();

        expect(
          httpMocks.fetchWithTimeout,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "returns 404 when the import job cannot be claimed because it does not exist",
      async () => {
        prismaMocks.importJobUpdateMany.mockResolvedValueOnce(
          {
            count: 0,
          },
        );

        prismaMocks.importJobFindUnique.mockResolvedValueOnce(
          null,
        );

        const response = await POST(
          analyzeRequest(
            "missing-job",
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
            "Import job not found.",
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
      "prevents a duplicate request from calling Gemini while another analysis owns the lease",
      async () => {
        prismaMocks.importJobUpdateMany.mockResolvedValueOnce(
          {
            count: 0,
          },
        );

        prismaMocks.importJobFindUnique.mockResolvedValueOnce(
          {
            status: "analyzing",
          },
        );

        const response = await POST(
          analyzeRequest("job-1"),
        );

        expect(
          response.status,
        ).toBe(409);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: false,
          error:
            "AI analysis is already in progress.",
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
      "returns idempotent success when the job is already analyzed",
      async () => {
        prismaMocks.importJobUpdateMany.mockResolvedValueOnce(
          {
            count: 0,
          },
        );

        prismaMocks.importJobFindUnique.mockResolvedValueOnce(
          {
            status: "analyzed",
          },
        );

        const response = await POST(
          analyzeRequest("job-1"),
        );

        expect(
          response.status,
        ).toBe(200);

        await expect(
          response.json(),
        ).resolves.toEqual({
          success: true,
          analyzedCount: 0,
          message:
            "All issues already analyzed.",
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
      "claims completed or stale analysis work atomically with a unique lease",
      async () => {
        mockReadyImportJob([
          analyzedIssue("issue-1"),
        ]);

        const response = await POST(
          analyzeRequest("job-1"),
        );

        expect(
          response.status,
        ).toBe(200);

        const claim =
          getClaimInput();

        expect(
          claim.where.id,
        ).toBe("job-1");

        expect(
          claim.where.OR,
        ).toEqual([
          {
            status: "completed",
          },
          {
            status: "analyzing",
            analysisStartedAt: {
              lt: expect.any(Date),
            },
          },
          {
            status: "analyzing",
            analysisStartedAt: null,
          },
        ]);

        expect(
          claim.data,
        ).toEqual({
          status: "analyzing",
          analysisLeaseId:
            expect.any(String),
          analysisStartedAt:
            expect.any(Date),
        });

        expect(
          httpMocks.fetchWithTimeout,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenCalledTimes(2);

        const leaseId =
          getClaimedLeaseId();

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenNthCalledWith(
          2,
          {
            where: {
              id: "job-1",
              status: "analyzing",
              analysisLeaseId:
                leaseId,
            },
            data: {
              status: "analyzed",
              analysisLeaseId:
                null,
              analysisStartedAt:
                null,
            },
          },
        );
      },
    );

    it(
      "sends the structured schema to Gemini, refreshes its lease, bulk-persists analyses, and finalizes atomically",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
            "Build crashes on startup",
            "The application exits during initialization.",
          ),
          unanalyzedIssue(
            "issue-2",
            "Improve installation docs",
            "The setup guide is missing a required command.",
          ),
          analyzedIssue("issue-3"),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse(
            JSON.stringify({
              issues: [
                validAnalysis(
                  "issue-1",
                  {
                    summary:
                      "Application crashes during initialization.",
                    category: "Bug",
                    priority:
                      "Critical",
                    effort:
                      "Medium",
                    suggestedReply:
                      "The startup failure appears to occur during initialization; a minimal reproduction would help isolate the failing path.",
                  },
                ),
                validAnalysis(
                  "issue-2",
                  {
                    summary:
                      "Installation guide is missing a setup command.",
                    category:
                      "Documentation",
                    priority: "Low",
                    effort: "Small",
                    suggestedReply:
                      "The installation guide should include the missing setup command in the documented sequence.",
                  },
                ),
              ],
            }),
          ),
        );

        const response = await POST(
          analyzeRequest("job-1"),
        );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        const [
          url,
          options,
          timeoutMs,
        ] =
          httpMocks.fetchWithTimeout
            .mock.calls[0];

        expect(url).toBe(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        );

        expect(url).not.toContain(
          "test-gemini-key",
        );

        expect(
          timeoutMs,
        ).toBe(30_000);

        expect(
          options,
        ).toMatchObject({
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            "x-goog-api-key":
              "test-gemini-key",
          },
          signal:
            expect.any(
              AbortSignal,
            ),
        });

        const requestBody =
          JSON.parse(
            String(options.body),
          );

        expect(
          requestBody
            .generationConfig
            .responseMimeType,
        ).toBe(
          "application/json",
        );

        expect(
          requestBody
            .generationConfig
            .responseJsonSchema,
        ).toEqual({
          type: "object",
          additionalProperties:
            false,
          properties: {
            issues: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: {
                type: "object",
                additionalProperties:
                  false,
                properties: {
                  issueId: {
                    type: "string",
                    enum: [
                      "issue-1",
                      "issue-2",
                    ],
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
                    enum: [
                      "Critical",
                      "High",
                      "Medium",
                      "Low",
                    ],
                  },
                  effort: {
                    type: "string",
                    enum: [
                      "Small",
                      "Medium",
                      "Large",
                    ],
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

        const prompt =
          requestBody.contents[0]
            .parts[0]
            .text as string;

        expect(
          prompt,
        ).toContain(
          '"id": "issue-1"',
        );

        expect(
          prompt,
        ).toContain(
          '"id": "issue-2"',
        );

        expect(
          prompt,
        ).not.toContain(
          '"id": "issue-3"',
        );

        const leaseId =
          getClaimedLeaseId();

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenCalledTimes(
          3,
        );

        expectLeaseRefreshCall(
          2,
          leaseId,
        );

        expectLeaseRefreshCall(
          3,
          leaseId,
        );

        expect(
          prismaMocks.transaction,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.transaction
            .mock.calls[0][1],
        ).toEqual({
          maxWait: 5_000,
          timeout: 10_000,
        });

        expect(
          prismaMocks.txIssueAnalysisCreateMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txIssueAnalysisCreateMany,
        ).toHaveBeenCalledWith({
          data: [
            {
              issueId:
                "issue-1",
              summary:
                "Application crashes during initialization.",
              category: "Bug",
              priority:
                "Critical",
              effort: "Medium",
              suggestedReply:
                "The startup failure appears to occur during initialization; a minimal reproduction would help isolate the failing path.",
            },
            {
              issueId:
                "issue-2",
              summary:
                "Installation guide is missing a setup command.",
              category:
                "Documentation",
              priority: "Low",
              effort: "Small",
              suggestedReply:
                "The installation guide should include the missing setup command in the documented sequence.",
            },
          ],
        });

        expect(
          prismaMocks.txIssueAnalysisFindMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txIssueAnalysisFindMany,
        ).toHaveBeenCalledWith({
          where: {
            issueId: {
              in: [
                "issue-1",
                "issue-2",
              ],
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        });

        expect(
          prismaMocks.txImportJobUpdateMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txImportJobUpdateMany,
        ).toHaveBeenCalledWith({
          where: {
            id: "job-1",
            status: "analyzing",
            analysisLeaseId:
              leaseId,
          },
          data: {
            status: "analyzed",
            analysisLeaseId:
              null,
            analysisStartedAt:
              null,
          },
        });

        const data =
          await response.json();

        expect(
          data.success,
        ).toBe(true);

        expect(
          data.repo,
        ).toBe("octo/repo");

        expect(
          data.analyzedCount,
        ).toBe(2);

        expect(
          data.analyses,
        ).toHaveLength(2);
      },
    );

    it(
      "refreshes lease ownership after every successful Gemini batch and again before persistence",
      async () => {
        const issues =
          Array.from(
            {
              length: 11,
            },
            (_, index) =>
              unanalyzedIssue(
                `issue-${index + 1}`,
              ),
          );

        mockReadyImportJob(
          issues,
        );

        httpMocks.fetchWithTimeout
          .mockResolvedValueOnce(
            geminiResponse(
              JSON.stringify({
                issues: issues
                  .slice(0, 10)
                  .map((issue) =>
                    validAnalysis(
                      issue.id,
                    ),
                  ),
              }),
            ),
          )
          .mockResolvedValueOnce(
            geminiResponse(
              JSON.stringify({
                issues: [
                  validAnalysis(
                    "issue-11",
                  ),
                ],
              }),
            ),
          );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          2,
        );

        const leaseId =
          getClaimedLeaseId();

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenCalledTimes(
          4,
        );

        expectLeaseRefreshCall(
          2,
          leaseId,
        );

        expectLeaseRefreshCall(
          3,
          leaseId,
        );

        expectLeaseRefreshCall(
          4,
          leaseId,
        );

        expect(
          prismaMocks.transaction,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txIssueAnalysisCreateMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        const createInput =
          prismaMocks
            .txIssueAnalysisCreateMany
            .mock.calls[0][0];

        expect(
          createInput.data,
        ).toHaveLength(11);

        expect(
          prismaMocks.txIssueAnalysisFindMany,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    it(
      "stops before persistence when lease ownership is lost during a heartbeat",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse(
            JSON.stringify({
              issues: [
                validAnalysis(
                  "issue-1",
                ),
              ],
            }),
          ),
        );

        prismaMocks.importJobUpdateMany
          .mockResolvedValueOnce({
            count: 1,
          })
          .mockResolvedValueOnce({
            count: 0,
          });

        const consoleErrorSpy =
          vi
            .spyOn(
              console,
              "error",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.txIssueAnalysisCreateMany,
        ).not.toHaveBeenCalled();

        const leaseId =
          getClaimedLeaseId();

        expectLeaseRefreshCall(
          2,
          leaseId,
        );

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenNthCalledWith(
          3,
          {
            where: {
              id: "job-1",
              status:
                "analyzing",
              analysisLeaseId:
                leaseId,
            },
            data: {
              status:
                "completed",
              analysisLeaseId:
                null,
              analysisStartedAt:
                null,
            },
          },
        );

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "fails atomically when persisted analysis count is incomplete",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
          unanalyzedIssue(
            "issue-2",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse(
            JSON.stringify({
              issues: [
                validAnalysis(
                  "issue-1",
                ),
                validAnalysis(
                  "issue-2",
                ),
              ],
            }),
          ),
        );

        prismaMocks.txIssueAnalysisFindMany.mockResolvedValueOnce(
          [
            {
              id:
                "analysis-issue-1",
              ...validAnalysis(
                "issue-1",
              ),
              createdAt:
                new Date(),
            },
          ],
        );

        const consoleErrorSpy =
          vi
            .spyOn(
              console,
              "error",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

        expect(
          prismaMocks.txIssueAnalysisCreateMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txIssueAnalysisFindMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txImportJobUpdateMany,
        ).not.toHaveBeenCalled();

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "retries a transient Gemini 429 and honors Retry-After before succeeding",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

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
            geminiResponse(
              JSON.stringify({
                issues: [
                  validAnalysis(
                    "issue-1",
                  ),
                ],
              }),
            ),
          );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          httpMocks.wait,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          httpMocks.wait,
        ).toHaveBeenCalledWith(
          2_000,
        );

        expect(
          prismaMocks.transaction,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    it(
      "retries a transient network failure with exponential backoff",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

        httpMocks.fetchWithTimeout
          .mockRejectedValueOnce(
            new Error(
              "network reset",
            ),
          )
          .mockResolvedValueOnce(
            geminiResponse(
              JSON.stringify({
                issues: [
                  validAnalysis(
                    "issue-1",
                  ),
                ],
              }),
            ),
          );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          httpMocks.retryDelayMs,
        ).toHaveBeenCalledWith(
          1,
          1_000,
        );

        expect(
          httpMocks.wait,
        ).toHaveBeenCalledWith(
          1_000,
        );
      },
    );

    it(
      "does not retry a permanent Gemini 400 response",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          new Response(
            "bad request",
            {
              status: 400,
            },
          ),
        );

        const consoleErrorSpy =
          vi
            .spyOn(
              console,
              "error",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

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
      "releases only its own lease when analysis fails",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          new Response(
            "bad request",
            {
              status: 400,
            },
          ),
        );

        vi.spyOn(
          console,
          "error",
        ).mockImplementation(
          () => undefined,
        );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

        const leaseId =
          getClaimedLeaseId();

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenNthCalledWith(
          2,
          {
            where: {
              id: "job-1",
              status:
                "analyzing",
              analysisLeaseId:
                leaseId,
            },
            data: {
              status:
                "completed",
              analysisLeaseId:
                null,
              analysisStartedAt:
                null,
            },
          },
        );
      },
    );

    it(
      "rolls back the analysis transaction when lease ownership is lost during finalization",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse(
            JSON.stringify({
              issues: [
                validAnalysis(
                  "issue-1",
                ),
              ],
            }),
          ),
        );

        prismaMocks.txImportJobUpdateMany.mockResolvedValueOnce(
          {
            count: 0,
          },
        );

        const consoleErrorSpy =
          vi
            .spyOn(
              console,
              "error",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

        expect(
          prismaMocks.transaction,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txIssueAnalysisCreateMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          prismaMocks.txIssueAnalysisFindMany,
        ).toHaveBeenCalledTimes(
          1,
        );

        const leaseId =
          getClaimedLeaseId();

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenCalledTimes(
          4,
        );

        expectLeaseRefreshCall(
          2,
          leaseId,
        );

        expectLeaseRefreshCall(
          3,
          leaseId,
        );

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenNthCalledWith(
          4,
          {
            where: {
              id: "job-1",
              status:
                "analyzing",
              analysisLeaseId:
                leaseId,
            },
            data: {
              status:
                "completed",
              analysisLeaseId:
                null,
              analysisStartedAt:
                null,
            },
          },
        );

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "does not retry Gemini when the incoming request has been aborted",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

        const controller =
          new AbortController();

        controller.abort();

        httpMocks.fetchWithTimeout.mockRejectedValueOnce(
          new DOMException(
            "The operation was aborted.",
            "AbortError",
          ),
        );

        vi.spyOn(
          console,
          "error",
        ).mockImplementation(
          () => undefined,
        );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
              controller.signal,
            ),
          );

        await expectControlledFailure(
          response,
        );

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
      "retries malformed Gemini JSON and never starts persistence for an invalid batch",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
            "Broken build",
            "Build fails.",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValue(
          geminiResponse(
            "{ definitely not valid json",
          ),
        );

        const consoleLogSpy =
          vi
            .spyOn(
              console,
              "log",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const consoleErrorSpy =
          vi
            .spyOn(
              console,
              "error",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();

        expect(
          consoleLogSpy,
        ).toHaveBeenCalledWith(
          "Gemini batch attempt 1 failed",
        );

        expect(
          consoleLogSpy,
        ).toHaveBeenCalledWith(
          "Gemini batch attempt 2 failed",
        );

        expect(
          consoleLogSpy,
        ).toHaveBeenCalledWith(
          "Gemini batch attempt 3 failed",
        );

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "retries malformed Gemini response envelopes and never starts persistence",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValue(
          new Response(
            JSON.stringify({}),
            {
              status: 200,
              headers: {
                "Content-Type":
                  "application/json",
              },
            },
          ),
        );

        const consoleLogSpy =
          vi
            .spyOn(
              console,
              "log",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const consoleErrorSpy =
          vi
            .spyOn(
              console,
              "error",
            )
            .mockImplementation(
              () =>
                undefined,
            );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          httpMocks.wait,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.txIssueAnalysisCreateMany,
        ).not.toHaveBeenCalled();

        const leaseId =
          getClaimedLeaseId();

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          prismaMocks.importJobUpdateMany,
        ).toHaveBeenNthCalledWith(
          2,
          {
            where: {
              id: "job-1",
              status:
                "analyzing",
              analysisLeaseId:
                leaseId,
            },
            data: {
              status:
                "completed",
              analysisLeaseId:
                null,
              analysisStartedAt:
                null,
            },
          },
        );

        expect(
          consoleLogSpy,
        ).toHaveBeenCalledWith(
          "Gemini batch attempt 1 failed",
        );

        expect(
          consoleLogSpy,
        ).toHaveBeenCalledWith(
          "Gemini batch attempt 2 failed",
        );

        expect(
          consoleLogSpy,
        ).toHaveBeenCalledWith(
          "Gemini batch attempt 3 failed",
        );

        expect(
          consoleErrorSpy,
        ).toHaveBeenCalled();
      },
    );

    it(
      "rejects a batch containing an invalid enum value before persistence",
      async () => {
        await runRejectedGeminiBatch(
          {
            issues: [
              {
                ...validAnalysis(
                  "issue-1",
                ),
                priority:
                  "Urgent",
              },
            ],
          },
        );
      },
    );

    it(
      "rejects a batch containing an issue ID that was not requested",
      async () => {
        await runRejectedGeminiBatch(
          {
            issues: [
              validAnalysis(
                "different-issue",
              ),
            ],
          },
        );
      },
    );

    it(
      "rejects duplicate issue results before persistence",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
          unanalyzedIssue(
            "issue-2",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValue(
          geminiResponse(
            JSON.stringify({
              issues: [
                validAnalysis(
                  "issue-1",
                ),
                validAnalysis(
                  "issue-1",
                ),
              ],
            }),
          ),
        );

        vi.spyOn(
          console,
          "log",
        ).mockImplementation(
          () => undefined,
        );

        vi.spyOn(
          console,
          "error",
        ).mockImplementation(
          () => undefined,
        );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

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
      "rejects an incomplete batch before persistence",
      async () => {
        mockReadyImportJob([
          unanalyzedIssue(
            "issue-1",
          ),
          unanalyzedIssue(
            "issue-2",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValue(
          geminiResponse(
            JSON.stringify({
              issues: [
                validAnalysis(
                  "issue-1",
                ),
              ],
            }),
          ),
        );

        vi.spyOn(
          console,
          "log",
        ).mockImplementation(
          () => undefined,
        );

        vi.spyOn(
          console,
          "error",
        ).mockImplementation(
          () => undefined,
        );

        const response =
          await POST(
            analyzeRequest(
              "job-1",
            ),
          );

        await expectControlledFailure(
          response,
        );

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
      "rejects empty required analysis text before persistence",
      async () => {
        await runRejectedGeminiBatch(
          {
            issues: [
              validAnalysis(
                "issue-1",
                {
                  summary: "   ",
                },
              ),
            ],
          },
        );
      },
    );
  },
);