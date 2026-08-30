import {
  describe,
  expect,
  it,
} from "vitest";
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

const analysisSchema = z
  .object({
    issueId: z
      .string()
      .trim()
      .min(1),
    summary: z
      .string()
      .trim()
      .min(1),
    category:
      categorySchema,
    priority:
      prioritySchema,
    effort:
      effortSchema,
    suggestedReply: z
      .string()
      .trim()
      .min(1),
  })
  .strict();

const analysisBatchSchema = z
  .object({
    issues: z.array(
      analysisSchema,
    ),
  })
  .strict();

type Category = z.infer<
  typeof categorySchema
>;

type Priority = z.infer<
  typeof prioritySchema
>;

type Effort = z.infer<
  typeof effortSchema
>;

type EvaluationIssue = {
  id: string;
  title: string;
  body: string;
  expected: {
    category: Category;
    priority: Priority;
    effort: Effort;
    summaryMustInclude:
      string[];
    replyMustInclude:
      string[];
  };
};

type Analysis = z.infer<
  typeof analysisSchema
>;

type EvaluationResult = {
  totalIssues: number;
  passedIssues: number;
  failures: string[];
};

const evaluationIssues:
  EvaluationIssue[] = [
  {
    id: "eval-crash",
    title:
      "Application crashes on startup after 4.8.0",
    body:
      "After upgrading from 4.7.3 to 4.8.0 the application exits during initialization before the UI is rendered. Reverting to 4.7.3 fixes the problem.",
    expected: {
      category: "Bug",
      priority:
        "Critical",
      effort: "Medium",
      summaryMustInclude: [
        "startup",
        "4.8.0",
      ],
      replyMustInclude: [
        "4.8.0",
        "initialization",
      ],
    },
  },
  {
    id: "eval-security",
    title:
      "Authorization bypass on project export endpoint",
    body:
      "A user with read-only project access can call the export endpoint directly and download private project data that should require admin permission.",
    expected: {
      category:
        "Security",
      priority:
        "Critical",
      effort: "Medium",
      summaryMustInclude: [
        "authorization",
        "export",
      ],
      replyMustInclude: [
        "permission",
        "export",
      ],
    },
  },
  {
    id: "eval-feature",
    title:
      "Allow repository owners to archive completed projects",
    body:
      "Add an archive action so completed projects can be hidden from the active project list without deleting their history.",
    expected: {
      category:
        "Feature",
      priority: "Medium",
      effort: "Medium",
      summaryMustInclude: [
        "archive",
        "projects",
      ],
      replyMustInclude: [
        "archive",
        "history",
      ],
    },
  },
  {
    id: "eval-docs",
    title:
      "Installation guide omits database migration command",
    body:
      "Fresh installations fail because the setup guide goes directly from installing dependencies to starting the server and never mentions running the database migration.",
    expected: {
      category:
        "Documentation",
      priority: "Low",
      effort: "Small",
      summaryMustInclude: [
        "installation",
        "migration",
      ],
      replyMustInclude: [
        "migration",
        "guide",
      ],
    },
  },
  {
    id: "eval-performance",
    title:
      "Dashboard becomes slow with 500 projects",
    body:
      "The dashboard takes around 12 seconds to load when an organization has roughly 500 projects. Profiling suggests the project list triggers repeated database queries.",
    expected: {
      category:
        "Performance",
      priority: "High",
      effort: "Large",
      summaryMustInclude: [
        "dashboard",
        "500",
      ],
      replyMustInclude: [
        "queries",
        "database",
      ],
    },
  },
  {
    id: "eval-build",
    title:
      "CI build fails on Node 24",
    body:
      "The GitHub Actions build started failing after the runner moved to Node 24. Local Node 22 builds still succeed. The failure occurs during the production build command.",
    expected: {
      category: "Build",
      priority:
        "Critical",
      effort: "Medium",
      summaryMustInclude: [
        "Node 24",
        "build",
      ],
      replyMustInclude: [
        "Node 24",
        "build",
      ],
    },
  },
  {
    id: "eval-ambiguous",
    title:
      "Button sometimes feels weird",
    body:
      "The save button occasionally feels delayed but there are no reproduction steps, timings, browser details, logs, or screenshots.",
    expected: {
      category: "Other",
      priority: "Low",
      effort: "Small",
      summaryMustInclude: [
        "save",
        "delay",
      ],
      replyMustInclude: [
        "reproduction",
        "timing",
      ],
    },
  },
];

const candidateAnalyses:
  Analysis[] = [
  {
    issueId:
      "eval-crash",
    summary:
      "Startup crashes after upgrading to 4.8.0.",
    category: "Bug",
    priority:
      "Critical",
    effort: "Medium",
    suggestedReply:
      "The 4.8.0 regression appears to fail during initialization. A minimal reproduction or failing initialization stack trace would help isolate the changed startup path.",
  },
  {
    issueId:
      "eval-security",
    summary:
      "Authorization checks are missing from the project export path.",
    category:
      "Security",
    priority:
      "Critical",
    effort: "Medium",
    suggestedReply:
      "The export endpoint should enforce the same admin permission check as the protected project actions before returning private data.",
  },
  {
    issueId:
      "eval-feature",
    summary:
      "Projects need an archive state that preserves history.",
    category:
      "Feature",
    priority: "Medium",
    effort: "Medium",
    suggestedReply:
      "An archive state can hide completed projects from the active list while preserving their existing history and records.",
  },
  {
    issueId:
      "eval-docs",
    summary:
      "The installation guide is missing the database migration step.",
    category:
      "Documentation",
    priority: "Low",
    effort: "Small",
    suggestedReply:
      "The setup guide should include the required migration command before the server-start step so fresh installations initialize the database correctly.",
  },
  {
    issueId:
      "eval-performance",
    summary:
      "Dashboard loading degrades around 500 projects because of repeated database work.",
    category:
      "Performance",
    priority: "High",
    effort: "Large",
    suggestedReply:
      "The repeated database queries should be profiled and consolidated before optimizing rendering because the query pattern appears to dominate the dashboard load time.",
  },
  {
    issueId:
      "eval-build",
    summary:
      "The production build fails on Node 24 while Node 22 succeeds.",
    category: "Build",
    priority:
      "Critical",
    effort: "Medium",
    suggestedReply:
      "The Node 24 build failure should be reproduced against the production build command and compared with Node 22 to isolate the incompatible dependency or runtime behavior.",
  },
  {
    issueId:
      "eval-ambiguous",
    summary:
      "The save action has an intermittent delay with insufficient diagnostic detail.",
    category: "Other",
    priority: "Low",
    effort: "Small",
    suggestedReply:
      "Please provide reproduction steps, browser details, and timing measurements for the save delay so the affected path can be identified.",
  },
];

function normalize(
  value: string,
) {
  return value.toLowerCase();
}

function containsAll(
  value: string,
  required:
    string[],
) {
  const normalized =
    normalize(value);

  return required.every(
    (term) =>
      normalized.includes(
        normalize(term),
      ),
  );
}

function validateCoverage(
  rawResult: unknown,
  issues:
    EvaluationIssue[],
) {
  const parsed =
    analysisBatchSchema.parse(
      rawResult,
    );

  if (
    parsed.issues.length !==
    issues.length
  ) {
    throw new Error(
      `Expected ${issues.length} analyses but received ${parsed.issues.length}.`,
    );
  }

  const expectedIds =
    new Set(
      issues.map(
        (issue) =>
          issue.id,
      ),
    );

  const returnedIds =
    new Set<string>();

  for (
    const result of
      parsed.issues
  ) {
    if (
      !expectedIds.has(
        result.issueId,
      )
    ) {
      throw new Error(
        `Unexpected issue ID: ${result.issueId}.`,
      );
    }

    if (
      returnedIds.has(
        result.issueId,
      )
    ) {
      throw new Error(
        `Duplicate issue ID: ${result.issueId}.`,
      );
    }

    returnedIds.add(
      result.issueId,
    );
  }

  for (
    const issueId of
      expectedIds
  ) {
    if (
      !returnedIds.has(
        issueId,
      )
    ) {
      throw new Error(
        `Missing analysis for issue ID: ${issueId}.`,
      );
    }
  }

  return parsed.issues;
}

function evaluateTriageBatch(
  rawResult: unknown,
  issues:
    EvaluationIssue[],
): EvaluationResult {
  const results =
    validateCoverage(
      rawResult,
      issues,
    );

  const byIssueId =
    new Map(
      results.map(
        (result) => [
          result.issueId,
          result,
        ],
      ),
    );

  const failures:
    string[] = [];

  let passedIssues = 0;

  for (
    const issue of issues
  ) {
    const result =
      byIssueId.get(
        issue.id,
      );

    if (!result) {
      failures.push(
        `${issue.id}: result missing after coverage validation.`,
      );

      continue;
    }

    const issueFailures:
      string[] = [];

    if (
      result.category !==
      issue.expected
        .category
    ) {
      issueFailures.push(
        `category expected ${issue.expected.category} but received ${result.category}`,
      );
    }

    if (
      result.priority !==
      issue.expected
        .priority
    ) {
      issueFailures.push(
        `priority expected ${issue.expected.priority} but received ${result.priority}`,
      );
    }

    if (
      result.effort !==
      issue.expected.effort
    ) {
      issueFailures.push(
        `effort expected ${issue.expected.effort} but received ${result.effort}`,
      );
    }

    if (
      !containsAll(
        result.summary,
        issue.expected
          .summaryMustInclude,
      )
    ) {
      issueFailures.push(
        `summary is missing expected issue-specific details`,
      );
    }

    if (
      !containsAll(
        result.suggestedReply,
        issue.expected
          .replyMustInclude,
      )
    ) {
      issueFailures.push(
        `suggested reply is missing expected technical guidance`,
      );
    }

    if (
      result.summary.length >
      180
    ) {
      issueFailures.push(
        "summary is too long",
      );
    }

    if (
      result.suggestedReply
        .length > 500
    ) {
      issueFailures.push(
        "suggested reply is too long",
      );
    }

    if (
      normalize(
        result.suggestedReply,
      ).startsWith(
        "thank you for reporting",
      )
    ) {
      issueFailures.push(
        "suggested reply uses prohibited generic support language",
      );
    }

    if (
      normalize(
        result.suggestedReply,
      ).includes(
        "we appreciate your report",
      ) ||
      normalize(
        result.suggestedReply,
      ).includes(
        "sorry for the inconvenience",
      ) ||
      normalize(
        result.suggestedReply,
      ).includes(
        "we will investigate this promptly",
      )
    ) {
      issueFailures.push(
        "suggested reply uses prohibited generic support language",
      );
    }

    if (
      issueFailures.length ===
      0
    ) {
      passedIssues += 1;
      continue;
    }

    for (
      const failure of
        issueFailures
    ) {
      failures.push(
        `${issue.id}: ${failure}`,
      );
    }
  }

  return {
    totalIssues:
      issues.length,
    passedIssues,
    failures,
  };
}

describe(
  "deterministic AI triage evaluation",
  () => {
    it(
      "passes the complete golden evaluation set",
      () => {
        const result =
          evaluateTriageBatch(
            {
              issues:
                candidateAnalyses,
            },
            evaluationIssues,
          );

        expect(
          result.failures,
        ).toEqual([]);

        expect(
          result.passedIssues,
        ).toBe(
          result.totalIssues,
        );

        expect(
          result.totalIssues,
        ).toBe(7);
      },
    );

    it(
      "covers crash, security, feature, documentation, performance, build, and ambiguous issues",
      () => {
        expect(
          evaluationIssues.map(
            (issue) =>
              issue.expected
                .category,
          ),
        ).toEqual([
          "Bug",
          "Security",
          "Feature",
          "Documentation",
          "Performance",
          "Build",
          "Other",
        ]);
      },
    );

    it(
      "rejects malformed analysis objects",
      () => {
        expect(() =>
          validateCoverage(
            {
              issues: [
                {
                  issueId:
                    "eval-crash",
                  summary:
                    "Crash.",
                  category:
                    "Bug",
                  priority:
                    "Urgent",
                  effort:
                    "Medium",
                  suggestedReply:
                    "Investigate the regression.",
                },
              ],
            },
            [
              evaluationIssues[0],
            ],
          ),
        ).toThrow();
      },
    );

    it(
      "rejects an unknown issue ID",
      () => {
        expect(() =>
          validateCoverage(
            {
              issues: [
                {
                  ...candidateAnalyses[0],
                  issueId:
                    "unknown-issue",
                },
              ],
            },
            [
              evaluationIssues[0],
            ],
          ),
        ).toThrow(
          "Unexpected issue ID",
        );
      },
    );

    it(
      "rejects duplicate issue IDs",
      () => {
        expect(() =>
          validateCoverage(
            {
              issues: [
                candidateAnalyses[0],
                candidateAnalyses[0],
              ],
            },
            [
              evaluationIssues[0],
              evaluationIssues[1],
            ],
          ),
        ).toThrow();
      },
    );

    it(
      "rejects incomplete issue coverage",
      () => {
        expect(() =>
          validateCoverage(
            {
              issues: [
                candidateAnalyses[0],
              ],
            },
            [
              evaluationIssues[0],
              evaluationIssues[1],
            ],
          ),
        ).toThrow(
          "Expected 2 analyses but received 1.",
        );
      },
    );

    it(
      "fails an incorrect classification even when the schema is valid",
      () => {
        const result =
          evaluateTriageBatch(
            {
              issues: [
                {
                  ...candidateAnalyses[0],
                  category:
                    "Feature",
                },
              ],
            },
            [
              evaluationIssues[0],
            ],
          );

        expect(
          result.passedIssues,
        ).toBe(0);

        expect(
          result.failures,
        ).toContain(
          "eval-crash: category expected Bug but received Feature",
        );
      },
    );

    it(
      "fails an incorrect priority even when the schema is valid",
      () => {
        const result =
          evaluateTriageBatch(
            {
              issues: [
                {
                  ...candidateAnalyses[1],
                  priority:
                    "Low",
                },
              ],
            },
            [
              evaluationIssues[1],
            ],
          );

        expect(
          result.passedIssues,
        ).toBe(0);

        expect(
          result.failures,
        ).toContain(
          "eval-security: priority expected Critical but received Low",
        );
      },
    );

    it(
      "fails an incorrect effort estimate even when the schema is valid",
      () => {
        const result =
          evaluateTriageBatch(
            {
              issues: [
                {
                  ...candidateAnalyses[4],
                  effort:
                    "Small",
                },
              ],
            },
            [
              evaluationIssues[4],
            ],
          );

        expect(
          result.passedIssues,
        ).toBe(0);

        expect(
          result.failures,
        ).toContain(
          "eval-performance: effort expected Large but received Small",
        );
      },
    );

    it(
      "fails generic summaries that omit issue-specific evidence",
      () => {
        const result =
          evaluateTriageBatch(
            {
              issues: [
                {
                  ...candidateAnalyses[0],
                  summary:
                    "There is a problem with the application.",
                },
              ],
            },
            [
              evaluationIssues[0],
            ],
          );

        expect(
          result.passedIssues,
        ).toBe(0);

        expect(
          result.failures,
        ).toContain(
          "eval-crash: summary is missing expected issue-specific details",
        );
      },
    );

    it(
      "fails replies that omit useful technical guidance",
      () => {
        const result =
          evaluateTriageBatch(
            {
              issues: [
                {
                  ...candidateAnalyses[5],
                  suggestedReply:
                    "We will look into this.",
                },
              ],
            },
            [
              evaluationIssues[5],
            ],
          );

        expect(
          result.passedIssues,
        ).toBe(0);

        expect(
          result.failures,
        ).toContain(
          "eval-build: suggested reply is missing expected technical guidance",
        );
      },
    );

    it(
      "fails prohibited generic support language",
      () => {
        const result =
          evaluateTriageBatch(
            {
              issues: [
                {
                  ...candidateAnalyses[3],
                  suggestedReply:
                    "Thank you for reporting this. The migration command should be added to the installation guide.",
                },
              ],
            },
            [
              evaluationIssues[3],
            ],
          );

        expect(
          result.passedIssues,
        ).toBe(0);

        expect(
          result.failures,
        ).toContain(
          "eval-docs: suggested reply uses prohibited generic support language",
        );
      },
    );

    it(
      "fails empty required analysis text through schema validation",
      () => {
        expect(() =>
          validateCoverage(
            {
              issues: [
                {
                  ...candidateAnalyses[0],
                  summary: "   ",
                },
              ],
            },
            [
              evaluationIssues[0],
            ],
          ),
        ).toThrow();
      },
    );
  },
);