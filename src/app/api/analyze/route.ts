import { randomUUID } from "node:crypto";

import {
  analysisCache,
  createAnalysisCacheKey,
  type CachedAnalysis,
} from "@/lib/analysis-cache";
import {
  fetchWithTimeout,
  isRetryableHttpStatus,
  retryDelayMs,
  wait,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const categorySchema = z.enum([
  "Bug",
  "Feature",
  "Documentation",
  "Performance",
  "Security",
  "Build",
  "Other",
]);

const prioritySchema = z.enum([
  "Critical",
  "High",
  "Medium",
  "Low",
]);

const effortSchema = z.enum([
  "Small",
  "Medium",
  "Large",
]);

const issueAnalysisSchema = z
  .object({
    issueId: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    category: categorySchema,
    priority: prioritySchema,
    effort: effortSchema,
    suggestedReply: z.string().trim().min(1),
  })
  .strict();

const geminiBatchSchema = z
  .object({
    issues: z.array(issueAnalysisSchema),
  })
  .strict();

type AnalysisInput = {
  id: string;
  title: string;
  body: string | null;
};

type AnalysisResult = z.infer<
  typeof issueAnalysisSchema
>;

const ANALYSIS_LEASE_MS =
  3 * 60 * 1000;

const GEMINI_TIMEOUT_MS = 30_000;
const GEMINI_RETRY_ATTEMPTS = 3;
const GEMINI_RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 5_000;
const GEMINI_BATCH_SIZE = 10;

class NonRetryableGeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name =
      "NonRetryableGeminiError";
  }
}

function createGeminiResponseSchema(
  issues: AnalysisInput[],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      issues: {
        type: "array",
        minItems: issues.length,
        maxItems: issues.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            issueId: {
              type: "string",
              enum: issues.map(
                (issue) => issue.id,
              ),
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
  };
}

function validateGeminiResult(
  rawResult: unknown,
  issues: AnalysisInput[],
) {
  const parsed =
    geminiBatchSchema.parse(
      rawResult,
    );

  if (
    parsed.issues.length !==
    issues.length
  ) {
    throw new Error(
      `Gemini returned ${parsed.issues.length} analyses for ${issues.length} issues.`,
    );
  }

  const expectedIssueIds =
    new Set(
      issues.map(
        (issue) => issue.id,
      ),
    );

  const returnedIssueIds =
    new Set<string>();

  for (
    const result of parsed.issues
  ) {
    if (
      !expectedIssueIds.has(
        result.issueId,
      )
    ) {
      throw new Error(
        `Gemini returned analysis for unexpected issue ${result.issueId}.`,
      );
    }

    if (
      returnedIssueIds.has(
        result.issueId,
      )
    ) {
      throw new Error(
        `Gemini returned duplicate analysis for issue ${result.issueId}.`,
      );
    }

    returnedIssueIds.add(
      result.issueId,
    );
  }

  for (
    const issueId of expectedIssueIds
  ) {
    if (
      !returnedIssueIds.has(
        issueId,
      )
    ) {
      throw new Error(
        `Gemini omitted analysis for issue ${issueId}.`,
      );
    }
  }

  return parsed;
}

function getRetryAfterMs(
  response: Response,
) {
  const retryAfter =
    response.headers.get(
      "retry-after",
    );

  if (!retryAfter) {
    return null;
  }

  const seconds =
    Number(retryAfter);

  if (
    Number.isFinite(seconds) &&
    seconds >= 0
  ) {
    return Math.min(
      seconds * 1000,
      MAX_RETRY_AFTER_MS,
    );
  }

  const retryAt =
    Date.parse(retryAfter);

  if (
    Number.isNaN(retryAt)
  ) {
    return null;
  }

  return Math.min(
    Math.max(
      0,
      retryAt - Date.now(),
    ),
    MAX_RETRY_AFTER_MS,
  );
}

async function geminiBatchWithRetry(
  issues: AnalysisInput[],
  signal?: AbortSignal,
  attempts =
    GEMINI_RETRY_ATTEMPTS,
) {
  for (
    let attempt = 1;
    attempt <= attempts;
    attempt++
  ) {
    try {
      const response =
        await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            signal,
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `
You are an expert software engineering triage assistant.

Analyze these GitHub issues and return ONLY valid JSON.

Return this exact JSON shape:
{
  "issues": [
    {
      "issueId": "same issue id given in input",
      "summary": "short plain-English summary",
      "category": "Bug | Feature | Documentation | Performance | Security | Build | Other",
      "priority": "Critical | High | Medium | Low",
      "effort": "Small | Medium | Large",
      "suggestedReply": "helpful maintainer response"
    }
  ]
}

Rules:
- Critical means the issue blocks builds, crashes the app, breaks authentication, causes data loss, or creates security risk.
- High means important user-facing bug or major broken behavior.
- Medium means meaningful but not blocking.
- Low means cosmetic, docs, minor cleanup, or unclear impact.
- Keep summaries short.
- Keep suggested replies concise and technical.
- Suggested replies should sound like a real maintainer comment on GitHub.
- Do not sound like customer support or an automated response.
- Do not start replies with "Thank you for reporting".
- Avoid generic phrases like:
  - "We appreciate your report"
  - "We will investigate this promptly"
  - "Sorry for the inconvenience"
- The first sentence should immediately discuss the technical issue.
- Mention relevant details from the issue when useful:
  - reproduction repo
  - regression version
  - suspected cause
  - workaround
  - proposed fix
- Return one analysis object for every input issue.

Issues:
${JSON.stringify(
  issues,
  null,
  2,
)}
`,
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType:
                  "application/json",
                responseJsonSchema:
                  createGeminiResponseSchema(
                    issues,
                  ),
              },
            }),
          },
          GEMINI_TIMEOUT_MS,
        );

      if (!response.ok) {
        const message =
          `Gemini request failed with status ${response.status}`;

        if (
          !isRetryableHttpStatus(
            response.status,
          )
        ) {
          throw new NonRetryableGeminiError(
            message,
          );
        }

        if (
          attempt === attempts
        ) {
          throw new Error(
            message,
          );
        }

        console.log(
          `Gemini batch attempt ${attempt} failed`,
        );

        const delay =
          getRetryAfterMs(
            response,
          ) ??
          retryDelayMs(
            attempt,
            GEMINI_RETRY_BASE_DELAY_MS,
          );

        await wait(delay);
        continue;
      }

      const data =
        await response.json();

      const content =
        data.candidates?.[0]
          ?.content?.parts?.[0]
          ?.text;

      if (
        !content ||
        typeof content !==
          "string"
      ) {
        throw new Error(
          "Gemini returned no content.",
        );
      }

      const parsedContent:
        unknown =
        JSON.parse(content);

      return validateGeminiResult(
        parsedContent,
        issues,
      );
    } catch (error) {
      if (
        error instanceof
        NonRetryableGeminiError
      ) {
        throw error;
      }

      if (
        signal?.aborted
      ) {
        throw error;
      }

      console.log(
        `Gemini batch attempt ${attempt} failed`,
      );

      if (
        attempt === attempts
      ) {
        throw error;
      }

      await wait(
        retryDelayMs(
          attempt,
          GEMINI_RETRY_BASE_DELAY_MS,
        ),
      );
    }
  }

  throw new Error(
    "Gemini batch failed after retries.",
  );
}

function toCachedAnalysis(
  result: AnalysisResult,
): CachedAnalysis {
  return {
    summary: result.summary,
    category: result.category,
    priority: result.priority,
    effort: result.effort,
    suggestedReply:
      result.suggestedReply,
  };
}

async function analyzeWithCache(
  issues: AnalysisInput[],
  signal?: AbortSignal,
) {
  const cachedByIssueId =
    new Map<
      string,
      AnalysisResult
    >();

  const missingIssues:
    AnalysisInput[] = [];

  for (
    const issue of issues
  ) {
    const key =
      createAnalysisCacheKey(
        issue,
      );

    const cached =
      analysisCache.get(key);

    if (!cached) {
      missingIssues.push(issue);
      continue;
    }

    cachedByIssueId.set(
      issue.id,
      {
        issueId: issue.id,
        ...cached,
      },
    );
  }

  const freshResults:
    AnalysisResult[] = [];

  for (
    let startIndex = 0;
    startIndex < missingIssues.length;
    startIndex += GEMINI_BATCH_SIZE
  ) {
    const batch =
      missingIssues.slice(
        startIndex,
        startIndex + GEMINI_BATCH_SIZE,
      );

    const freshBatch =
      await geminiBatchWithRetry(
        batch,
        signal,
      );

    freshResults.push(
      ...freshBatch.issues,
    );
  }

  const freshByIssueId =
    new Map(
      freshResults.map(
        (result) => [
          result.issueId,
          result,
        ],
      ),
    );

  const combined =
    issues.map((issue) => {
      const cached =
        cachedByIssueId.get(
          issue.id,
        );

      if (cached) {
        return cached;
      }

      const fresh =
        freshByIssueId.get(
          issue.id,
        );

      if (!fresh) {
        throw new Error(
          `Analysis result missing for issue ${issue.id}.`,
        );
      }

      return fresh;
    });

  const validated =
    validateGeminiResult(
      {
        issues: combined,
      },
      issues,
    );

  return {
    result: validated,
    freshIssueIds: new Set(
      freshResults.map(
        (result) =>
          result.issueId,
      ),
    ),
  };
}

async function releaseAnalysisLease(
  importJobId: string,
  leaseId: string,
) {
  try {
    await prisma.importJob.updateMany({
      where: {
        id: importJobId,
        status: "analyzing",
        analysisLeaseId:
          leaseId,
      },
      data: {
        status: "completed",
        analysisLeaseId: null,
        analysisStartedAt: null,
      },
    });
  } catch (error) {
    console.error(
      "ANALYSIS_LEASE_RELEASE_ERROR:",
      error,
    );
  }
}

export async function POST(
  request: Request,
) {
  let claimedImportJobId:
    | string
    | null = null;

  let analysisLeaseId:
    | string
    | null = null;

  try {
    const body: unknown =
      await request.json();

    const requestResult = z
      .object({
        importJobId: z
          .string()
          .trim()
          .min(1),
      })
      .safeParse(body);

    if (
      !requestResult.success
    ) {
      return Response.json(
        {
          success: false,
          error:
            "importJobId is required.",
        },
        {
          status: 400,
        },
      );
    }

    const { importJobId } =
      requestResult.data;

    if (
      !process.env
        .GEMINI_API_KEY
    ) {
      return Response.json(
        {
          success: false,
          error:
            "GEMINI_API_KEY is missing from .env.",
        },
        {
          status: 500,
        },
      );
    }

    const leaseId =
      randomUUID();

    const now =
      new Date();

    const staleBefore =
      new Date(
        now.getTime() -
          ANALYSIS_LEASE_MS,
      );

    const claimResult =
      await prisma.importJob.updateMany(
        {
          where: {
            id: importJobId,
            OR: [
              {
                status:
                  "completed",
              },
              {
                status:
                  "analyzing",
                analysisStartedAt:
                  {
                    lt: staleBefore,
                  },
              },
              {
                status:
                  "analyzing",
                analysisStartedAt:
                  null,
              },
            ],
          },
          data: {
            status:
              "analyzing",
            analysisLeaseId:
              leaseId,
            analysisStartedAt:
              now,
          },
        },
      );

    if (
      claimResult.count !== 1
    ) {
      const currentJob =
        await prisma.importJob.findUnique(
          {
            where: {
              id: importJobId,
            },
            select: {
              status: true,
            },
          },
        );

      if (!currentJob) {
        return Response.json(
          {
            success: false,
            error:
              "Import job not found.",
          },
          {
            status: 404,
          },
        );
      }

      if (
        currentJob.status ===
        "analyzed"
      ) {
        return Response.json({
          success: true,
          analyzedCount: 0,
          message:
            "All issues already analyzed.",
        });
      }

      if (
        currentJob.status ===
        "analyzing"
      ) {
        return Response.json(
          {
            success: false,
            error:
              "AI analysis is already in progress.",
          },
          {
            status: 409,
          },
        );
      }

      return Response.json(
        {
          success: false,
          error:
            "Import job is not ready for analysis.",
        },
        {
          status: 409,
        },
      );
    }

    claimedImportJobId =
      importJobId;

    analysisLeaseId =
      leaseId;

    const importJob =
      await prisma.importJob.findUnique(
        {
          where: {
            id: importJobId,
          },
          include: {
            repository: {
              include: {
                issues: {
                  include: {
                    analysis:
                      true,
                  },
                  orderBy: {
                    importedAt:
                      "desc",
                  },
                },
              },
            },
          },
        },
      );

    if (!importJob) {
      throw new Error(
        "Claimed import job disappeared.",
      );
    }

    const issuesNeedingAnalysis =
      importJob.repository.issues.filter(
        (issue) =>
          !issue.analysis,
      );

    if (
      issuesNeedingAnalysis.length ===
      0
    ) {
      const finalizeResult =
        await prisma.importJob.updateMany(
          {
            where: {
              id: importJobId,
              status:
                "analyzing",
              analysisLeaseId:
                leaseId,
            },
            data: {
              status:
                "analyzed",
              analysisLeaseId:
                null,
              analysisStartedAt:
                null,
            },
          },
        );

      if (
        finalizeResult.count !==
        1
      ) {
        throw new Error(
          "Analysis lease was lost before finalization.",
        );
      }

      claimedImportJobId =
        null;

      analysisLeaseId =
        null;

      return Response.json({
        success: true,
        repo:
          importJob.repository
            .fullName,
        analyzedCount: 0,
        message:
          "All issues already analyzed.",
      });
    }

    const aiInput =
      issuesNeedingAnalysis.map(
        (issue) => ({
          id: issue.id,
          title: issue.title,
          body: issue.body,
        }),
      );

    const {
      result: aiResult,
      freshIssueIds,
    } = await analyzeWithCache(
      aiInput,
      request.signal,
    );

    const savedAnalyses =
      await prisma.$transaction(
        async (tx) => {
          const saved = [];

          for (
            const result of
              aiResult.issues
          ) {
            const savedAnalysis =
              await tx.issueAnalysis.upsert(
                {
                  where: {
                    issueId:
                      result.issueId,
                  },
                  update: {
                    summary:
                      result.summary,
                    category:
                      result.category,
                    priority:
                      result.priority,
                    effort:
                      result.effort,
                    suggestedReply:
                      result.suggestedReply,
                  },
                  create: {
                    issueId:
                      result.issueId,
                    summary:
                      result.summary,
                    category:
                      result.category,
                    priority:
                      result.priority,
                    effort:
                      result.effort,
                    suggestedReply:
                      result.suggestedReply,
                  },
                },
              );

            saved.push(
              savedAnalysis,
            );
          }

          const finalizeResult =
            await tx.importJob.updateMany(
              {
                where: {
                  id: importJobId,
                  status:
                    "analyzing",
                  analysisLeaseId:
                    leaseId,
                },
                data: {
                  status:
                    "analyzed",
                  analysisLeaseId:
                    null,
                  analysisStartedAt:
                    null,
                },
              },
            );

          if (
            finalizeResult.count !==
            1
          ) {
            throw new Error(
              "Analysis lease was lost before persistence completed.",
            );
          }

          return saved;
        },
        {
          maxWait: 5_000,
          timeout: 10_000,
        },
      );

    for (
      const issue of aiInput
    ) {
      if (
        !freshIssueIds.has(
          issue.id,
        )
      ) {
        continue;
      }

      const result =
        aiResult.issues.find(
          (analysis) =>
            analysis.issueId ===
            issue.id,
        );

      if (!result) {
        continue;
      }

      analysisCache.set(
        createAnalysisCacheKey(
          issue,
        ),
        toCachedAnalysis(
          result,
        ),
      );
    }

    claimedImportJobId =
      null;

    analysisLeaseId =
      null;

    return Response.json({
      success: true,
      repo:
        importJob.repository
          .fullName,
      analyzedCount:
        savedAnalyses.length,
      analyses:
        savedAnalyses,
    });
  } catch (error) {
    if (
      claimedImportJobId &&
      analysisLeaseId
    ) {
      await releaseAnalysisLease(
        claimedImportJobId,
        analysisLeaseId,
      );
    }

    console.error(
      "ANALYZE_ERROR:",
      error,
    );

    return Response.json(
      {
        success: false,
        error:
          "AI analysis failed. This may be a temporary model limit or connection issue.",
      },
      {
        status: 500,
      },
    );
  }
}