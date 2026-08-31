import {
  fetchWithTimeout,
  isRetryableHttpStatus,
  retryDelayMs,
  wait,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const githubRepositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  owner: z.object({
    login: z.string().min(1),
  }),
});

const githubIssueSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string().min(1),
  html_url: z.string().url(),
  created_at: z.string().datetime(),
  user: z.object({
    login: z.string().min(1),
  }),
  pull_request: z.unknown().optional(),
});

const githubIssuesPageSchema =
  z.array(githubIssueSchema);

type GitHubRepositoryResponse =
  z.infer<
    typeof githubRepositorySchema
  >;

type GitHubIssueResponse =
  z.infer<
    typeof githubIssueSchema
  >;

type GitHubIssuesFetchResult =
  | {
      success: true;
      issues:
        GitHubIssueResponse[];
    }
  | {
      success: false;
      response: Response;
    };

type ParsedRepositoryUrl = {
  owner: string;
  repoName: string;
};

const GITHUB_TIMEOUT_MS = 8_000;
const GITHUB_RETRY_ATTEMPTS = 3;
const GITHUB_RETRY_BASE_DELAY_MS =
  500;
const MAX_RETRY_AFTER_MS = 5_000;

const GITHUB_ISSUES_PER_PAGE = 100;
const DEFAULT_MAX_IMPORTED_ISSUES =
  100;
const HARD_MAX_IMPORTED_ISSUES =
  500;
const MAX_GITHUB_ISSUE_PAGES = 10;

const ANALYSIS_LEASE_MS =
  3 * 60 * 1000;

const GITHUB_API_VERSION =
  "2026-03-10";

const GITHUB_REQUEST_HEADERS = {
  Accept:
    "application/vnd.github+json",
  "X-GitHub-Api-Version":
    GITHUB_API_VERSION,
  "User-Agent":
    "ai-issue-triage-dashboard",
};

class ActiveAnalysisConflictError extends Error {
  constructor() {
    super(
      "A current analysis is still running for this repository.",
    );

    this.name =
      "ActiveAnalysisConflictError";
  }
}

function parseGitHubRepositoryUrl(
  value: string,
): ParsedRepositoryUrl | null {
  try {
    const url =
      new URL(value);

    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !==
        "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    const pathSegments =
      url.pathname
        .split("/")
        .filter(Boolean);

    if (
      pathSegments.length !== 2
    ) {
      return null;
    }

    const owner =
      pathSegments[0];

    const rawRepoName =
      pathSegments[1];

    const repoName =
      rawRepoName.endsWith(
        ".git",
      )
        ? rawRepoName.slice(
            0,
            -4,
          )
        : rawRepoName;

    if (
      !owner ||
      !repoName
    ) {
      return null;
    }

    return {
      owner,
      repoName,
    };
  } catch {
    return null;
  }
}

function getMaxImportedIssues() {
  const configuredLimit =
    Number.parseInt(
      process.env
        .GITHUB_IMPORT_MAX_ISSUES ??
        "",
      10,
    );

  if (
    !Number.isInteger(
      configuredLimit,
    ) ||
    configuredLimit <= 0
  ) {
    return DEFAULT_MAX_IMPORTED_ISSUES;
  }

  return Math.min(
    configuredLimit,
    HARD_MAX_IMPORTED_ISSUES,
  );
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

function isGitHubRateLimited(
  response: Response,
) {
  if (
    response.status === 429
  ) {
    return true;
  }

  if (
    response.status !== 403
  ) {
    return false;
  }

  return (
    response.headers.get(
      "x-ratelimit-remaining",
    ) === "0" ||
    response.headers.has(
      "retry-after",
    )
  );
}

function githubApiUrl(
  owner: string,
  repoName: string,
  suffix = "",
) {
  const encodedOwner =
    encodeURIComponent(owner);

  const encodedRepo =
    encodeURIComponent(repoName);

  return (
    `https://api.github.com/repos/` +
    `${encodedOwner}/${encodedRepo}` +
    suffix
  );
}

async function fetchGitHubWithRetry(
  url: string,
  signal?: AbortSignal,
  attempts =
    GITHUB_RETRY_ATTEMPTS,
) {
  for (
    let attempt = 1;
    attempt <= attempts;
    attempt++
  ) {
    try {
      const response =
        await fetchWithTimeout(
          url,
          {
            headers:
              GITHUB_REQUEST_HEADERS,
            signal,
          },
          GITHUB_TIMEOUT_MS,
        );

      const retryable =
        isRetryableHttpStatus(
          response.status,
        ) ||
        isGitHubRateLimited(
          response,
        );

      if (
        !retryable ||
        attempt === attempts
      ) {
        return response;
      }

      const delay =
        getRetryAfterMs(
          response,
        ) ??
        retryDelayMs(
          attempt,
          GITHUB_RETRY_BASE_DELAY_MS,
        );

      await wait(delay);
    } catch (error) {
      if (
        signal?.aborted
      ) {
        throw error;
      }

      if (
        attempt === attempts
      ) {
        throw error;
      }

      await wait(
        retryDelayMs(
          attempt,
          GITHUB_RETRY_BASE_DELAY_MS,
        ),
      );
    }
  }

  throw new Error(
    "GitHub request failed after retries.",
  );
}

async function fetchRealGitHubIssues(
  owner: string,
  repoName: string,
  signal?: AbortSignal,
): Promise<GitHubIssuesFetchResult> {
  const maxImportedIssues =
    getMaxImportedIssues();

  const realIssues:
    GitHubIssueResponse[] = [];

  const seenIssueIds =
    new Set<number>();

  let page = 1;

  while (
    realIssues.length <
      maxImportedIssues &&
    page <=
      MAX_GITHUB_ISSUE_PAGES
  ) {
    const issuesResponse =
      await fetchGitHubWithRetry(
        githubApiUrl(
          owner,
          repoName,
          `/issues?state=open&per_page=${GITHUB_ISSUES_PER_PAGE}&page=${page}`,
        ),
        signal,
      );

    if (
      isGitHubRateLimited(
        issuesResponse,
      )
    ) {
      return {
        success: false,
        response:
          Response.json(
            {
              success: false,
              error:
                "GitHub API rate limit reached. Please try again later.",
            },
            {
              status: 429,
            },
          ),
      };
    }

    if (
      !issuesResponse.ok
    ) {
      return {
        success: false,
        response:
          Response.json(
            {
              success: false,
              error:
                "GitHub issues are temporarily unavailable.",
            },
            {
              status: 502,
            },
          ),
      };
    }

    const pageData:
      unknown =
      await issuesResponse.json();

    const pageResult =
      githubIssuesPageSchema.safeParse(
        pageData,
      );

    if (
      !pageResult.success
    ) {
      console.error(
        "GITHUB_ISSUES_VALIDATION_ERROR:",
        pageResult.error,
      );

      return {
        success: false,
        response:
          Response.json(
            {
              success: false,
              error:
                "GitHub issues are temporarily unavailable.",
            },
            {
              status: 502,
            },
          ),
      };
    }

    const pageIssues =
      pageResult.data;

    for (
      const issue of
      pageIssues
    ) {
      if (
        issue.pull_request
      ) {
        continue;
      }

      if (
        seenIssueIds.has(
          issue.id,
        )
      ) {
        continue;
      }

      seenIssueIds.add(
        issue.id,
      );

      realIssues.push(
        issue,
      );

      if (
        realIssues.length >=
        maxImportedIssues
      ) {
        break;
      }
    }

    if (
      pageIssues.length <
        GITHUB_ISSUES_PER_PAGE ||
      realIssues.length >=
        maxImportedIssues
    ) {
      break;
    }

    page += 1;
  }

  return {
    success: true,
    issues: realIssues,
  };
}

async function cleanupOldSessions() {
  const now =
    Date.now();

  const oneHourAgo =
    new Date(
      now -
        60 *
          60 *
          1000,
    );

  const staleAnalysisBefore =
    new Date(
      now -
        ANALYSIS_LEASE_MS,
    );

  const safeToDeleteFilter = {
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
        analysisStartedAt: {
          lt:
            staleAnalysisBefore,
        },
      },
    ],
  };

  const oldImportJobs =
    await prisma.importJob.findMany({
      where: {
        startedAt: {
          lt:
            oneHourAgo,
        },
        ...safeToDeleteFilter,
      },
      select: {
        id: true,
        repositoryId:
          true,
      },
    });

  if (
    oldImportJobs.length === 0
  ) {
    return;
  }

  const oldImportJobIds =
    oldImportJobs.map(
      (job) =>
        job.id,
    );

  const possibleOldRepositoryIds = [
    ...new Set(
      oldImportJobs.map(
        (job) =>
          job.repositoryId,
      ),
    ),
  ];

  await prisma.importJob.deleteMany({
    where: {
      id: {
        in:
          oldImportJobIds,
      },
      ...safeToDeleteFilter,
    },
  });

  const repositoriesStillInUse =
    await prisma.importJob.findMany({
      where: {
        repositoryId: {
          in:
            possibleOldRepositoryIds,
        },
      },
      select: {
        repositoryId:
          true,
      },
    });

  const stillUsedRepositoryIds =
    new Set(
      repositoriesStillInUse.map(
        (job) =>
          job.repositoryId,
      ),
    );

  const repositoryIdsToDelete =
    possibleOldRepositoryIds.filter(
      (
        repositoryId,
      ) =>
        !stillUsedRepositoryIds.has(
          repositoryId,
        ),
    );

  if (
    repositoryIdsToDelete.length ===
    0
  ) {
    return;
  }

  await prisma.issueAnalysis.deleteMany({
    where: {
      issue: {
        is: {
          repositoryId: {
            in:
              repositoryIdsToDelete,
          },
        },
      },
    },
  });

  await prisma.issue.deleteMany({
    where: {
      repositoryId: {
        in:
          repositoryIdsToDelete,
      },
    },
  });

  await prisma.repository.deleteMany({
    where: {
      id: {
        in:
          repositoryIdsToDelete,
      },
    },
  });
}

export async function POST(
  request: Request,
) {
  try {
    const body:
      unknown =
      await request.json();

    if (
      !body ||
      typeof body !==
        "object" ||
      !(
        "repoUrl" in
        body
      ) ||
      typeof body.repoUrl !==
        "string"
    ) {
      return Response.json(
        {
          success: false,
          error:
            "Repository URL is required.",
        },
        {
          status: 400,
        },
      );
    }

    const cleanRepoUrl =
      body.repoUrl.trim();

    const parsedRepository =
      parseGitHubRepositoryUrl(
        cleanRepoUrl,
      );

    if (
      !parsedRepository
    ) {
      return Response.json(
        {
          success: false,
          error:
            "Please enter a valid GitHub repository URL.",
        },
        {
          status: 400,
        },
      );
    }

    const {
      owner,
      repoName,
    } =
      parsedRepository;

    await cleanupOldSessions();

    const githubResponse =
      await fetchGitHubWithRetry(
        githubApiUrl(
          owner,
          repoName,
        ),
        request.signal,
      );

    if (
      githubResponse.status ===
      404
    ) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub repository could not be found.",
        },
        {
          status: 404,
        },
      );
    }

    if (
      isGitHubRateLimited(
        githubResponse,
      )
    ) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub API rate limit reached. Please try again later.",
        },
        {
          status: 429,
        },
      );
    }

    if (
      !githubResponse.ok
    ) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub repository lookup is temporarily unavailable.",
        },
        {
          status: 502,
        },
      );
    }

    const rawRepoData:
      unknown =
      await githubResponse.json();

    const repoResult =
      githubRepositorySchema.safeParse(
        rawRepoData,
      );

    if (
      !repoResult.success
    ) {
      console.error(
        "GITHUB_REPOSITORY_VALIDATION_ERROR:",
        repoResult.error,
      );

      return Response.json(
        {
          success: false,
          error:
            "GitHub repository data is temporarily unavailable.",
        },
        {
          status: 502,
        },
      );
    }

    const repoData:
      GitHubRepositoryResponse =
      repoResult.data;

    const issuesResult =
      await fetchRealGitHubIssues(
        owner,
        repoName,
        request.signal,
      );

    if (
      !issuesResult.success
    ) {
      return (
        issuesResult.response
      );
    }

    const realIssues =
      issuesResult.issues;

    const repositoryGithubId =
      BigInt(
        repoData.id,
      );

    const importedGitHubIssueIds =
      realIssues.map(
        (issue) =>
          BigInt(
            issue.id,
          ),
      );

    const staleAnalysisBefore =
      new Date(
        Date.now() -
          ANALYSIS_LEASE_MS,
      );

    const {
      repository,
      importJob,
      savedIssues,
    } =
      await prisma.$transaction(
        async (tx) => {
          const existingRepository =
            await tx.repository.findUnique(
              {
                where: {
                  githubId:
                    repositoryGithubId,
                },
                select: {
                  id: true,
                },
              },
            );

          if (
            existingRepository
          ) {
            const activeAnalysis =
              await tx.importJob.findFirst(
                {
                  where: {
                    repositoryId:
                      existingRepository.id,
                    status:
                      "analyzing",
                    analysisStartedAt:
                      {
                        gte:
                          staleAnalysisBefore,
                      },
                  },
                  select: {
                    id: true,
                  },
                },
              );

            if (
              activeAnalysis
            ) {
              throw new ActiveAnalysisConflictError();
            }
          }

          const repository =
            await tx.repository.upsert(
              {
                where: {
                  githubId:
                    repositoryGithubId,
                },
                update: {
                  owner:
                    repoData.owner.login,
                  name:
                    repoData.name,
                  fullName:
                    repoData.full_name,
                },
                create: {
                  owner:
                    repoData.owner.login,
                  name:
                    repoData.name,
                  fullName:
                    repoData.full_name,
                  githubId:
                    repositoryGithubId,
                },
              },
            );

          /*
           * This product intentionally has one current snapshot per
           * repository rather than import-history semantics.
           *
           * Re-importing the same GitHub repository therefore replaces
           * the previous snapshot atomically. The surrounding transaction
           * guarantees that a failed replacement restores the old job,
           * issues, analyses, and repository metadata.
           */
          if (
            existingRepository
          ) {
            await tx.issueAnalysis.deleteMany(
              {
                where: {
                  issue: {
                    is: {
                      repositoryId:
                        repository.id,
                    },
                  },
                },
              },
            );

            await tx.issue.deleteMany(
              {
                where: {
                  repositoryId:
                    repository.id,
                },
              },
            );

            await tx.importJob.deleteMany(
              {
                where: {
                  repositoryId:
                    repository.id,
                },
              },
            );
          }

          const importJob =
            await tx.importJob.create(
              {
                data: {
                  status:
                    "importing",
                  repositoryId:
                    repository.id,
                },
              },
            );

          if (
            realIssues.length >
            0
          ) {
            await tx.issue.createMany(
              {
                data:
                  realIssues.map(
                    (
                      issue,
                    ) => ({
                      githubIssueId:
                        BigInt(
                          issue.id,
                        ),
                      issueNumber:
                        issue.number,
                      title:
                        issue.title,
                      body:
                        issue.body,
                      state:
                        issue.state,
                      author:
                        issue.user
                          .login,
                      githubUrl:
                        issue.html_url,
                      createdAtGithub:
                        new Date(
                          issue.created_at,
                        ),
                      repositoryId:
                        repository.id,
                    }),
                  ),
              },
            );
          }

          await tx.importJob.update(
            {
              where: {
                id:
                  importJob.id,
              },
              data: {
                status:
                  "completed",
                completedAt:
                  new Date(),
              },
            },
          );

          const savedIssues =
            importedGitHubIssueIds.length ===
            0
              ? []
              : await tx.issue.findMany(
                  {
                    where: {
                      repositoryId:
                        repository.id,
                      githubIssueId:
                        {
                          in:
                            importedGitHubIssueIds,
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
                  },
                );

          return {
            repository,
            importJob,
            savedIssues,
          };
        },
        {
          maxWait:
            5_000,
          timeout:
            10_000,
        },
      );

    return Response.json({
      success: true,
      repo:
        repository.fullName,
      issueCount:
        savedIssues.length,
      importJobId:
        importJob.id,
      issues:
        savedIssues.map(
          (issue) => ({
            id:
              issue.id,
            number:
              issue.issueNumber,
            title:
              issue.title,
            url:
              issue.githubUrl,
            state:
              issue.state,
            author:
              issue.author,
            createdAt:
              issue.createdAtGithub,
          }),
        ),
    });
  } catch (error) {
    if (
      error instanceof
      ActiveAnalysisConflictError
    ) {
      return Response.json(
        {
          success: false,
          error:
            "This repository is currently being analyzed. Wait for that analysis to finish before importing it again.",
        },
        {
          status: 409,
        },
      );
    }

    console.error(
      "IMPORT_ERROR:",
      error,
    );

    return Response.json(
      {
        success: false,
        error:
          "Temporary connection issue while importing. Please try again in a few seconds.",
      },
      {
        status: 500,
      },
    );
  }
}