import https from "node:https";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Jira REST API types
// ---------------------------------------------------------------------------

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: {
      type: string;
      content?: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
      }>;
    } | null;
    status: {
      name: string;
      statusCategory: { key: string };
    };
    priority?: { name: string } | null;
    labels?: string[];
    assignee?: { displayName: string; emailAddress: string } | null;
    duedate?: string | null;
    fixVersions?: Array<{ name: string }>;
  };
}

interface JiraSearchResponse {
  total: number;
  issues: JiraIssue[];
}

// ---------------------------------------------------------------------------
// Priority and status mapping
// ---------------------------------------------------------------------------

type PmPriority = 1 | 2 | 3 | 4;
type PmStatus = "open" | "in_progress" | "closed" | "blocked";

function mapJiraPriority(jiraPriority: string | undefined): PmPriority {
  if (!jiraPriority) return 3;
  const name = jiraPriority.toLowerCase();
  if (name === "highest" || name === "critical") return 1;
  if (name === "high") return 2;
  if (name === "medium") return 3;
  if (name === "low" || name === "lowest") return 4;
  return 3;
}

function mapJiraStatus(jiraStatus: string): PmStatus {
  const name = jiraStatus.toLowerCase();
  if (name === "blocked") return "blocked";
  if (
    name === "in progress" ||
    name === "in review" ||
    name === "in development" ||
    name === "code review"
  )
    return "in_progress";
  if (
    name === "done" ||
    name === "resolved" ||
    name === "closed" ||
    name === "complete" ||
    name === "completed"
  )
    return "closed";
  // Default: to do / open / backlog / any other
  return "open";
}

// ---------------------------------------------------------------------------
// Jira description (Atlassian Document Format) → plain text
// ---------------------------------------------------------------------------

function adfToPlainText(
  node:
    | JiraIssue["fields"]["description"]
    | { type: string; content?: unknown[]; text?: string }
    | null
    | undefined
): string {
  if (!node) return "";
  if ("text" in node && typeof (node as { text?: string }).text === "string") {
    return (node as { text: string }).text;
  }
  if ("content" in node && Array.isArray((node as { content?: unknown[] }).content)) {
    return (node as { content: unknown[] }).content
      .map((child) => adfToPlainText(child as { type: string; content?: unknown[]; text?: string }))
      .join("")
      .trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// HTTP helper using Node.js native https module
// ---------------------------------------------------------------------------

function httpsGet(url: string, authHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `Jira API error ${res.statusCode}: ${body.slice(0, 200)}`
            )
          );
        } else {
          resolve(body);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fetch all pages from Jira search API
// ---------------------------------------------------------------------------

async function fetchAllJiraIssues(
  baseUrl: string,
  authHeader: string,
  jql: string,
  maxResults: number
): Promise<JiraIssue[]> {
  const fields =
    "summary,description,status,priority,labels,assignee,duedate,fixVersions";
  const allIssues: JiraIssue[] = [];
  let startAt = 0;
  const pageSize = Math.min(maxResults, 100);

  while (allIssues.length < maxResults) {
    const remaining = maxResults - allIssues.length;
    const fetchSize = Math.min(remaining, pageSize);
    const url =
      `${baseUrl}/rest/api/3/search` +
      `?jql=${encodeURIComponent(jql)}` +
      `&fields=${encodeURIComponent(fields)}` +
      `&startAt=${startAt}` +
      `&maxResults=${fetchSize}`;

    const raw = await httpsGet(url, authHeader);
    const data = JSON.parse(raw) as JiraSearchResponse;

    if (!data.issues || data.issues.length === 0) break;
    allIssues.push(...data.issues);
    startAt += data.issues.length;

    if (startAt >= data.total) break;
  }

  return allIssues;
}

// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-jira",
  version: "2026.5.27",

  activate(api) {
    // -----------------------------------------------------------------------
    // Command: pm jira sync
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "jira sync",
      description: "Sync Jira issues into pm items",
      intent:
        "Import or update pm items from a Jira project using the Jira REST API",
      examples: [
        "pm jira sync --project PROJ",
        "pm jira sync --project PROJ --max-results 200",
        "pm jira sync --jql 'project = PROJ AND assignee = currentUser()'",
        "pm jira sync --project PROJ --status open --dry-run",
      ],
      flags: [
        {
          long: "--project",
          value_name: "KEY",
          description: "Jira project key (e.g. PROJ)",
        },
        {
          long: "--jql",
          value_name: "query",
          description: "Custom JQL query",
        },
        {
          long: "--max-results",
          value_name: "n",
          description: "Max issues to sync (default: 500)",
        },
        {
          long: "--dry-run",
          description: "Preview without writing",
        },
        {
          long: "--status",
          value_name: "filter",
          description: "Filter by pm status (open|in_progress|closed|blocked)",
        },
      ],

      async run(ctx) {
        const project = ctx.options["project"] as string | undefined;
        const customJql = ctx.options["jql"] as string | undefined;
        const maxResults = (ctx.options["max-results"] as number | undefined) ?? 500;
        const dryRun = (ctx.options["dry-run"] as boolean | undefined) ?? false;
        const statusFilter = ctx.options["status"] as string | undefined;

        // Validate env vars
        const baseUrl = process.env["JIRA_BASE_URL"];
        const token = process.env["JIRA_API_TOKEN"];
        const email = process.env["JIRA_EMAIL"];

        if (!baseUrl || !token || !email) {
          console.error(
            "Missing required environment variables. Please set JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_EMAIL."
          );
          return { success: false, error: "Missing Jira credentials" };
        }

        if (!project && !customJql) {
          console.error(
            "Provide either --project <KEY> or --jql <query> to specify which issues to sync."
          );
          return { success: false, error: "No project or JQL specified" };
        }

        const jql =
          customJql ??
          `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;

        const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

        console.error(`Fetching issues from Jira... (JQL: ${jql})`);

        let issues: JiraIssue[];
        try {
          issues = await fetchAllJiraIssues(
            baseUrl.replace(/\/$/, ""),
            authHeader,
            jql,
            maxResults
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to fetch issues from Jira: ${msg}`);
          return { success: false, error: msg };
        }

        console.error(`Fetched ${issues.length} issues from Jira`);

        // Apply status filter before upsert
        const filtered = statusFilter
          ? issues.filter(
              (issue) =>
                mapJiraStatus(issue.fields.status.name) === statusFilter
            )
          : issues;

        if (statusFilter && filtered.length !== issues.length) {
          console.error(
            `Filtered to ${filtered.length} issues with pm status "${statusFilter}"`
          );
        }

        if (dryRun) {
          console.error(`[dry-run] Would upsert ${filtered.length} items:`);
          for (const issue of filtered.slice(0, 20)) {
            console.error(
              `  ${issue.key}: ${issue.fields.summary} [${mapJiraStatus(issue.fields.status.name)}]`
            );
          }
          if (filtered.length > 20) {
            console.error(`  ... and ${filtered.length - 20} more`);
          }
          return {
            success: true,
            dryRun: true,
            total: filtered.length,
            project: project ?? "custom-jql",
          };
        }

        // Create items via pm CLI
        let upserted = 0;
        for (const issue of filtered) {
          const tags: string[] = [
            ...(issue.fields.labels ?? []),
            ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
          ];

          const result = spawnSync(
            "pm",
            [
              "--path", ctx.pm_root,
              "create",
              "--title", `[${issue.key}] ${issue.fields.summary}`,
              "--status", mapJiraStatus(issue.fields.status.name),
              "--type", "Issue",
              ...(tags.length > 0 ? ["--tags", tags.join(",")] : []),
            ],
            { encoding: "utf-8" }
          );

          if (result.status === 0) {
            upserted++;
          }
        }

        const projectLabel = project ?? "custom-jql";
        console.error(
          `Synced ${upserted} issues from Jira project ${projectLabel}`
        );

        return {
          success: true,
          synced: upserted,
          total: filtered.length,
          project: projectLabel,
          summary: `Synced ${upserted} issues from Jira project ${projectLabel}`,
        };
      },
    });

    // -----------------------------------------------------------------------
    // Importer: jira-sync
    // -----------------------------------------------------------------------
    api.registerImporter("jira-sync", async (ctx) => {
      const baseUrl =
        (ctx.options["JIRA_BASE_URL"] as string | undefined) ??
        process.env["JIRA_BASE_URL"];
      const token =
        (ctx.options["JIRA_API_TOKEN"] as string | undefined) ??
        process.env["JIRA_API_TOKEN"];
      const email =
        (ctx.options["JIRA_EMAIL"] as string | undefined) ??
        process.env["JIRA_EMAIL"];
      const project = ctx.options["project"] as string | undefined;
      const customJql = ctx.options["jql"] as string | undefined;
      const maxResults = (ctx.options["maxResults"] as number | undefined) ?? 500;

      if (!baseUrl || !token || !email) {
        throw new Error(
          "jira-sync importer requires JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_EMAIL (via options or env)"
        );
      }

      if (!project && !customJql) {
        throw new Error(
          "jira-sync importer requires either options.project or options.jql"
        );
      }

      const jql =
        customJql ??
        `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;

      const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

      console.error(`[jira-sync] Fetching issues with JQL: ${jql}`);

      const issues = await fetchAllJiraIssues(
        baseUrl.replace(/\/$/, ""),
        authHeader,
        jql,
        maxResults
      );

      console.error(`[jira-sync] Importing ${issues.length} issues`);

      for (const issue of issues) {
        const tags: string[] = [
          ...(issue.fields.labels ?? []),
          ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
        ];

        spawnSync(
          "pm",
          [
            "--path", ctx.pm_root,
            "create",
            "--title", `[${issue.key}] ${issue.fields.summary}`,
            "--status", mapJiraStatus(issue.fields.status.name),
            "--type", "Issue",
            ...(tags.length > 0 ? ["--tags", tags.join(",")] : []),
          ],
          { encoding: "utf-8" }
        );
      }

      console.error(`[jira-sync] Done. Imported ${issues.length} issues.`);
    });
  },
});
