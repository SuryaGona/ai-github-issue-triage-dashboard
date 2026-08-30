import { randomUUID } from "node:crypto";

import {
  expect,
  test,
} from "@playwright/test";
import { Pool } from "pg";

const LOCAL_TEST_DATABASE_URL =
  "postgresql://triage:triage_test@127.0.0.1:5436/triage_test";

const databaseUrl =
  process.env.CI === "true"
    ? process.env.DATABASE_URL
    : LOCAL_TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for E2E tests.",
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
});

const repositoryId = "e2e-repository";
const importJobId = "e2e-import-job";
const crashIssueId = "e2e-issue-11";
const docsIssueId = "e2e-issue-13";

async function resetDatabase() {
  await pool.query(
    'DELETE FROM "IssueAnalysis"',
  );

  await pool.query(
    'DELETE FROM "Issue"',
  );

  await pool.query(
    'DELETE FROM "ImportJob"',
  );

  await pool.query(
    'DELETE FROM "Repository"',
  );
}

async function seedImportedRepository() {
  await pool.query(
    `
      INSERT INTO "Repository" (
        "id",
        "owner",
        "name",
        "fullName",
        "githubId",
        "createdAt"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        NOW()
      )
      ON CONFLICT ("id") DO UPDATE SET
        "owner" = EXCLUDED."owner",
        "name" = EXCLUDED."name",
        "fullName" = EXCLUDED."fullName",
        "githubId" = EXCLUDED."githubId"
    `,
    [
      repositoryId,
      "acme",
      "widget",
      "acme/widget",
      "99001",
    ],
  );

  await pool.query(
    `
      INSERT INTO "ImportJob" (
        "id",
        "status",
        "startedAt",
        "completedAt",
        "analysisLeaseId",
        "analysisStartedAt",
        "repositoryId"
      )
      VALUES (
        $1,
        $2,
        NOW(),
        NOW(),
        NULL,
        NULL,
        $3
      )
      ON CONFLICT ("id") DO UPDATE SET
        "status" = EXCLUDED."status",
        "completedAt" = EXCLUDED."completedAt",
        "analysisLeaseId" = NULL,
        "analysisStartedAt" = NULL,
        "repositoryId" = EXCLUDED."repositoryId"
    `,
    [
      importJobId,
      "completed",
      repositoryId,
    ],
  );

  await pool.query(
    `
      INSERT INTO "Issue" (
        "id",
        "githubIssueId",
        "issueNumber",
        "title",
        "body",
        "state",
        "author",
        "githubUrl",
        "createdAtGithub",
        "importedAt",
        "repositoryId"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        NOW(),
        $10
      )
      ON CONFLICT ("id") DO UPDATE SET
        "title" = EXCLUDED."title",
        "body" = EXCLUDED."body",
        "state" = EXCLUDED."state",
        "author" = EXCLUDED."author",
        "githubUrl" = EXCLUDED."githubUrl",
        "repositoryId" = EXCLUDED."repositoryId"
    `,
    [
      crashIssueId,
      "99101",
      11,
      "Crash on startup",
      "The application crashes during startup.",
      "open",
      "alice",
      "https://github.com/acme/widget/issues/11",
      new Date(
        "2026-08-01T12:00:00.000Z",
      ),
      repositoryId,
    ],
  );

  await pool.query(
    `
      INSERT INTO "Issue" (
        "id",
        "githubIssueId",
        "issueNumber",
        "title",
        "body",
        "state",
        "author",
        "githubUrl",
        "createdAtGithub",
        "importedAt",
        "repositoryId"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        NOW(),
        $10
      )
      ON CONFLICT ("id") DO UPDATE SET
        "title" = EXCLUDED."title",
        "body" = EXCLUDED."body",
        "state" = EXCLUDED."state",
        "author" = EXCLUDED."author",
        "githubUrl" = EXCLUDED."githubUrl",
        "repositoryId" = EXCLUDED."repositoryId"
    `,
    [
      docsIssueId,
      "99103",
      13,
      "Documentation typo",
      "There is a typo in the installation guide.",
      "open",
      "bob",
      "https://github.com/acme/widget/issues/13",
      new Date(
        "2026-08-03T12:00:00.000Z",
      ),
      repositoryId,
    ],
  );
}

async function seedAnalysisResults() {
  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        INSERT INTO "IssueAnalysis" (
          "id",
          "summary",
          "category",
          "priority",
          "effort",
          "suggestedReply",
          "issueId",
          "createdAt"
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          NOW()
        )
        ON CONFLICT ("issueId") DO UPDATE SET
          "summary" = EXCLUDED."summary",
          "category" = EXCLUDED."category",
          "priority" = EXCLUDED."priority",
          "effort" = EXCLUDED."effort",
          "suggestedReply" = EXCLUDED."suggestedReply"
      `,
      [
        randomUUID(),
        "Startup fails during application initialization.",
        "Bug",
        "High",
        "Medium",
        "The startup path is crashing during initialization; isolate the failing stage before scoping the fix.",
        crashIssueId,
      ],
    );

    await client.query(
      `
        INSERT INTO "IssueAnalysis" (
          "id",
          "summary",
          "category",
          "priority",
          "effort",
          "suggestedReply",
          "issueId",
          "createdAt"
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          NOW()
        )
        ON CONFLICT ("issueId") DO UPDATE SET
          "summary" = EXCLUDED."summary",
          "category" = EXCLUDED."category",
          "priority" = EXCLUDED."priority",
          "effort" = EXCLUDED."effort",
          "suggestedReply" = EXCLUDED."suggestedReply"
      `,
      [
        randomUUID(),
        "The installation guide contains a documentation typo.",
        "Documentation",
        "Low",
        "Small",
        "The typo is isolated to the installation guide and can be corrected directly.",
        docsIssueId,
      ],
    );

    await client.query(
      `
        UPDATE "ImportJob"
        SET
          "status" = $1,
          "analysisLeaseId" = NULL,
          "analysisStartedAt" = NULL
        WHERE "id" = $2
      `,
      [
        "analyzed",
        importJobId,
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    throw error;
  } finally {
    client.release();
  }
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

test(
  "connect -> dashboard -> analysis result flow",
  async ({ page }) => {
    let analyzeRequested = false;

    let importSeedPromise:
      | Promise<void>
      | undefined;

    let analysisSeedPromise:
      | Promise<void>
      | undefined;

    await page.route(
      "**/api/import",
      async (route) => {
        expect(
          route.request().method(),
        ).toBe("POST");

        expect(
          route.request().postDataJSON(),
        ).toEqual({
          repoUrl:
            "https://github.com/acme/widget",
        });

        importSeedPromise ??=
          seedImportedRepository();

        await importSeedPromise;

        await route.fulfill({
          status: 200,
          contentType:
            "application/json",
          body: JSON.stringify({
            success: true,
            repo: "acme/widget",
            issueCount: 2,
            importJobId,
            issues: [
              {
                id: docsIssueId,
                number: 13,
                title:
                  "Documentation typo",
                url:
                  "https://github.com/acme/widget/issues/13",
                state: "open",
                author: "bob",
                createdAt:
                  "2026-08-03T12:00:00.000Z",
              },
              {
                id: crashIssueId,
                number: 11,
                title:
                  "Crash on startup",
                url:
                  "https://github.com/acme/widget/issues/11",
                state: "open",
                author: "alice",
                createdAt:
                  "2026-08-01T12:00:00.000Z",
              },
            ],
          }),
        });
      },
    );

    await page.route(
      "**/api/analyze",
      async (route) => {
        analyzeRequested = true;

        expect(
          route.request().method(),
        ).toBe("POST");

        expect(
          route.request().postDataJSON(),
        ).toEqual({
          importJobId,
        });

        analysisSeedPromise ??=
          seedAnalysisResults();

        await analysisSeedPromise;

        await route.fulfill({
          status: 200,
          contentType:
            "application/json",
          body: JSON.stringify({
            success: true,
            analyzedCount: 2,
          }),
        });
      },
    );

    await page.goto(
      "/connect",
    );

    await page
      .getByPlaceholder(
        "Paste a public GitHub repo URL",
      )
      .fill(
        "https://github.com/acme/widget",
      );

    await page
      .getByRole(
        "button",
        {
          name: "Analyze",
        },
      )
      .click();

    await expect(
      page.getByText(
        "Repository imported successfully",
      ),
    ).toBeVisible();

    await expect(
      page.getByText(
        "#11 Crash on startup",
      ),
    ).toBeVisible();

    await expect(
      page.getByText(
        "#13 Documentation typo",
      ),
    ).toBeVisible();

    const dashboardLink =
      page.getByRole(
        "link",
        {
          name:
            "Open dashboard",
        },
      );

    await expect(
      dashboardLink,
    ).toHaveAttribute(
      "href",
      `/dashboard?jobId=${importJobId}`,
    );

    await Promise.all([
      page.waitForURL(
        new RegExp(
          `/dashboard\\?jobId=${importJobId}$`,
        ),
      ),
      dashboardLink.click(),
    ]);

    await expect(
      page.getByText(
        "Crash on startup",
        {
          exact: true,
        },
      ),
    ).toBeVisible();

    await expect(
      page.getByText(
        "Documentation typo",
        {
          exact: true,
        },
      ),
    ).toBeVisible();

    await expect
      .poll(
        () => analyzeRequested,
        {
          timeout: 10_000,
        },
      )
      .toBe(true);

    await expect(
      page.getByText(
        "Startup fails during application initialization.",
        {
          exact: true,
        },
      ),
    ).toBeVisible({
      timeout: 15_000,
    });

    await expect(
      page.getByText(
        "The installation guide contains a documentation typo.",
        {
          exact: true,
        },
      ),
    ).toBeVisible({
      timeout: 15_000,
    });

    await expect(
      page.getByText(
        "Priority · High",
        {
          exact: true,
        },
      ),
    ).toBeVisible();

    await expect(
      page.getByText(
        "Category · Documentation",
        {
          exact: true,
        },
      ),
    ).toBeVisible();

    await expect(
      page.getByText(
        "Analysis complete",
        {
          exact: true,
        },
      ),
    ).toBeVisible();

    const analysisCount =
      await pool.query<{
        count: string;
      }>(
        `
          SELECT COUNT(*)::text AS count
          FROM "IssueAnalysis"
        `,
      );

    expect(
      analysisCount.rows[0].count,
    ).toBe("2");

    const jobResult =
      await pool.query<{
        status: string;
        analysisLeaseId:
          | string
          | null;
        analysisStartedAt:
          | Date
          | null;
      }>(
        `
          SELECT
            "status",
            "analysisLeaseId",
            "analysisStartedAt"
          FROM "ImportJob"
          WHERE "id" = $1
        `,
        [
          importJobId,
        ],
      );

    expect(
      jobResult.rows,
    ).toHaveLength(1);

    expect(
      jobResult.rows[0].status,
    ).toBe("analyzed");

    expect(
      jobResult.rows[0]
        .analysisLeaseId,
    ).toBeNull();

    expect(
      jobResult.rows[0]
        .analysisStartedAt,
    ).toBeNull();
  },
);