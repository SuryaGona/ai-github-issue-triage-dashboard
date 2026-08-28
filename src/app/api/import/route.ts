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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      console.log(`GitHub fetch attempt ${attempt} failed`);

      if (attempt === attempts) {
        throw error;
      }

      await wait(800 * attempt);
    }
  }

  throw new Error("GitHub fetch failed after retries.");
}

async function dbWithRetry<T>(
  label: string,
  action: () => Promise<T>,
  attempts = 3
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      console.log(`DB attempt ${attempt} failed at: ${label}`);

      if (attempt === attempts) {
        throw error;
      }

      await wait(800 * attempt);
    }
  }

  throw new Error(`${label} failed after retries.`);
}

async function cleanupOldSessions() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const oldImportJobs = await prisma.importJob.findMany({
    where: {
      startedAt: {
        lt: oneHourAgo,
      },
    },
    select: {
      id: true,
      repositoryId: true,
    },
  });

  if (oldImportJobs.length === 0) {
    return;
  }

  const oldImportJobIds = oldImportJobs.map((job) => job.id);

  const possibleOldRepositoryIds = [
    ...new Set(oldImportJobs.map((job) => job.repositoryId)),
  ];

  await prisma.importJob.deleteMany({
    where: {
      id: {
        in: oldImportJobIds,
      },
    },
  });

  const repositoriesStillInUse = await prisma.importJob.findMany({
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
    repositoriesStillInUse.map((job) => job.repositoryId)
  );

  const repositoryIdsToDelete = possibleOldRepositoryIds.filter(
    (repositoryId) => !stillUsedRepositoryIds.has(repositoryId)
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

    if (!repoUrl || typeof repoUrl !== "string") {
      return Response.json(
        { success: false, error: "Repository URL is required." },
        { status: 400 }
      );
    }

    const cleanRepoUrl = repoUrl.trim();
    const repoPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/;
    const match = cleanRepoUrl.match(repoPattern);

    if (!match) {
      return Response.json(
        { success: false, error: "Please enter a valid GitHub repository URL." },
        { status: 400 }
      );
    }

    const owner = match[1];
    const repoName = match[2];

    await dbWithRetry("cleanup old sessions", cleanupOldSessions);

    const githubResponse = await fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repoName}`
    );

    if (!githubResponse.ok) {
      return Response.json(
        { success: false, error: "GitHub repository could not be found." },
        { status: 404 }
      );
    }

    const repoData: GitHubRepositoryResponse = await githubResponse.json();

    const issuesResponse = await fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repoName}/issues?state=open&per_page=100`
    );

    if (!issuesResponse.ok) {
      return Response.json(
        { success: false, error: "Could not fetch issues from this repository." },
        { status: 500 }
      );
    }

    const githubIssues: GitHubIssueResponse[] = await issuesResponse.json();

    const realIssues = githubIssues
      .filter((issue) => !issue.pull_request)
      .slice(0, 10);

    const repository = await dbWithRetry("repository upsert", () =>
      prisma.repository.upsert({
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
      })
    );

    const importJob = await dbWithRetry("import job create", () =>
      prisma.importJob.create({
        data: {
          status: "importing",
          repositoryId: repository.id,
        },
      })
    );

    for (const issue of realIssues) {
      await dbWithRetry(`issue upsert ${issue.id}`, () =>
        prisma.issue.upsert({
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
            createdAtGithub: new Date(issue.created_at),
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
            createdAtGithub: new Date(issue.created_at),
            repositoryId: repository.id,
          },
        })
      );
    }

    await dbWithRetry("mark import completed", () =>
      prisma.importJob.update({
        where: {
          id: importJob.id,
        },
        data: {
          status: "completed",
          completedAt: new Date(),
        },
      })
    );

    const savedIssues = await dbWithRetry("load saved issues", () =>
      prisma.issue.findMany({
        where: {
          repositoryId: repository.id,
        },
        orderBy: {
          importedAt: "desc",
        },
        take: 10,
      })
    );

    return Response.json({
      success: true,
      repo: repository.fullName,
      issueCount: savedIssues.length,
      importJobId: importJob.id,
      issues: savedIssues.map((issue) => ({
        id: issue.id,
        number: issue.issueNumber,
        title: issue.title,
        url: issue.githubUrl,
        state: issue.state,
        author: issue.author,
        createdAt: issue.createdAtGithub,
      })),
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