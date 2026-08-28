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

const prioritySchema = z.enum(["Critical", "High", "Medium", "Low"]);

const effortSchema = z.enum(["Small", "Medium", "Large"]);

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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGeminiResponseSchema(issues: AnalysisInput[]) {
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
              enum: issues.map((issue) => issue.id),
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
  };
}

function validateGeminiResult(rawResult: unknown, issues: AnalysisInput[]) {
  const parsed = geminiBatchSchema.parse(rawResult);

  if (parsed.issues.length !== issues.length) {
    throw new Error(
      `Gemini returned ${parsed.issues.length} analyses for ${issues.length} issues.`
    );
  }

  const expectedIssueIds = new Set(issues.map((issue) => issue.id));
  const returnedIssueIds = new Set<string>();

  for (const result of parsed.issues) {
    if (!expectedIssueIds.has(result.issueId)) {
      throw new Error(
        `Gemini returned analysis for unexpected issue ${result.issueId}.`
      );
    }

    if (returnedIssueIds.has(result.issueId)) {
      throw new Error(
        `Gemini returned duplicate analysis for issue ${result.issueId}.`
      );
    }

    returnedIssueIds.add(result.issueId);
  }

  for (const issueId of expectedIssueIds) {
    if (!returnedIssueIds.has(issueId)) {
      throw new Error(`Gemini omitted analysis for issue ${issueId}.`);
    }
  }

  return parsed;
}

async function geminiBatchWithRetry(
  issues: AnalysisInput[],
  attempts = 3
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
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
                    ${JSON.stringify(issues, null, 2)}
                    `,
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: createGeminiResponseSchema(issues),
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini request failed with status ${response.status}`);
      }

      const data = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!content || typeof content !== "string") {
        throw new Error("Gemini returned no content.");
      }

      const parsedContent: unknown = JSON.parse(content);

      return validateGeminiResult(parsedContent, issues);
    } catch (error) {
      console.log(`Gemini batch attempt ${attempt} failed`);

      if (attempt === attempts) {
        throw error;
      }

      await wait(2000 * attempt);
    }
  }

  throw new Error("Gemini batch failed after retries.");
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();

    const requestResult = z
      .object({
        importJobId: z.string().trim().min(1),
      })
      .safeParse(body);

    if (!requestResult.success) {
      return Response.json(
        { success: false, error: "importJobId is required." },
        { status: 400 }
      );
    }

    const { importJobId } = requestResult.data;

    if (!process.env.GEMINI_API_KEY) {
      return Response.json(
        { success: false, error: "GEMINI_API_KEY is missing from .env." },
        { status: 500 }
      );
    }

    const importJob = await prisma.importJob.findUnique({
      where: {
        id: importJobId,
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

    if (!importJob) {
      return Response.json(
        { success: false, error: "Import job not found." },
        { status: 404 }
      );
    }

    const issuesNeedingAnalysis = importJob.repository.issues.filter(
      (issue) => !issue.analysis
    );

    if (issuesNeedingAnalysis.length === 0) {
      return Response.json({
        success: true,
        repo: importJob.repository.fullName,
        analyzedCount: 0,
        message: "All issues already analyzed.",
      });
    }

    const aiInput = issuesNeedingAnalysis.map((issue) => ({
      id: issue.id,
      title: issue.title,
      body: issue.body,
    }));

    const aiResult = await geminiBatchWithRetry(aiInput);

    const savedAnalyses = await prisma.$transaction(
      aiResult.issues.map((result) =>
        prisma.issueAnalysis.upsert({
          where: {
            issueId: result.issueId,
          },
          update: {
            summary: result.summary,
            category: result.category,
            priority: result.priority,
            effort: result.effort,
            suggestedReply: result.suggestedReply,
          },
          create: {
            issueId: result.issueId,
            summary: result.summary,
            category: result.category,
            priority: result.priority,
            effort: result.effort,
            suggestedReply: result.suggestedReply,
          },
        })
      )
    );

    return Response.json({
      success: true,
      repo: importJob.repository.fullName,
      analyzedCount: savedAnalyses.length,
      analyses: savedAnalyses,
    });
  } catch (error) {
    console.error("ANALYZE_ERROR:", error);

    return Response.json(
      {
        success: false,
        error:
          "AI analysis failed. This may be a temporary model limit or connection issue.",
      },
      { status: 500 }
    );
  }
}