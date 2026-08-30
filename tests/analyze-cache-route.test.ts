import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const prismaMocks = vi.hoisted(
  () => ({
    importJobUpdateMany:
      vi.fn(),
    importJobFindUnique:
      vi.fn(),
    transaction: vi.fn(),
    txIssueAnalysisUpsert:
      vi.fn(),
    txImportJobUpdateMany:
      vi.fn(),
  }),
);

const httpMocks = vi.hoisted(
  () => ({
    fetchWithTimeout:
      vi.fn(),
    isRetryableHttpStatus:
      vi.fn(),
    retryDelayMs: vi.fn(),
    wait: vi.fn(),
  }),
);

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
    importJob: {
      updateMany:
        prismaMocks.importJobUpdateMany,
      findUnique:
        prismaMocks.importJobFindUnique,
    },
    $transaction:
      prismaMocks.transaction,
  },
}));

import { POST } from "@/app/api/analyze/route";
import {
  analysisCache,
  createAnalysisCacheKey,
} from "@/lib/analysis-cache";

type TestIssue = {
  id: string;
  title: string;
  body: string | null;
  analysis: null;
};

type TestAnalysis = {
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

function analyzeRequest() {
  return new Request(
    "http://localhost/api/analyze",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        importJobId: "job-1",
      }),
    },
  );
}

function issue(
  id: string,
  title: string,
  body: string | null,
): TestIssue {
  return {
    id,
    title,
    body,
    analysis: null,
  };
}

function analysis(
  issueId: string,
  overrides: Partial<
    Omit<
      TestAnalysis,
      "issueId"
    >
  > = {},
): TestAnalysis {
  return {
    issueId,
    summary:
      `Summary for ${issueId}`,
    category: "Bug",
    priority: "High",
    effort: "Medium",
    suggestedReply:
      `Reply for ${issueId}`,
    ...overrides,
  };
}

function geminiResponse(
  results: TestAnalysis[],
) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text:
                  JSON.stringify(
                    {
                      issues:
                        results,
                    },
                  ),
              },
            ],
          },
        },
      ],
    }),
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/json",
      },
    },
  );
}

function readyJob(
  issues: TestIssue[],
) {
  prismaMocks.importJobFindUnique.mockResolvedValue(
    {
      id: "job-1",
      status:
        "analyzing",
      repository: {
        fullName:
          "octo/repo",
        issues,
      },
    },
  );
}

describe(
  "POST /api/analyze cache integration",
  () => {
    beforeEach(() => {
      vi.resetAllMocks();
      analysisCache.clear();

      vi.stubEnv(
        "GEMINI_API_KEY",
        "test-gemini-key",
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

      prismaMocks.txIssueAnalysisUpsert.mockImplementation(
        async ({
          create,
        }) => ({
          id:
            `analysis-${create.issueId}`,
          ...create,
          createdAt:
            new Date(
              "2026-08-01T00:00:00.000Z",
            ),
        }),
      );

      prismaMocks.transaction.mockImplementation(
        async (
          callback: (
            tx: {
              issueAnalysis: {
                upsert:
                  typeof prismaMocks.txIssueAnalysisUpsert;
              };
              importJob: {
                updateMany:
                  typeof prismaMocks.txImportJobUpdateMany;
              };
            },
          ) => Promise<unknown>,
        ) =>
          callback({
            issueAnalysis: {
              upsert:
                prismaMocks.txIssueAnalysisUpsert,
            },
            importJob: {
              updateMany:
                prismaMocks.txImportJobUpdateMany,
            },
          }),
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
    });

    afterEach(() => {
      analysisCache.clear();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });

    it(
      "stores a successful validated Gemini result in the cache",
      async () => {
        const currentIssue =
          issue(
            "issue-1",
            "Crash on startup",
            "App crashes during boot.",
          );

        readyJob([
          currentIssue,
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse([
            analysis(
              "issue-1",
            ),
          ]),
        );

        const response =
          await POST(
            analyzeRequest(),
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        const cached =
          analysisCache.get(
            createAnalysisCacheKey(
              currentIssue,
            ),
          );

        expect(
          cached,
        ).toEqual({
          summary:
            "Summary for issue-1",
          category: "Bug",
          priority: "High",
          effort: "Medium",
          suggestedReply:
            "Reply for issue-1",
        });
      },
    );

    it(
      "reuses identical issue content without making another Gemini request",
      async () => {
        const title =
          "Crash on startup";

        const body =
          "App crashes during boot.";

        readyJob([
          issue(
            "issue-original",
            title,
            body,
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse([
            analysis(
              "issue-original",
            ),
          ]),
        );

        const firstResponse =
          await POST(
            analyzeRequest(),
          );

        expect(
          firstResponse.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );

        httpMocks.fetchWithTimeout.mockClear();

        readyJob([
          issue(
            "issue-reimported",
            title,
            body,
          ),
        ]);

        const secondResponse =
          await POST(
            analyzeRequest(),
          );

        expect(
          secondResponse.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).not.toHaveBeenCalled();

        expect(
          prismaMocks.txIssueAnalysisUpsert,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: {
              issueId:
                "issue-reimported",
            },
            create:
              expect.objectContaining({
                issueId:
                  "issue-reimported",
                summary:
                  "Summary for issue-original",
                category:
                  "Bug",
                priority:
                  "High",
                effort:
                  "Medium",
                suggestedReply:
                  "Reply for issue-original",
              }),
          }),
        );
      },
    );

    it(
      "sends only cache misses to Gemini in a mixed batch",
      async () => {
        const cachedIssue =
          issue(
            "cached-issue",
            "Known crash",
            "Known crash body",
          );

        const missingIssue =
          issue(
            "missing-issue",
            "New performance regression",
            "Rendering became slow.",
          );

        analysisCache.set(
          createAnalysisCacheKey(
            cachedIssue,
          ),
          {
            summary:
              "Previously analyzed crash.",
            category: "Bug",
            priority: "High",
            effort: "Medium",
            suggestedReply:
              "Investigate the startup regression.",
          },
        );

        readyJob([
          cachedIssue,
          missingIssue,
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse([
            analysis(
              "missing-issue",
              {
                category:
                  "Performance",
              },
            ),
          ]),
        );

        const response =
          await POST(
            analyzeRequest(),
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
          ,
          options,
        ] =
          httpMocks.fetchWithTimeout
            .mock.calls[0];

        const requestBody =
          JSON.parse(
            String(
              options.body,
            ),
          );

        expect(
          requestBody
            .generationConfig
            .responseJsonSchema
            .properties.issues
            .minItems,
        ).toBe(1);

        expect(
          requestBody
            .generationConfig
            .responseJsonSchema
            .properties.issues
            .maxItems,
        ).toBe(1);

        expect(
          requestBody
            .generationConfig
            .responseJsonSchema
            .properties.issues
            .items.properties
            .issueId.enum,
        ).toEqual([
          "missing-issue",
        ]);

        const prompt =
          requestBody
            .contents[0]
            .parts[0]
            .text as string;

        expect(
          prompt,
        ).toContain(
          '"id": "missing-issue"',
        );

        expect(
          prompt,
        ).not.toContain(
          '"id": "cached-issue"',
        );

        expect(
          prismaMocks.txIssueAnalysisUpsert,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          analysisCache.get(
            createAnalysisCacheKey(
              missingIssue,
            ),
          ),
        ).toEqual({
          summary:
            "Summary for missing-issue",
          category:
            "Performance",
          priority: "High",
          effort: "Medium",
          suggestedReply:
            "Reply for missing-issue",
        });
      },
    );

    it(
      "treats changed issue content as a cache miss",
      async () => {
        analysisCache.set(
          createAnalysisCacheKey(
            {
              title:
                "Crash on startup",
              body:
                "Old reproduction steps.",
            },
          ),
          {
            summary:
              "Old cached analysis.",
            category: "Bug",
            priority: "High",
            effort: "Medium",
            suggestedReply:
              "Old cached reply.",
          },
        );

        readyJob([
          issue(
            "issue-1",
            "Crash on startup",
            "New reproduction steps.",
          ),
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse([
            analysis(
              "issue-1",
            ),
          ]),
        );

        const response =
          await POST(
            analyzeRequest(),
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    it(
      "does not cache Gemini output when database persistence fails",
      async () => {
        const currentIssue =
          issue(
            "issue-1",
            "Crash on startup",
            "App crashes during boot.",
          );

        readyJob([
          currentIssue,
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValueOnce(
          geminiResponse([
            analysis(
              "issue-1",
            ),
          ]),
        );

        prismaMocks.transaction.mockRejectedValueOnce(
          new Error(
            "database failure",
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
            analyzeRequest(),
          );

        expect(
          response.status,
        ).toBe(500);

        expect(
          analysisCache.get(
            createAnalysisCacheKey(
              currentIssue,
            ),
          ),
        ).toBeUndefined();
      },
    );

    it(
      "does not cache malformed Gemini output",
      async () => {
        const currentIssue =
          issue(
            "issue-1",
            "Crash on startup",
            "App crashes during boot.",
          );

        readyJob([
          currentIssue,
        ]);

        httpMocks.fetchWithTimeout.mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text:
                          "{ invalid json",
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "Content-Type":
                  "application/json",
              },
            },
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
            analyzeRequest(),
          );

        expect(
          response.status,
        ).toBe(500);

        expect(
          httpMocks.fetchWithTimeout,
        ).toHaveBeenCalledTimes(
          3,
        );

        expect(
          analysisCache.get(
            createAnalysisCacheKey(
              currentIssue,
            ),
          ),
        ).toBeUndefined();

        expect(
          prismaMocks.transaction,
        ).not.toHaveBeenCalled();
      },
    );
  },
);