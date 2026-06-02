// pm-jira — Jira issue sync / importer / exporter for pm-cli
//
// Capabilities (see manifest.json):
//   commands  — `pm jira sync` (legacy, full-featured pull)
//   importers — `pm jira import` (native import pipeline: pull issues via JQL)
//             — `jira-sync` (config-driven importer, kept for back-compat)
//   exporters — `pm jira export` (render pm items as Jira-create payloads;
//               only POSTs to Jira with explicit --push AND creds present)
//   schema    — declares jira_key / jira_url item fields
//   services  — declared for governance parity with the sync service surface

import https from "node:https";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time — doubling side effects (e.g. a second Jira fetch) and exiting
// with a generic code instead of a semantic one. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

export class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

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

export function mapJiraPriority(jiraPriority: string | undefined): PmPriority {
  if (!jiraPriority) return 3;
  const name = jiraPriority.toLowerCase();
  if (name === "highest" || name === "critical") return 1;
  if (name === "high") return 2;
  if (name === "medium") return 3;
  if (name === "low" || name === "lowest") return 4;
  return 3;
}

export function mapJiraStatus(
  jiraStatus: string,
  statusMap?: Record<string, PmStatus>
): PmStatus {
  const name = jiraStatus.toLowerCase();
  // A caller-supplied --status-map override wins over the built-in heuristics.
  if (statusMap && name in statusMap) return statusMap[name]!;
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

const PM_STATUSES: readonly PmStatus[] = ["open", "in_progress", "closed", "blocked"];

// Parse a --status-map value of the form
//   "In Progress=in_progress,QA=blocked"
// into a lower-cased lookup table. Invalid pm-status targets are rejected with
// a USAGE CommandError so a typo never silently maps everything to "open".
export function parseStatusMap(raw: string | undefined): Record<string, PmStatus> | undefined {
  if (!raw) return undefined;
  const map: Record<string, PmStatus> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      throw new CommandError(
        `Invalid --status-map entry "${trimmed}" (expected "JiraStatus=pm_status").`,
        EXIT_CODE.USAGE
      );
    }
    const from = trimmed.slice(0, eq).trim().toLowerCase();
    const to = trimmed.slice(eq + 1).trim() as PmStatus;
    if (!from) {
      throw new CommandError(
        `Invalid --status-map entry "${trimmed}" (empty Jira status).`,
        EXIT_CODE.USAGE
      );
    }
    if (!PM_STATUSES.includes(to)) {
      throw new CommandError(
        `Invalid --status-map target "${to}" (expected one of ${PM_STATUSES.join("|")}).`,
        EXIT_CODE.USAGE
      );
    }
    map[from] = to;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

// ---------------------------------------------------------------------------
// Jira description (Atlassian Document Format) → plain text
// ---------------------------------------------------------------------------

export function adfToPlainText(
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

// Render a plain-text body as a minimal Atlassian Document Format doc so it can
// be POSTed back to the Jira create API.
export function plainTextToAdf(text: string): {
  type: "doc";
  version: 1;
  content: Array<{ type: "paragraph"; content: Array<{ type: "text"; text: string }> }>;
} {
  const body = text && text.trim().length > 0 ? text : " ";
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
  };
}

// ---------------------------------------------------------------------------
// Provenance marker — pm `create` has no generic custom-field setter for an
// extension, so (like pm-github) we persist the Jira key + browse URL inside
// the item description with a stable marker. This survives round-trips and
// powers `pm jira export`.
// ---------------------------------------------------------------------------

const JIRA_MARKER = /^Jira ([A-Z][A-Z0-9]+-\d+): (\S+)\s*$/m;

export function jiraProvenance(key: string, browseUrl: string): string {
  return `Jira ${key}: ${browseUrl}`;
}

export function extractJiraKey(text: string | undefined): { key: string; url: string } | undefined {
  if (!text) return undefined;
  const m = text.match(JIRA_MARKER);
  if (!m) return undefined;
  return { key: m[1]!, url: m[2]! };
}

// ---------------------------------------------------------------------------
// Option readers — tolerate both kebab-case and camelCase keys.
// The pm CLI normalizes loose extension flags to camelCase (e.g. --dry-run
// arrives as `dryRun`, --max-results as `maxResults`). Reading only the
// kebab key silently yields undefined, which for --dry-run means a "preview"
// that actually writes. Always check both spellings.
// ---------------------------------------------------------------------------

function camelKey(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function readOptionValue(options: Record<string, unknown>, kebab: string): unknown {
  return options[kebab] ?? options[camelKey(kebab)];
}

export function readStringOption(
  options: Record<string, unknown>,
  kebab: string
): string | undefined {
  const v = readOptionValue(options, kebab);
  const value = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readNumberOption(
  options: Record<string, unknown>,
  kebab: string
): number | undefined {
  const v = readOptionValue(options, kebab);
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function readBooleanOption(
  options: Record<string, unknown>,
  kebab: string
): boolean {
  const v = readOptionValue(options, kebab);
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "";
  }
  return Boolean(v);
}

export function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readStringOption(options, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function optionInt(options: Record<string, unknown>, defaultValue: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = readNumberOption(options, key);
    if (value !== undefined) return value;
  }
  return defaultValue;
}

export function optionEnabled(options: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => readBooleanOption(options, key));
}

// ---------------------------------------------------------------------------
// Credential resolution — env vars, with an optional --host override for the
// base URL. NEVER hard-codes a host or any secret.
// ---------------------------------------------------------------------------

export interface JiraCreds {
  baseUrl: string;
  email: string;
  token: string;
  authHeader: string;
}

// Resolve Jira credentials from options (--host) + env. Returns a structured
// CommandError (numeric exitCode) when anything is missing rather than throwing
// a bare Error, so the CLI exits non-zero exactly once with a helpful message.
export function resolveCreds(
  options: Record<string, unknown>,
  envLike: NodeJS.ProcessEnv = process.env
): JiraCreds {
  const baseUrl =
    readStringOption(options, "host") ??
    (envLike["JIRA_BASE_URL"]?.trim() || undefined);
  const token = envLike["JIRA_API_TOKEN"]?.trim() || undefined;
  const email = envLike["JIRA_EMAIL"]?.trim() || undefined;

  const missing: string[] = [];
  if (!baseUrl) missing.push("JIRA_BASE_URL (or --host)");
  if (!email) missing.push("JIRA_EMAIL");
  if (!token) missing.push("JIRA_API_TOKEN");

  if (missing.length > 0) {
    throw new CommandError(
      `Missing Jira credentials: ${missing.join(", ")}. ` +
        `Set JIRA_BASE_URL (or pass --host), JIRA_EMAIL, and JIRA_API_TOKEN. ` +
        `Create a token at https://id.atlassian.com/manage-profile/security/api-tokens`,
      EXIT_CODE.USAGE
    );
  }

  const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  return { baseUrl: baseUrl!.replace(/\/$/, ""), email: email!, token: token!, authHeader };
}

// ---------------------------------------------------------------------------
// HTTP helpers using Node.js native https module
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
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Jira API request timed out"));
    });
    req.end();
  });
}

function httpsPost(url: string, authHeader: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Jira API error ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          resolve(body);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Jira API request timed out"));
    });
    req.write(payload);
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
// Issue -> pm create args (pure; testable)
// ---------------------------------------------------------------------------

export interface IssueToItem {
  title: string;
  status: PmStatus;
  priority: PmPriority;
  body: string;
  tags: string[];
  deadline?: string;
  description: string;
}

export function issueToItem(
  issue: JiraIssue,
  baseUrl: string,
  statusMap?: Record<string, PmStatus>
): IssueToItem {
  const tags: string[] = [
    ...(issue.fields.labels ?? []),
    ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
  ];
  const rawBody = adfToPlainText(issue.fields.description);
  const browseUrl = `${baseUrl.replace(/\/$/, "")}/browse/${issue.key}`;
  return {
    title: `[${issue.key}] ${issue.fields.summary}`,
    status: mapJiraStatus(issue.fields.status.name, statusMap),
    priority: mapJiraPriority(issue.fields.priority?.name),
    body: rawBody,
    tags,
    deadline: issue.fields.duedate ?? undefined,
    // Provenance marker lives in the description so it survives round-trips.
    description: jiraProvenance(issue.key, browseUrl),
  };
}

function createPmItem(pmRoot: string, item: IssueToItem): boolean {
  const args = [
    "--path", pmRoot,
    "create",
    "--title", item.title,
    "--status", item.status,
    "--type", "Issue",
    "--priority", String(item.priority),
    "--description", item.description,
    ...(item.body ? ["--body", item.body] : []),
    ...(item.deadline ? ["--deadline", item.deadline] : []),
    ...(item.tags.length > 0 ? ["--tags", item.tags.join(",")] : []),
  ];
  const result = spawnSync("pm", args, { encoding: "utf-8" });
  return result.status === 0;
}

// Shared import core for both `pm jira sync`, `pm jira import` and the
// `jira-sync` importer. Throws CommandError (semantic exitCode) on failure.
async function runImport(
  options: Record<string, unknown>,
  pmRoot: string,
  opts: { dryRun?: boolean; statusFilter?: string } = {}
) {
  const creds = resolveCreds(options);
  const project = readStringOption(options, "project");
  const customJql = readStringOption(options, "jql");
  const maxResults = readNumberOption(options, "max-results") ?? 500;
  const statusMap = parseStatusMap(readStringOption(options, "status-map"));
  const dryRun = opts.dryRun ?? readBooleanOption(options, "dry-run");
  const statusFilter = opts.statusFilter ?? readStringOption(options, "status");

  if (!project && !customJql) {
    throw new CommandError(
      "Provide either --project <KEY> or --jql <query> to specify which issues to import.",
      EXIT_CODE.USAGE
    );
  }

  const jql =
    customJql ??
    `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;

  console.error(`Fetching issues from Jira... (JQL: ${jql})`);

  let issues: JiraIssue[];
  try {
    issues = await fetchAllJiraIssues(creds.baseUrl, creds.authHeader, jql, maxResults);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const exitCode = /error 404/.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
    throw new CommandError(`Failed to fetch issues from Jira: ${msg}`, exitCode);
  }

  console.error(`Fetched ${issues.length} issues from Jira`);

  const mapped = issues.map((issue) => ({
    issue,
    item: issueToItem(issue, creds.baseUrl, statusMap),
  }));

  const filtered = statusFilter
    ? mapped.filter(({ item }) => item.status === statusFilter)
    : mapped;

  if (statusFilter && filtered.length !== mapped.length) {
    console.error(`Filtered to ${filtered.length} issues with pm status "${statusFilter}"`);
  }

  const projectLabel = project ?? "custom-jql";

  if (dryRun) {
    console.error(`[dry-run] Would create ${filtered.length} items:`);
    for (const { issue, item } of filtered.slice(0, 20)) {
      console.error(`  ${issue.key}: ${issue.fields.summary} [${item.status}]`);
    }
    if (filtered.length > 20) console.error(`  ... and ${filtered.length - 20} more`);
    return { success: true, dryRun: true, total: filtered.length, project: projectLabel };
  }

  let created = 0;
  for (const { issue, item } of filtered) {
    if (createPmItem(pmRoot, item)) created++;
    else console.error(`Failed to create item for ${issue.key}`);
  }

  console.error(`Imported ${created} issues from Jira ${projectLabel}`);
  return {
    success: true,
    synced: created,
    imported: created,
    total: filtered.length,
    project: projectLabel,
    summary: `Imported ${created} issues from Jira ${projectLabel}`,
  };
}

// ---------------------------------------------------------------------------
// Export core — render pm items as Jira-create payloads
// ---------------------------------------------------------------------------

interface PmItem {
  id?: string;
  title?: string;
  status?: string;
  body?: string;
  description?: string;
  tags?: string[];
}

function readPmItems(pmRoot: string): PmItem[] {
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list", "--full", "--include-body", "--limit", "10000"],
    { encoding: "utf-8" }
  );
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list failed");
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
    return items as PmItem[];
  } catch {
    throw new CommandError("Could not parse `pm list --json` output.");
  }
}

export interface JiraCreatePayload {
  fields: {
    project?: { key: string };
    summary: string;
    description: ReturnType<typeof plainTextToAdf>;
    issuetype: { name: string };
    labels: string[];
  };
}

// Convert a pm item to a Jira create payload. `projectKey` is optional so the
// transform stays pure/testable; the exporter requires it before POSTing.
export function itemToJiraPayload(item: PmItem, projectKey?: string): JiraCreatePayload {
  const summary = (item.title ?? "(untitled)").trim() || "(untitled)";
  const bodyText = item.body || item.description || "";
  return {
    fields: {
      ...(projectKey ? { project: { key: projectKey } } : {}),
      summary,
      description: plainTextToAdf(bodyText),
      issuetype: { name: "Task" },
      labels: (item.tags ?? []).map((t) => t.replace(/\s+/g, "-")),
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const PULL_FLAGS = [
  { long: "--project", value_name: "KEY", description: "Jira project key (e.g. PROJ)" },
  { long: "--jql", value_name: "query", description: "Custom JQL query (overrides --project default)" },
  { long: "--host", value_name: "url", description: "Jira base URL override (else JIRA_BASE_URL)" },
  { long: "--max-results", value_name: "n", description: "Max issues to fetch (default: 500)" },
  { long: "--status", value_name: "filter", description: "Filter by pm status (open|in_progress|closed|blocked)" },
  { long: "--status-map", value_name: "map", description: 'Override status mapping, e.g. "QA=blocked,Done=closed"' },
  { long: "--dry-run", description: "Preview without writing" },
];

const EXPORT_FLAGS = [
  { long: "--project", value_name: "KEY", description: "Target Jira project key for created issues" },
  { long: "--host", value_name: "url", description: "Jira base URL override (else JIRA_BASE_URL)" },
  { long: "--push", description: "POST the payloads to Jira (requires creds + --project)" },
];

export default defineExtension({
  name: "pm-jira",
  version: "2026.6.2",

  activate(api) {
    // -----------------------------------------------------------------------
    // schema — declare Jira provenance fields so the workspace knows them
    // -----------------------------------------------------------------------
    api.registerItemFields([
      { name: "jira_key", type: "string", optional: true },
      { name: "jira_url", type: "string", optional: true },
    ]);

    // -----------------------------------------------------------------------
    // Command: pm jira sync (legacy name; kept for back-compat)
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "jira sync",
      description: "Sync Jira issues into pm items",
      intent: "Import or update pm items from a Jira project using the Jira REST API",
      examples: [
        "pm jira sync --project PROJ",
        "pm jira sync --project PROJ --max-results 200",
        "pm jira sync --jql 'project = PROJ AND assignee = currentUser()'",
        "pm jira sync --project PROJ --status open --dry-run",
        "pm jira sync --project PROJ --status-map 'QA=blocked,Done=closed'",
      ],
      flags: PULL_FLAGS,
      async run(ctx) {
        return runImport(ctx.options, ctx.pm_root);
      },
    });

    // -----------------------------------------------------------------------
    // importer — `pm jira import` (native import pipeline)
    // -----------------------------------------------------------------------
    api.registerImporter("jira", async (ctx: any) => {
      return runImport(ctx.options || {}, ctx.pm_root);
    });

    // -----------------------------------------------------------------------
    // importer — `jira-sync` (config-driven; kept for back-compat)
    // Credentials may arrive via options (importer config) or env.
    // -----------------------------------------------------------------------
    api.registerImporter("jira-sync", async (ctx: any) => {
      const options = ctx.options || {};
      // Merge importer-config creds into a virtual env so resolveCreds can read
      // them uniformly without leaking secrets into process.env.
      const envLike: NodeJS.ProcessEnv = {
        ...process.env,
        ...(typeof options["JIRA_BASE_URL"] === "string" ? { JIRA_BASE_URL: options["JIRA_BASE_URL"] } : {}),
        ...(typeof options["JIRA_API_TOKEN"] === "string" ? { JIRA_API_TOKEN: options["JIRA_API_TOKEN"] } : {}),
        ...(typeof options["JIRA_EMAIL"] === "string" ? { JIRA_EMAIL: options["JIRA_EMAIL"] } : {}),
      };
      const creds = resolveCreds(options, envLike);
      const project = readStringOption(options, "project");
      const customJql = readStringOption(options, "jql");
      const maxResults = readNumberOption(options, "max-results") ?? 500;
      const statusMap = parseStatusMap(readStringOption(options, "status-map"));

      if (!project && !customJql) {
        throw new CommandError(
          "jira-sync importer requires either options.project or options.jql",
          EXIT_CODE.USAGE
        );
      }

      const jql =
        customJql ??
        `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;

      console.error(`[jira-sync] Fetching issues with JQL: ${jql}`);
      const issues = await fetchAllJiraIssues(creds.baseUrl, creds.authHeader, jql, maxResults);
      console.error(`[jira-sync] Importing ${issues.length} issues`);

      let created = 0;
      for (const issue of issues) {
        if (createPmItem(ctx.pm_root, issueToItem(issue, creds.baseUrl, statusMap))) created++;
      }
      console.error(`[jira-sync] Done. Imported ${created} issues.`);
      return { imported: created, total: issues.length };
    });

    // -----------------------------------------------------------------------
    // exporter — `pm jira export` (render pm items as Jira-create payloads)
    // Default: print the JSON payloads. With --push AND creds AND --project,
    // POST each payload to Jira's create-issue API.
    // -----------------------------------------------------------------------
    api.registerExporter("jira", async (ctx: any) => {
      const options = ctx.options || {};
      const push = readBooleanOption(options, "push");
      const project = readStringOption(options, "project");
      const items = readPmItems(ctx.pm_root);

      if (push) {
        // Resolve creds first so the missing-creds path returns a structured
        // CommandError before we ever build payloads or hit the network.
        const creds = resolveCreds(options);
        if (!project) {
          throw new CommandError(
            "--push requires --project <KEY> (the target Jira project for new issues).",
            EXIT_CODE.USAGE
          );
        }
        const payloads = items.map((item) => itemToJiraPayload(item, project));
        let created = 0;
        for (const payload of payloads) {
          try {
            await httpsPost(
              `${creds.baseUrl}/rest/api/3/issue`,
              creds.authHeader,
              JSON.stringify(payload)
            );
            created++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new CommandError(`Failed to create Jira issue: ${msg}`);
          }
        }
        console.error(`Created ${created} issue(s) in Jira project ${project}.`);
        return { pushed: true, created, project };
      }

      const payloads = items.map((item) => itemToJiraPayload(item, project));
      console.log(JSON.stringify(payloads, null, 2));
      return { exported: payloads.length, pushed: false };
    });
  },
});
