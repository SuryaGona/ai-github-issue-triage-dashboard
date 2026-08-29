import {
  fetchWithTimeout,
  isRetryableHttpStatus,
  retryDelayMs,
  wait,
} from "@/lib/http";
import { prisma } from "@/lib/prisma";

type GitHubRepositoryResponse = {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
};

type GitHubIssueResponse = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  user: {
    login: string;
  };
  pull_request?: unknown;
};

const GITHUB_TIMEOUT_MS = 8_000;
const GITHUB_RETRY_ATTEMPTS = 3;
const GITHUB_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 5_000;

const ANALYSIS_LEASE_MS = 3 * 60 * 1000;

function getRetryAfterMs(response: Response) {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(
      seconds * 1000,
      MAX_RETRY_AFTER_MS
    );
  }

  const retryAt = Date.parse(retryAfter);

  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.min(
    Math.max(0, retryAt - Date.now()),
    MAX_RETRY_AFTER_MS
  );
}

function isGitHubRateLimited(response: Response) {
  if (response.status === 429) {
    return true;
  }

  if (response.status !== 403) {
    return false;
  }

  return (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  );
}

async function fetchGitHubWithRetry(
  url: string,
  signal?: AbortSignal,
  attempts = GITHUB_RETRY_ATTEMPTS
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          signal,
        },
        GITHUB_TIMEOUT_MS
      );

      const retryable =
        isRetryableHttpStatus(response.status) ||
        isGitHubRateLimited(response);

      if (!retryable || attempt === attempts) {
        return response;
      }

      const delay =
        getRetryAfterMs(response) ??
        retryDelayMs(
          attempt,
          GITHUB_RETRY_BASE_DELAY_MS
        );

      await wait(delay);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

      if (attempt === attempts) {
        throw error;
      }

      await wait(
        retryDelayMs(
          attempt,
          GITHUB_RETRY_BASE_DELAY_MS
        )
      );
    }
  }

  throw new Error(
    "GitHub request failed after retries."
  );
}

async function cleanupOldSessions() {
  const now = Date.now();

  const oneHourAgo = new Date(
    now - 60 * 60 * 1000
  );

  const staleAnalysisBefore = new Date(
    now - ANALYSIS_LEASE_MS
  );

  const safeToDeleteFilter = {
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
          lt: staleAnalysisBefore,
        },
      },
    ],
  };

  const oldImportJobs =
    await prisma.importJob.findMany({
      where: {
        startedAt: {
          lt: oneHourAgo,
        },
        ...safeToDeleteFilter,
      },
      select: {
        id: true,
        repositoryId: true,
      },
    });

  if (oldImportJobs.length === 0) {
    return;
  }

  const oldImportJobIds = oldImportJobs.map(
    (job) => job.id
  );

  const possibleOldRepositoryIds = [
    ...new Set(
      oldImportJobs.map(
        (job) => job.repositoryId
      )
    ),
  ];

  await prisma.importJob.deleteMany({
    where: {
      id: {
        in: oldImportJobIds,
      },
      ...safeToDeleteFilter,
    },
  });

  const repositoriesStillInUse =
    await prisma.importJob.findMany({
      where: {
        repositoryId: {
          in: possibleOldRepositoryIds,
        },
      },
      select: {
        repositoryId: true,
      },
    });

  const stillUsedRepositoryIds = new Set(
    repositoriesStillInUse.map(
      (job) => job.repositoryId
    )
  );

  const repositoryIdsToDelete =
    possibleOldRepositoryIds.filter(
      (repositoryId) =>
        !stillUsedRepositoryIds.has(
          repositoryId
        )
    );

  if (repositoryIdsToDelete.length === 0) {
    return;
  }

  await prisma.issueAnalysis.deleteMany({
    where: {
      issue: {
        is: {
          repositoryId: {
            in: repositoryIdsToDelete,
          },
        },
      },
    },
  });

  await prisma.issue.deleteMany({
    where: {
      repositoryId: {
        in: repositoryIdsToDelete,
      },
    },
  });

  await prisma.repository.deleteMany({
    where: {
      id: {
        in: repositoryIdsToDelete,
      },
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const repoUrl = body.repoUrl;

    if (
      !repoUrl ||
      typeof repoUrl !== "string"
    ) {
      return Response.json(
        {
          success: false,
          error: "Repository URL is required.",
        },
        { status: 400 }
      );
    }

    const cleanRepoUrl = repoUrl.trim();

    const repoPattern =
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/;

    const match =
      cleanRepoUrl.match(repoPattern);

    if (!match) {
      return Response.json(
        {
          success: false,
          error:
            "Please enter a valid GitHub repository URL.",
        },
        { status: 400 }
      );
    }

    const owner = match[1];
    const repoName = match[2];

    await cleanupOldSessions();

    const githubResponse =
      await fetchGitHubWithRetry(
        `https://api.github.com/repos/${owner}/${repoName}`,
        request.signal
      );

    if (githubResponse.status === 404) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub repository could not be found.",
        },
        { status: 404 }
      );
    }

    if (isGitHubRateLimited(githubResponse)) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub API rate limit reached. Please try again later.",
        },
        { status: 429 }
      );
    }

    if (!githubResponse.ok) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub repository lookup is temporarily unavailable.",
        },
        { status: 502 }
      );
    }

    const repoData: GitHubRepositoryResponse =
      await githubResponse.json();

    const issuesResponse =
      await fetchGitHubWithRetry(
        `https://api.github.com/repos/${owner}/${repoName}/issues?state=open&per_page=100`,
        request.signal
      );

    if (isGitHubRateLimited(issuesResponse)) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub API rate limit reached. Please try again later.",
        },
        { status: 429 }
      );
    }

    if (!issuesResponse.ok) {
      return Response.json(
        {
          success: false,
          error:
            "GitHub issues are temporarily unavailable.",
        },
        { status: 502 }
      );
    }

    const githubIssues: GitHubIssueResponse[] =
      await issuesResponse.json();

    const realIssues = githubIssues
      .filter(
        (issue) => !issue.pull_request
      )
      .slice(0, 10);

    const repository =
      await prisma.repository.upsert({
        where: {
          fullName: repoData.full_name,
        },
        update: {
          owner: repoData.owner.login,
          name: repoData.name,
          githubId: BigInt(repoData.id),
        },
        create: {
          owner: repoData.owner.login,
          name: repoData.name,
          fullName: repoData.full_name,
          githubId: BigInt(repoData.id),
        },
      });

    const importJob =
      await prisma.importJob.create({
        data: {
          status: "importing",
          repositoryId: repository.id,
        },
      });

    for (const issue of realIssues) {
      await prisma.issue.upsert({
        where: {
          githubIssueId: BigInt(issue.id),
        },
        update: {
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          author: issue.user.login,
          githubUrl: issue.html_url,
          createdAtGithub:
            new Date(issue.created_at),
          repositoryId: repository.id,
        },
        create: {
          githubIssueId: BigInt(issue.id),
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          author: issue.user.login,
          githubUrl: issue.html_url,
          createdAtGithub:
            new Date(issue.created_at),
          repositoryId: repository.id,
        },
      });
    }

    await prisma.importJob.update({
      where: {
        id: importJob.id,
      },
      data: {
        status: "completed",
        completedAt: new Date(),
      },
    });

    const savedIssues =
      await prisma.issue.findMany({
        where: {
          repositoryId: repository.id,
        },
        orderBy: {
          importedAt: "desc",
        },
        take: 10,
      });

    return Response.json({
      success: true,
      repo: repository.fullName,
      issueCount: savedIssues.length,
      importJobId: importJob.id,
      issues: savedIssues.map(
        (issue) => ({
          id: issue.id,
          number: issue.issueNumber,
          title: issue.title,
          url: issue.githubUrl,
          state: issue.state,
          author: issue.author,
          createdAt:
            issue.createdAtGithub,
        })
      ),
    });
  } catch (error) {
    console.error("IMPORT_ERROR:", error);

    return Response.json(
      {
        success: false,
        error:
          "Temporary connection issue while importing. Please try again in a few seconds.",
      },
      { status: 500 }
    );
  }
}