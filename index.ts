// pm-jira — Jira issue sync / importer / exporter for pm-cli
//
// Capabilities (see manifest.json):
//   commands  — `pm jira sync` (legacy, full-featured pull) + `pm jira validate`
//   importers — `pm jira import` (native import pipeline: pull issues via JQL)
//             — `jira-sync` (config-driven importer, kept for back-compat)
//             — `pm jira export` exporter (registerExporter is gated by the
//               `importers` capability; `exporters` is NOT a valid manifest
//               token). Renders pm items as Jira-create payloads; only POSTs
//               with explicit --push AND creds present.
//   schema    — declares jira_key / jira_url item fields
//   hooks     — opt-in best-effort export-on-write mirror (PM_JIRA_PUSH_ON_WRITE)
//   preflight — fail-fast credential gate (registerPreflight): aborts a
//               network-mutating `pm jira sync|import` (and `export --push`)
//               BEFORE any pm-store read or Jira call when JIRA_BASE_URL /
//               JIRA_EMAIL / JIRA_API_TOKEN are missing. Skips --dry-run and
//               `jira validate` (offline diagnostics).
//
// NOTE: the prior manifest declared `services` but never called
// registerService — that was a no-op "phantom" capability. We dropped it and
// added `hooks` (which we actually register). We deliberately do NOT register
// a service override: per pm-cli issue #96 overriding a core service can
// corrupt all command output.

import https from "node:https";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";
import type {
  BulkItemCreateMutation,
  BulkItemMutation,
  CommitItemMutationsOptions,
  CommitItemMutationsResult,
} from "@unbrained/pm-cli/sdk";

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

export interface JiraIssue {
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
    components?: Array<{ name: string }>;
    assignee?: { displayName: string; emailAddress: string } | null;
    duedate?: string | null;
    fixVersions?: Array<{ name: string }>;
    issuetype?: { name: string } | null;
    customfield_10020?: Array<{ name?: string }> | { name?: string } | null;
    // Optional metadata used only for transparency notes: pm-jira does NOT
    // import attachments or comments, so we surface their presence to STDERR
    // rather than silently dropping them. `comment` is Jira's paginated comment
    // container; we read its `total`/length defensively.
    attachment?: Array<unknown> | null;
    comment?: { total?: number; comments?: Array<unknown> } | null;
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

// Map a Jira statusCategory key (the workflow-agnostic bucket Jira assigns to
// every status: "new" | "indeterminate" | "done") to a pm status. This is a
// robust fallback that works across custom workflows where the status *name*
// is unrecognized but the category is always one of three known values.
export function mapJiraStatusCategory(categoryKey: string | undefined): PmStatus {
  switch ((categoryKey ?? "").toLowerCase()) {
    case "done":
      return "closed";
    case "indeterminate":
      return "in_progress";
    case "new":
    default:
      return "open";
  }
}

// Map a Jira issue type to a pm item type. Defaults follow pm's common type
// vocabulary; a `--map issuetype=<pmType>` override can replace the result.
export function mapJiraIssueType(jiraType: string | undefined): string {
  const name = (jiraType ?? "").toLowerCase();
  if (name === "bug" || name === "defect") return "Bug";
  if (name === "story" || name === "user story") return "Feature";
  if (name === "epic") return "Feature";
  if (name === "task" || name === "sub-task" || name === "subtask") return "Task";
  return "Issue";
}

// Reverse priority map: pm priority (1..4) -> Jira priority name, for export.
export function mapPmPriorityToJira(priority: PmPriority | number | undefined): string {
  switch (priority) {
    case 1:
      return "Highest";
    case 2:
      return "High";
    case 4:
      return "Low";
    case 3:
    default:
      return "Medium";
  }
}

const PM_STATUSES: readonly PmStatus[] = ["open", "in_progress", "closed", "blocked"];

// Human-friendly status aliases accepted anywhere the user can provide a pm
// status (e.g. --status and --status-map targets). This keeps canonical wire
// values stable while making CLI input forgiving.
const PM_STATUS_ALIASES: Record<string, PmStatus> = {
  open: "open",
  todo: "open",
  to_do: "open",
  backlog: "open",
  new: "open",
  in_progress: "in_progress",
  inprogress: "in_progress",
  wip: "in_progress",
  active: "in_progress",
  doing: "in_progress",
  in_review: "in_progress",
  in_development: "in_progress",
  closed: "closed",
  done: "closed",
  complete: "closed",
  completed: "closed",
  resolved: "closed",
  blocked: "blocked",
  block: "blocked",
  on_hold: "blocked",
  hold: "blocked",
};

function normalizeStatusAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizePmStatusInput(value: string | undefined): PmStatus | undefined {
  if (!value || !value.trim()) return undefined;
  return PM_STATUS_ALIASES[normalizeStatusAliasKey(value)];
}

export interface StatusFilterResolution {
  mode: "none" | "pm" | "jira";
  raw?: string;
  pmStatus?: PmStatus;
}

// Distinguish status input that should become a pm-side post-filter from a raw
// Jira status name that should only be applied server-side in JQL.
export function resolveStatusFilter(value: string | undefined): StatusFilterResolution {
  const raw = value?.trim();
  if (!raw) return { mode: "none" };
  const pmStatus = normalizePmStatusInput(raw);
  if (pmStatus) return { mode: "pm", raw, pmStatus };
  return { mode: "jira", raw };
}

// ---------------------------------------------------------------------------
// --map field overrides — a comma list of "jiraField=pmField" pairs that let a
// caller remap which Jira field feeds which pm concept (or pin a pm type/
// status). Pure + offline-testable. Recognized jira-side keys:
//   status | statuscategory | priority | issuetype | labels | fixversions |
//   components | sprint | assignee | duedate
// Recognized pm-side targets are validated per key where it matters; freeform
// values are accepted for type/status pins so custom workflows work.
// ---------------------------------------------------------------------------

export type FieldMap = Record<string, string>;

const KNOWN_MAP_KEYS = new Set([
  "status",
  "statuscategory",
  "priority",
  "issuetype",
  "labels",
  "fixversions",
  "components",
  "sprint",
  "sprints",
  "customfield_10020",
  "assignee",
  "duedate",
  "type",
]);

function fieldMapSkips(fieldMap: FieldMap | undefined, ...keys: string[]): boolean {
  return keys.some((key) => {
    const value = fieldMap?.[key]?.toLowerCase();
    return value === "skip" || value === "ignore";
  });
}

export function parseFieldMap(raw: string | undefined): FieldMap | undefined {
  if (!raw) return undefined;
  const map: FieldMap = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      throw new CommandError(
        `Invalid --map entry "${trimmed}" (expected "jiraField=pmField").`,
        EXIT_CODE.USAGE
      );
    }
    const from = trimmed.slice(0, eq).trim().toLowerCase();
    const to = trimmed.slice(eq + 1).trim();
    if (!from || !to) {
      throw new CommandError(
        `Invalid --map entry "${trimmed}" (empty field name).`,
        EXIT_CODE.USAGE
      );
    }
    if (!KNOWN_MAP_KEYS.has(from)) {
      throw new CommandError(
        `Unknown --map source field "${from}" (expected one of ${[...KNOWN_MAP_KEYS].join("|")}).`,
        EXIT_CODE.USAGE
      );
    }
    map[from] = to;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

// Parse a --status-map value of the form
//   "In Progress=in_progress,QA=blocked"
// into a lower-cased lookup table. Target values accept canonical pm statuses
// plus common aliases (e.g. done -> closed, wip -> in_progress).
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
    const toRaw = trimmed.slice(eq + 1).trim();
    if (!from) {
      throw new CommandError(
        `Invalid --status-map entry "${trimmed}" (empty Jira status).`,
        EXIT_CODE.USAGE
      );
    }
    const to = normalizePmStatusInput(toRaw);
    if (!to) {
      throw new CommandError(
        `Invalid --status-map target "${toRaw}" (expected one of ${PM_STATUSES.join("|")} ` +
          `or aliases like todo/wip/done/on-hold).`,
        EXIT_CODE.USAGE
      );
    }
    map[from] = to;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

// ---------------------------------------------------------------------------
// JQL builder — compose convenience filters into a single JQL query.
//
// Pure + offline-testable. `--jql` always wins (returned verbatim). Otherwise
// the project / status / assignee / issue-type / label / updated-since filters
// are AND-combined and ordered. When nothing constrains the query we keep the
// historical default of "not done, by priority" so back-compat holds.
// ---------------------------------------------------------------------------

export interface JqlFilters {
  jql?: string;
  project?: string;
  // A pm status (canonical or alias, e.g. wip/done) OR a raw Jira status name.
  status?: string;
  assignee?: string;
  issueType?: string;
  label?: string;
  // Relative ("-7d") or absolute ("2026-01-01") Jira date expression.
  updatedSince?: string;
}

// Map a pm status to the Jira statusCategory clause it implies, so
// `--status closed` can filter Jira-side without enumerating every workflow
// state. Unknown / raw Jira statuses are matched literally on `status`.
const PM_STATUS_TO_JQL: Record<PmStatus, string> = {
  open: "statusCategory = \"To Do\"",
  in_progress: "statusCategory = \"In Progress\"",
  closed: "statusCategory = Done",
  blocked: "status = \"Blocked\"",
};

// Quote a JQL value: numbers/keys stay bare where Jira allows it, but anything
// with whitespace or punctuation is wrapped in double quotes (escaping any
// embedded quote) so user input can't break out of the clause.
export function jqlQuote(value: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildJql(filters: JqlFilters): string {
  // Explicit --jql is authoritative; never rewrite a user's query.
  if (filters.jql && filters.jql.trim()) return filters.jql.trim();

  const clauses: string[] = [];
  if (filters.project) clauses.push(`project = ${jqlQuote(filters.project)}`);

  if (filters.status) {
    const raw = filters.status.trim();
    const pmStatus = normalizePmStatusInput(raw);
    clauses.push(pmStatus ? PM_STATUS_TO_JQL[pmStatus] : `status = ${jqlQuote(raw)}`);
  }

  if (filters.assignee) {
    const a = filters.assignee.trim();
    // Recognize the JQL function forms so `--assignee currentUser()` works.
    clauses.push(/\(\s*\)$/.test(a) ? `assignee = ${a}` : `assignee = ${jqlQuote(a)}`);
  }

  if (filters.issueType) clauses.push(`issuetype = ${jqlQuote(filters.issueType)}`);
  if (filters.label) clauses.push(`labels = ${jqlQuote(filters.label)}`);
  if (filters.updatedSince) {
    // Always quote the date expression: Jira parses a bare "-7d" as arithmetic,
    // so the relative form must be a quoted string ("-7d") to be valid JQL.
    const d = filters.updatedSince.trim();
    clauses.push(`updated >= "${d.replace(/"/g, '\\"')}"`);
  }

  // With no constraints at all, preserve the historical default. Otherwise, if
  // the caller did not themselves filter on status, keep "not done" so an
  // unscoped project pull stays focused on active work (back-compat default).
  if (clauses.length === 0) {
    return "statusCategory != Done ORDER BY priority ASC";
  }
  if (!filters.status) clauses.push("statusCategory != Done");

  return `${clauses.join(" AND ")} ORDER BY priority ASC`;
}

// Read the convenience JQL filters off a loose options bag (kebab/camel safe).
export function readJqlFilters(options: Record<string, unknown>): JqlFilters {
  return {
    jql: readStringOption(options, "jql"),
    project: readStringOptionAliased(options, "project", "project-key"),
    status: readStringOption(options, "status"),
    assignee: readStringOption(options, "assignee"),
    issueType: readStringOption(options, "issue-type"),
    label: readStringOption(options, "label"),
    updatedSince: readStringOption(options, "updated-since"),
  };
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

// Read a string option with one or more alias keys (kebab or camel). Returns the
// first non-empty value. Used to surface user-friendly flag aliases like
// --field-map (alias for --map) and --project-key (alias for --project) without
// duplicating the read logic at every call site.
export function readStringOptionAliased(
  options: Record<string, unknown>,
  ...kebabs: string[]
): string | undefined {
  for (const kebab of kebabs) {
    const value = readStringOption(options, kebab);
    if (value !== undefined) return value;
  }
  return undefined;
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
// Credential diagnostics — report readiness WITHOUT leaking any secret value.
// Pure + offline-testable: never performs a network call, never echoes the
// token or email. Booleans + a redacted host preview only.
// ---------------------------------------------------------------------------

export interface CredDiagnostics {
  ready: boolean;
  baseUrlPresent: boolean;
  emailPresent: boolean;
  tokenPresent: boolean;
  baseUrlSource: "option" | "env" | "none";
  // A redacted host preview, e.g. "company.atlassian.net" (hostname only, no
  // scheme/path) — safe to print; never the token or email.
  hostPreview?: string;
  missing: string[];
}

export function diagnoseCreds(
  options: Record<string, unknown>,
  envLike: NodeJS.ProcessEnv = process.env
): CredDiagnostics {
  const hostOption = readStringOption(options, "host");
  const baseUrlEnv = envLike["JIRA_BASE_URL"]?.trim() || undefined;
  const baseUrl = hostOption ?? baseUrlEnv;
  const email = envLike["JIRA_EMAIL"]?.trim() || undefined;
  const token = envLike["JIRA_API_TOKEN"]?.trim() || undefined;

  const missing: string[] = [];
  if (!baseUrl) missing.push("JIRA_BASE_URL (or --host)");
  if (!email) missing.push("JIRA_EMAIL");
  if (!token) missing.push("JIRA_API_TOKEN");

  let hostPreview: string | undefined;
  if (baseUrl) {
    try {
      hostPreview = new URL(/^https?:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`).hostname;
    } catch {
      hostPreview = undefined;
    }
  }

  return {
    ready: missing.length === 0,
    baseUrlPresent: Boolean(baseUrl),
    emailPresent: Boolean(email),
    tokenPresent: Boolean(token),
    baseUrlSource: hostOption ? "option" : baseUrlEnv ? "env" : "none",
    hostPreview,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Preflight gate logic — pure + offline-testable.
//
// Decides whether the credential fail-fast gate should fire for a given
// (command, options) pair. The gate fires ONLY for pm-jira's network-mutating
// command paths AND only when the invocation will actually reach Jira:
//
//   "jira sync"   — pulls issues over the network UNLESS --dry-run.
//   "jira import" — same native import pipeline; mutating UNLESS --dry-run.
//   "jira export" — offline by default (prints payloads); only reaches Jira
//                   with --push. So it is mutating ONLY when push is set AND
//                   not --dry-run.
//
// It deliberately does NOT fire for:
//   - any non-pm-jira command (scoped by command prefix),
//   - "jira validate" (diagnostics; must work without creds),
//   - any --dry-run invocation (offline preview must work without creds),
//   - "jira export" without --push (offline payload print).
//
// When the invocation IS mutating, the gate fires iff creds are NOT ready.
// Note: pm-cli normalizes extension flags to camelCase, so --dry-run arrives
// as `dryRun` and --push as `push`; readBooleanOption already reads both forms.
// ---------------------------------------------------------------------------

export function isMutatingJiraInvocation(
  command: string,
  options: Record<string, unknown>
): boolean {
  const dryRun = readBooleanOption(options, "dry-run");
  switch (command) {
    case "jira sync":
    case "jira import":
      // Network pull unless previewing.
      return !dryRun;
    case "jira export":
      // Offline by default; only hits Jira with --push (and never on --dry-run).
      return readBooleanOption(options, "push") && !dryRun;
    default:
      // Includes "jira validate" and every non-pm-jira command.
      return false;
  }
}

export function jiraPreflightShouldFailFast(
  command: string,
  options: Record<string, unknown>,
  envLike: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isMutatingJiraInvocation(command, options)) return false;
  return !diagnoseCreds(options, envLike).ready;
}

// Build the actionable fail-fast message. Mirrors resolveCreds' guidance and
// never echoes any secret value — only the names of the missing variables.
export function jiraPreflightErrorMessage(
  command: string,
  diag: CredDiagnostics
): string {
  return (
    `pm-jira preflight: cannot run "pm ${command}" — missing Jira credentials: ` +
    `${diag.missing.join(", ")}. ` +
    `Set JIRA_BASE_URL (or pass --host), JIRA_EMAIL, and JIRA_API_TOKEN before a ` +
    `mutating command. Create a token at ` +
    `https://id.atlassian.com/manage-profile/security/api-tokens . ` +
    `Run "pm jira validate" to diagnose, or add --dry-run to preview offline.`
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers using Node.js native https module
// ---------------------------------------------------------------------------

// Classify a non-2xx Jira REST response into an actionable error message.
// Auth failures (401/403) get a dedicated, prescriptive message that names the
// likely root causes (expired/revoked token, wrong email, MFA/API-token
// mismatch, missing scopes) and points at the token-management URL — so a
// generic "Jira API error 401" never leaves a user guessing. Other status codes
// fall through to the compact body preview. Pure + offline-testable.
export function classifyHttpError(statusCode: number | undefined, body: unknown): string {
  const code = statusCode ?? 0;
  const snippet = typeof body === "string" ? body.slice(0, 200) : "";
  if (code === 401) {
    return (
      `Jira authentication failed (HTTP 401). The JIRA_EMAIL / JIRA_API_TOKEN pair was ` +
      `rejected. Common causes: the API token was revoked or expired, the email is ` +
      `wrong, or you are using a password instead of an API token ` +
      `(Jira no longer accepts basic auth with account passwords). Regenerate a token ` +
      `at https://id.atlassian.com/manage-profile/security/api-tokens and update ` +
      `JIRA_API_TOKEN. Response: ${snippet}`
    );
  }
  if (code === 403) {
    return (
      `Jira authorization failed (HTTP 403). The credentials are valid but the account ` +
      `lacks permission for this resource (check project access, issue-level perms, ` +
      `and that the token's product scope includes Jira). Response: ${snippet}`
    );
  }
  return `Jira API error ${code}: ${snippet}`;
}

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
          reject(new Error(classifyHttpError(res.statusCode, body)));
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
          reject(new Error(classifyHttpError(res.statusCode, body)));
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

// PUT an existing Jira issue (the update path). Jira's edit-issue endpoint
// returns 204 No Content on success with an empty body, so we resolve with the
// (possibly empty) body and let callers treat a non-4xx/5xx as success.
function httpsPut(url: string, authHeader: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "PUT",
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
          reject(new Error(classifyHttpError(res.statusCode, body)));
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

// Format a per-page import progress line, e.g. "Fetched 200/512...". The
// effective total is clamped to maxResults (we never fetch beyond it) so the
// denominator reflects what the import will actually pull. Pure + testable;
// the importer streams these to STDERR only (stdout/json contract unchanged).
export function formatImportProgress(
  fetched: number,
  jiraTotal: number,
  maxResults: number
): string {
  const effectiveTotal = Math.min(jiraTotal, maxResults);
  return `Fetched ${fetched}/${effectiveTotal}...`;
}

async function fetchAllJiraIssues(
  baseUrl: string,
  authHeader: string,
  jql: string,
  maxResults: number,
  onProgress?: (fetched: number, jiraTotal: number) => void
): Promise<JiraIssue[]> {
  const allIssues: JiraIssue[] = [];
  let startAt = 0;
  const pageSize = Math.min(maxResults, 100);

  while (allIssues.length < maxResults) {
    const remaining = maxResults - allIssues.length;
    const fetchSize = Math.min(remaining, pageSize);
    // Reuse the single source-of-truth request builder so the live fetch and
    // the --dry-run preview can never drift apart.
    const { url } = buildSearchRequest(baseUrl, jql, startAt, fetchSize);

    const raw = await httpsGet(url, authHeader);
    const data = JSON.parse(raw) as JiraSearchResponse;

    if (!data.issues || data.issues.length === 0) break;
    allIssues.push(...data.issues);
    startAt += data.issues.length;

    // Stream paginated progress to the caller (stderr-only). Emitted per page
    // so a large multi-page import surfaces feedback instead of looking hung.
    onProgress?.(allIssues.length, data.total);

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
  type: string;
  body: string;
  tags: string[];
  deadline?: string;
  description: string;
  jiraKey: string;
  jiraUrl: string;
}

export interface IssueMapOptions {
  statusMap?: Record<string, PmStatus>;
  fieldMap?: FieldMap;
}

export function issueToItem(
  issue: JiraIssue,
  baseUrl: string,
  optionsOrStatusMap?: IssueMapOptions | Record<string, PmStatus>
): IssueToItem {
  // Back-compat: a bare statusMap (the old 3rd arg) is still accepted.
  const mapOptions: IssueMapOptions =
    optionsOrStatusMap && ("statusMap" in optionsOrStatusMap || "fieldMap" in optionsOrStatusMap)
      ? (optionsOrStatusMap as IssueMapOptions)
      : { statusMap: optionsOrStatusMap as Record<string, PmStatus> | undefined };
  const { statusMap, fieldMap } = mapOptions;

  const tags: string[] = [];
  const addTag = (tag: string | undefined) => {
    const clean = tag?.trim();
    if (clean && !tags.includes(clean)) tags.push(clean);
  };
  if (!fieldMapSkips(fieldMap, "labels")) {
    for (const label of issue.fields.labels ?? []) addTag(label);
  }
  if (!fieldMapSkips(fieldMap, "fixversions")) {
    for (const version of issue.fields.fixVersions ?? []) addTag(version.name);
  }
  if (!fieldMapSkips(fieldMap, "components")) {
    for (const component of issue.fields.components ?? []) addTag(`component:${component.name}`);
  }
  if (!fieldMapSkips(fieldMap, "sprint", "sprints", "customfield_10020")) {
    const sprintField = issue.fields.customfield_10020;
    const sprintEntries = Array.isArray(sprintField) ? sprintField : sprintField ? [sprintField] : [];
    for (const sprint of sprintEntries) addTag(sprint.name ? `sprint:${sprint.name}` : undefined);
  }
  // Assignee → tag (so it survives without a dedicated pm field) unless --map
  // assignee=<x> pins it elsewhere or the user opts out with assignee=skip/ignore.
  if (issue.fields.assignee?.displayName && !fieldMapSkips(fieldMap, "assignee")) {
    addTag(`assignee:${issue.fields.assignee.displayName.replace(/\s+/g, "-")}`);
  }

  // Status: prefer an explicit name mapping; fall back to the statusCategory
  // bucket when the name is unrecognized. --map statuscategory=<pmStatus> pins.
  const categoryPin = fieldMap?.["statuscategory"] as PmStatus | undefined;
  const statusPin = fieldMap?.["status"] as PmStatus | undefined;
  let status: PmStatus;
  if (statusPin && PM_STATUSES.includes(statusPin)) {
    status = statusPin;
  } else {
    const byName = mapJiraStatus(issue.fields.status.name, statusMap);
    // If name resolution defaulted to "open" but the category says otherwise,
    // trust the category (covers custom workflow states).
    const byCategory = categoryPin && PM_STATUSES.includes(categoryPin)
      ? categoryPin
      : mapJiraStatusCategory(issue.fields.status.statusCategory?.key);
    status = byName === "open" && byCategory !== "open" ? byCategory : byName;
  }

  // Type: --map type=<x> / issuetype=<x> pins; else derive from Jira issuetype.
  const typePin = fieldMap?.["type"] ?? fieldMap?.["issuetype"];
  const type = typePin ?? mapJiraIssueType(issue.fields.issuetype?.name);

  const rawBody = adfToPlainText(issue.fields.description);
  const browseUrl = `${baseUrl.replace(/\/$/, "")}/browse/${issue.key}`;
  return {
    title: `[${issue.key}] ${issue.fields.summary}`,
    status,
    priority: mapJiraPriority(issue.fields.priority?.name),
    type,
    body: rawBody,
    tags,
    deadline: fieldMapSkips(fieldMap, "duedate") ? undefined : issue.fields.duedate ?? undefined,
    // Provenance marker lives in the description so it survives round-trips.
    description: jiraProvenance(issue.key, browseUrl),
    jiraKey: issue.key,
    jiraUrl: browseUrl,
  };
}

function createPmItem(pmRoot: string, item: IssueToItem): boolean {
  const args = [
    "--path", pmRoot,
    "create",
    "--title", item.title,
    "--status", item.status,
    "--type", item.type,
    "--priority", String(item.priority),
    "--description", item.description,
    ...(item.body ? ["--body", item.body] : []),
    ...(item.deadline ? ["--deadline", item.deadline] : []),
    ...(item.tags.length > 0 ? ["--tags", item.tags.join(",")] : []),
  ];
  const result = spawnSync("pm", args, { encoding: "utf-8" });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Atomic import (pm-cli >= 2026.7.20 commitItemMutations)
//
// `pm jira import --atomic` commits ALL imported creates in ONE
// all-or-nothing, crash-recoverable, workspace-writer-locked transaction via
// the official high-level SDK helper `commitItemMutations`. On failure every
// applied create is compensated (deleted) so the tracker keeps zero committed
// items from the import. An interrupted run resumes on re-invocation because
// the transaction id and per-create ids are derived deterministically from
// the imported content (same issues => same ids => resume, never duplicate).
// ---------------------------------------------------------------------------

/**
 * Stable transaction-id prefix for pm-jira atomic imports. Prefixed so a
 * jira transaction id never collides with one derived by another importer
 * (e.g. pm-csv's `csv-import-<hash>`).
 */
const ATOMIC_TX_PREFIX = "jira-import-";

/**
 * The bound `commitItemMutations` signature the atomic path calls. Resolved
 * once per process via a dynamic `import("@unbrained/pm-cli/sdk")`; injectable
 * through {@link ImportRunOptions.commitItemMutations} for tests.
 */
type CommitItemMutations = (
  options: CommitItemMutationsOptions,
) => Promise<CommitItemMutationsResult>;

/**
 * Cached resolved SDK `commitItemMutations`. `null` means a prior resolution
 * attempt failed in this process and is not retried (each CLI invocation is a
 * fresh process, so this is safe).
 */
let cachedCommitItemMutations: CommitItemMutations | null | undefined;

/**
 * Assert a dynamically-resolved `@unbrained/pm-cli/sdk` export is callable,
 * throwing the shared, friendly {@link CommandError} (USAGE) when the installed
 * SDK is too old to provide it. Centralizing this guard keeps the check and the
 * upgrade message identical across every --atomic SDK dependency
 * (`commitItemMutations`, `normalizeItemId`, `readSettings`) so the copies can
 * never drift, and stops missing exports falling through to a raw `TypeError`.
 */
function assertSdkFunction<F>(fn: unknown, exportName: string): F {
  if (typeof fn !== "function") {
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the installed SDK does not export ${exportName} as a function. Upgrade @unbrained/pm-cli to >=2026.7.20.`,
      EXIT_CODE.USAGE,
    );
  }
  return fn as F;
}

/**
 * Dynamically resolve the SDK `commitItemMutations` helper, throwing a clear,
 * actionable {@link CommandError} when the installed @unbrained/pm-cli is too
 * old to export it (requires >=2026.7.20). Mirrors pm-csv's
 * `resolveCommitWorkspaceTransaction` UX. The resolved function is cached at
 * module scope so repeated --atomic calls don't re-import the SDK.
 *
 * `importSdk` is an injection seam for tests: when supplied, the module-level
 * cache is bypassed and the SAME import-failure / not-a-function guards run
 * against the injected module, so both error branches are unit-testable
 * without an actual old SDK on disk. Production always uses the default
 * (cached) dynamic import.
 */
export async function resolveCommitItemMutations(
  importSdk?: () => Promise<Partial<typeof import("@unbrained/pm-cli/sdk")>>,
): Promise<CommitItemMutations> {
  if (importSdk) {
    let mod: Partial<typeof import("@unbrained/pm-cli/sdk")>;
    try {
      mod = await importSdk();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CommandError(
        `--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
        EXIT_CODE.USAGE,
      );
    }
    return assertSdkFunction<CommitItemMutations>(
      mod.commitItemMutations,
      "commitItemMutations",
    );
  }
  if (cachedCommitItemMutations === null) {
    throw new CommandError(
      "--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but it could not be resolved (a prior attempt in this process failed). Ensure @unbrained/pm-cli is installed and up to date.",
      EXIT_CODE.USAGE,
    );
  }
  if (cachedCommitItemMutations) return cachedCommitItemMutations;
  let mod: typeof import("@unbrained/pm-cli/sdk");
  try {
    mod = await import("@unbrained/pm-cli/sdk");
  } catch (err: unknown) {
    cachedCommitItemMutations = null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
      EXIT_CODE.USAGE,
    );
  }
  let commit: CommitItemMutations;
  try {
    commit = assertSdkFunction<CommitItemMutations>(
      mod.commitItemMutations,
      "commitItemMutations",
    );
  } catch (err: unknown) {
    // Poison the cache so a later --atomic call in this process short-circuits
    // to the "prior attempt failed" guard instead of re-importing the old SDK.
    cachedCommitItemMutations = null;
    throw err;
  }
  cachedCommitItemMutations = commit;
  return commit;
}

/**
 * Derive a stable, resumable transaction id from the exact content being
 * imported: the ordered list of Jira issue keys plus the JQL/project that
 * scoped them. `jira-import-<sha1(jql \x1f sortedKeys)>` (12 hex chars).
 *
 * Folding the content (not just the project) into the id means: re-running
 * the SAME import after a crash keeps the same id (resumes from the durable
 * journal, no duplicates), while a DIFFERENT set of issues yields a fresh id
 * (a new import, never a stale skip). Mirrors pm-csv's
 * `deriveTransactionId`/`fingerprintContent` derivation.
 */
export function deriveAtomicTransactionId(
  jql: string,
  issueKeys: readonly string[],
): string {
  // Sort the keys before hashing so the id is INDEPENDENT of Jira's result
  // ordering — Jira does not guarantee a stable order without an explicit
  // ORDER BY, so a crash + retry can re-fetch the same issues in a different
  // sequence. Hashing sorted keys keeps "same issues => same transactionId =>
  // resume" true regardless of fetch order (the crash-recovery contract).
  const sortedKeys = [...issueKeys].sort();
  const hash = createHash("sha1")
    .update(jql)
    .update("\x1f") // unit-separator between scope and content
    .update(JSON.stringify(sortedKeys))
    .digest("hex")
    .slice(0, 12);
  return `${ATOMIC_TX_PREFIX}${hash}`;
}

/**
 * Build one {@link BulkItemCreateMutation} for an imported issue.
 *
 * Each create gets a STABLE, transaction-owned id derived deterministically
 * from `(transactionId, jiraKey)` so a retried transaction resumes instead of
 * duplicating: `normalizeItemId("jira-tx-<sha1(transactionId)[:8]>-<sanitizedKey>", prefix)`.
 * The id is keyed on the Jira issue KEY (globally unique + stable per issue),
 * NOT the positional index — otherwise a crash + retry that re-fetches the
 * same issues in a DIFFERENT order (Jira gives no stable order without
 * ORDER BY) would map the same issue to a different index => a different id =>
 * a duplicate create instead of a resume. Jira guarantees unique keys, so the
 * sanitized key is structurally unique within a batch; the content-derived
 * transactionId prefix scopes ids to this import. `normalizeItemId` lowercases
 * the input and prepends the normalized prefix when absent, so the token
 * (already lowercase) round-trips deterministically. The `options` bag mirrors
 * the exact `pm create` flags the non-atomic path uses
 * (title/type/status/priority/description/body/deadline/tags).
 */
export function buildAtomicCreateMutation(
  item: IssueToItem,
  jiraKey: string,
  transactionId: string,
  idPrefix: string,
  normalizeItemId: (input: string, prefix: string) => string,
): BulkItemCreateMutation {
  // Short, stable digest of the whole transaction id; the sanitized Jira key
  // suffix (appended below) is what guarantees a stable, distinct id per issue
  // regardless of the order Jira returns results in.
  const txToken = createHash("sha1")
    .update(transactionId)
    .digest("hex")
    .slice(0, 8);
  // Jira keys are [A-Z][A-Z0-9]+-<n>; lowercase + collapse any stray
  // non-alphanumerics so the token is a valid, stable id component.
  const keyToken = jiraKey.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const id = normalizeItemId(`jira-tx-${txToken}-${keyToken}`, idPrefix);
  const options: BulkItemCreateMutation["options"] = {
    title: item.title,
    status: item.status,
    type: item.type,
    priority: item.priority,
    description: item.description,
    ...(item.body ? { body: item.body } : {}),
    ...(item.deadline ? { deadline: item.deadline } : {}),
    ...(item.tags.length > 0 ? { tags: item.tags.join(",") } : {}),
  };
  return { op: "create", id, options };
}

/**
 * Commit every imported create in one atomic, crash-recoverable transaction
 * via the official `commitItemMutations` SDK helper. On failure every applied
 * create is compensated (deleted) so no committed items remain, and a clear
 * {@link CommandError} is thrown. Returns the count of items committed by
 * this attempt (already-applied steps from a prior interrupted run are
 * resumed, not double-counted). Throws CommandError (USAGE) when the SDK
 * cannot be resolved.
 */
export async function importJiraAtomic(
  pmRoot: string,
  jql: string,
  filtered: readonly { issue: JiraIssue; item: IssueToItem }[],
  opts: ImportRunOptions,
): Promise<{ created: number; recovered: boolean; transactionId: string }> {
  const issueKeys = filtered.map(({ issue }) => issue.key);
  const transactionId = deriveAtomicTransactionId(jql, issueKeys);
  const author = opts.atomicAuthor ?? "pm-jira";

  // Resolve the SDK helpers once: commitItemMutations (guarded), plus the
  // synchronous normalizeItemId and async readSettings used for stable id +
  // prefix derivation. An injected commitItemMutations (tests) short-circuits
  // the dynamic import; the id helpers are also injectable.
  const commit: CommitItemMutations = opts.commitItemMutations
    ? opts.commitItemMutations
    : await resolveCommitItemMutations();
  // Resolve the SDK once through the SAME guarded path used for
  // commitItemMutations, so a missing/old SDK surfaces the friendly
  // "upgrade to >=2026.7.20" CommandError rather than a raw module-not-found
  // rejection when normalizeItemId/readSettings are not injected (tests).
  let sdkHelpers: typeof import("@unbrained/pm-cli/sdk") | undefined;
  const getSdk = async (): Promise<typeof import("@unbrained/pm-cli/sdk")> => {
    if (sdkHelpers) return sdkHelpers;
    try {
      sdkHelpers = await import("@unbrained/pm-cli/sdk");
      return sdkHelpers;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CommandError(
        `--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
        EXIT_CODE.USAGE,
      );
    }
  };
  const normalizeItemId: (input: string, prefix: string) => string =
    opts.normalizeItemId ??
    assertSdkFunction<(input: string, prefix: string) => string>(
      (await getSdk()).normalizeItemId,
      "normalizeItemId",
    );
  const readSettings: (pmRoot: string) => Promise<{ id_prefix?: string }> =
    opts.readSettings ??
    assertSdkFunction<(pmRoot: string) => Promise<{ id_prefix?: string }>>(
      (await getSdk()).readSettings,
      "readSettings",
    );

  let idPrefix = "pm-";
  try {
    const settings = await readSettings(pmRoot);
    if (settings?.id_prefix) idPrefix = settings.id_prefix.toString();
  } catch {
    // Settings unreadable: fall back to the default prefix so the atomic path
    // still works (the non-atomic path never reads settings either).
  }

  const mutations: BulkItemMutation[] = filtered.map(({ issue, item }) =>
    buildAtomicCreateMutation(item, issue.key, transactionId, idPrefix, normalizeItemId),
  );

  let result: CommitItemMutationsResult;
  try {
    result = await commit({
      pmRoot,
      transactionId,
      author,
      mutations,
      createCompensation: "delete",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Every applied create has been compensated (deleted) by the helper; no
    // committed items from this import remain in the tracker.
    throw new CommandError(
      `Atomic Jira import failed and was rolled back — every applied create was compensated (deleted); the tracker has no committed items from this import. Transaction id: ${transactionId}. Underlying error: ${msg}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  // Defensive: the SDK contract guarantees results/recovered on success, but a
  // mock/test seam could return a partial shape — coalesce rather than throw.
  const created = Object.keys(result?.results ?? {}).length;
  return { created, recovered: Boolean(result?.recovered), transactionId };
}

// Shared import core for both `pm jira sync`, `pm jira import` and the
// `jira-sync` importer. Throws CommandError (semantic exitCode) on failure.
// Build the exact Jira search GET request that an import WOULD issue. Pure +
// offline-testable; used both by the live fetch and by --dry-run preview.
export interface JiraSearchRequest {
  method: "GET";
  url: string;
  fields: string;
}

const SEARCH_FIELDS =
  "summary,description,status,priority,labels,components,assignee,duedate,fixVersions,issuetype,customfield_10020,attachment,comment";

// Count attachments + comments on a fetched issue. pm-jira imports neither, so
// the importer surfaces these counts to STDERR as a transparency note (it
// prevents a silent expectation of data that was dropped). Pure + testable.
export interface IssueExtras {
  attachments: number;
  comments: number;
  hasExtras: boolean;
}

export function countIssueExtras(issue: JiraIssue): IssueExtras {
  const attachments = Array.isArray(issue.fields.attachment)
    ? issue.fields.attachment.length
    : 0;
  const c = issue.fields.comment;
  const comments = typeof c?.total === "number"
    ? c.total
    : Array.isArray(c?.comments)
      ? c!.comments!.length
      : 0;
  return { attachments, comments, hasExtras: attachments > 0 || comments > 0 };
}

export function buildSearchRequest(
  baseUrl: string,
  jql: string,
  startAt: number,
  maxResults: number
): JiraSearchRequest {
  const url =
    `${baseUrl.replace(/\/$/, "")}/rest/api/3/search` +
    `?jql=${encodeURIComponent(jql)}` +
    `&fields=${encodeURIComponent(SEARCH_FIELDS)}` +
    `&startAt=${startAt}` +
    `&maxResults=${Math.min(maxResults, 100)}`;
  return { method: "GET", url, fields: SEARCH_FIELDS };
}

/**
 * Internal options for {@link runImport}. Extends the public dry-run/status
 * knobs with opt-in atomic-import controls and test seams. The atomic seams
 * (commitItemMutations / readSettings / normalizeItemId / issues) are NOT CLI
 * flags: they let tests inject a fake commit coordinator or a pre-fetched
 * issue set so the atomic path is exercised without the Jira network.
 */
export interface ImportRunOptions {
  dryRun?: boolean;
  statusFilter?: string;
  /** Import all creates atomically via commitItemMutations (pm-cli >=2026.7.20). */
  atomic?: boolean;
  /** Author attributed to the atomic transaction journal (defaults to `pm-jira`). */
  atomicAuthor?: string;
  /** Test seam: inject the commit coordinator (skips SDK resolution). */
  commitItemMutations?: CommitItemMutations;
  /** Test seam: inject readSettings (skips SDK resolution). */
  readSettings?: (pmRoot: string) => Promise<{ id_prefix?: string }>;
  /** Test seam: inject normalizeItemId (skips SDK resolution). */
  normalizeItemId?: (input: string, prefix: string) => string;
  /**
   * Test seam: a pre-fetched issue set. When set, the live Jira fetch (and
   * credential resolution) is skipped entirely so the atomic path can be
   * exercised offline against a real tracker.
   */
  issues?: JiraIssue[];
}

export async function runImport(
  options: Record<string, unknown>,
  pmRoot: string,
  opts: ImportRunOptions = {}
) {
  const project = readStringOptionAliased(options, "project", "project-key");
  const customJql = readStringOption(options, "jql");
  const maxResults = readNumberOption(options, "max-results") ?? 500;
  const statusMap = parseStatusMap(readStringOption(options, "status-map"));
  const fieldMap = parseFieldMap(readStringOptionAliased(options, "map", "field-map"));
  const dryRun = opts.dryRun ?? readBooleanOption(options, "dry-run");
  const atomic = opts.atomic ?? readBooleanOption(options, "atomic");
  const statusFilter = resolveStatusFilter(opts.statusFilter ?? readStringOption(options, "status"));

  if (!project && !customJql) {
    throw new CommandError(
      "Provide either --project <KEY> or --jql <query> to specify which issues to import.",
      EXIT_CODE.USAGE
    );
  }

  const jql = buildJql(readJqlFilters(options));
  const projectLabel = project ?? "custom-jql";

  // --dry-run makes NO network call: it prints the JQL + the exact GET request
  // the importer would issue, then returns. This is the offline-testable path,
  // so it must NOT require credentials — only a base URL to shape the endpoint
  // (from --host or JIRA_BASE_URL, else a placeholder). Mirrors the exporter's
  // offline --dry-run, and keeps the preflight gate's "skip dry-run" correct.
  if (dryRun) {
    const dryRunBaseUrl = (
      readStringOption(options, "host") ??
      (process.env["JIRA_BASE_URL"]?.trim() || "https://<JIRA_BASE_URL>")
    ).replace(/\/$/, "");
    const request = buildSearchRequest(dryRunBaseUrl, jql, 0, maxResults);
    console.error(`[dry-run] No network call will be made.`);
    console.error(`[dry-run] JQL: ${jql}`);
    console.error(`[dry-run] Would ${request.method} ${request.url}`);
    console.error(`[dry-run] Up to ${maxResults} issues would be imported as pm items.`);
    return {
      success: true,
      dryRun: true,
      jql,
      request,
      maxResults,
      project: projectLabel,
      atomic,
      ...(statusFilter.raw ? { statusFilter: statusFilter.raw, statusFilterMode: statusFilter.mode } : {}),
      ...(statusFilter.pmStatus ? { pmStatusFilter: statusFilter.pmStatus } : {}),
    };
  }

  // Live import: resolve creds now (throws a structured CommandError if any are
  // missing). The preflight gate normally aborts earlier with a clearer message,
  // but resolveCreds remains the authoritative guard for direct/importer entry.
  // When a pre-fetched issue set is injected (test seam), skip cred resolution
  // and the live fetch entirely so the atomic path is exercisable offline.
  let creds: JiraCreds | undefined;
  let issues: JiraIssue[];
  if (opts.issues) {
    issues = opts.issues;
    // A base URL is only needed to build the per-issue browse URL; use the
    // configured host/env or a placeholder so issueToItem stays pure offline.
    const seamBaseUrl = (
      readStringOption(options, "host") ??
      (process.env["JIRA_BASE_URL"]?.trim() || "https://example.atlassian.net")
    ).replace(/\/$/, "");
    creds = { baseUrl: seamBaseUrl, email: "", token: "", authHeader: "" };
  } else {
    creds = resolveCreds(options);
    console.error(`Fetching issues from Jira... (JQL: ${jql})${atomic ? " (atomic)" : ""}`);
    try {
      issues = await fetchAllJiraIssues(
        creds.baseUrl,
        creds.authHeader,
        jql,
        maxResults,
        // Per-page progress to STDERR for large paginated imports. Additive:
        // does not touch the stdout/json contract.
        (fetched, jiraTotal) =>
          console.error(formatImportProgress(fetched, jiraTotal, maxResults))
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let exitCode: number;
      if (/error 404/i.test(msg)) {
        exitCode = EXIT_CODE.NOT_FOUND;
      } else if (/HTTP 401|HTTP 403|authentication failed|authorization failed/i.test(msg)) {
        exitCode = EXIT_CODE.USAGE;
      } else {
        exitCode = EXIT_CODE.GENERIC_FAILURE;
      }
      throw new CommandError(`Failed to fetch issues from Jira: ${msg}`, exitCode);
    }
  }

  console.error(`Fetched ${issues.length} issues from Jira`);

  // Transparency: attachments + comments are NOT imported. Surface their
  // presence so a user never silently expects that data to have come across.
  let extraAttachments = 0;
  let extraComments = 0;
  let issuesWithExtras = 0;
  for (const issue of issues) {
    const extras = countIssueExtras(issue);
    if (extras.hasExtras) {
      issuesWithExtras++;
      extraAttachments += extras.attachments;
      extraComments += extras.comments;
    }
  }
  if (issuesWithExtras > 0) {
    console.error(
      `Note: ${issuesWithExtras} issue(s) carry ${extraAttachments} attachment(s) and ` +
        `${extraComments} comment(s) that are NOT imported (pm-jira imports title/body/status/labels only).`
    );
  }

  const baseUrl = creds.baseUrl; // creds is assigned in every branch above
  const mapped = issues.map((issue) => ({
    issue,
    item: issueToItem(issue, baseUrl, { statusMap, fieldMap }),
  }));

  if (statusFilter.mode === "pm" && statusFilter.raw && statusFilter.pmStatus) {
    if (normalizeStatusAliasKey(statusFilter.raw) !== statusFilter.pmStatus) {
      console.error(
        `Interpreting --status "${statusFilter.raw}" as pm status "${statusFilter.pmStatus}".`
      );
    }
  } else if (statusFilter.mode === "jira" && statusFilter.raw) {
    console.error(
      `Using Jira status "${statusFilter.raw}" as a server-side JQL filter (no pm-status post-filter).`
    );
  }

  const filtered = statusFilter.pmStatus
    ? mapped.filter(({ item }) => item.status === statusFilter.pmStatus)
    : mapped;

  if (statusFilter.pmStatus && filtered.length !== mapped.length) {
    console.error(`Filtered to ${filtered.length} issues with pm status "${statusFilter.pmStatus}"`);
  }

  let created = 0;
  let atomicTransactionId: string | undefined;
  if (atomic) {
    // --atomic: commit ALL creates in one all-or-nothing, crash-recoverable
    // transaction via the official commitItemMutations SDK helper. On
    // failure every applied create is compensated (deleted); an interrupted
    // run resumes on re-invocation. The dry-run path returns earlier above, so
    // no transaction is committed for a dry-run + --atomic invocation.
    const atomicResult = await importJiraAtomic(pmRoot, jql, filtered, opts);
    created = atomicResult.created;
    atomicTransactionId = atomicResult.transactionId;
    if (atomicResult.recovered) {
      console.error(
        `Atomic import resumed transaction ${atomicResult.transactionId} from a prior interrupted run (recovered ${created} item${created === 1 ? "" : "s"}).`
      );
    }
  } else {
    for (const { issue, item } of filtered) {
      if (createPmItem(pmRoot, item)) created++;
      else console.error(`Failed to create item for ${issue.key}`);
    }
  }

  console.error(`Imported ${created} issues from Jira ${projectLabel}`);
  return {
    success: true,
    synced: created,
    imported: created,
    total: filtered.length,
    project: projectLabel,
    ...(atomic ? { atomic: true } : {}),
    ...(atomicTransactionId ? { transactionId: atomicTransactionId } : {}),
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
  priority?: number;
  type?: string;
}

// Reverse type map: pm item type -> Jira issue type name, for export.
export function mapPmTypeToJira(pmType: string | undefined, override?: string): string {
  if (override) return override;
  const t = (pmType ?? "").toLowerCase();
  if (t === "bug") return "Bug";
  if (t === "feature" || t === "epic" || t === "story") return "Story";
  return "Task";
}

// Node's spawnSync defaults to a 1 MiB stdout cap, which a mature tracker's JSON
// dump passes at a few hundred items. Past that the child is killed with ENOBUFS,
// status null and EMPTY stderr, so the failure surfaces with nothing to diagnose
// (and at larger sizes stdout is genuinely truncated mid-document).
// 64 MiB matches the cap the sibling pm packages settled on.
/** Read-buffer cap for `pm` output, in bytes. 64 MiB by default; override with the
 * `PM_JSON_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
function pmJsonMaxBuffer(): number {
  // Number(), not parseInt(): parseInt("64MiB") silently yields 64, which would
  // impose a 64-BYTE cap and break every ordinary read while appearing to honor
  // the documented invalid-value fallback. Number() rejects the whole string.
  const raw = Number(process.env.PM_JSON_MAX_BUFFER);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
}

/** Name the real cause of a failed `pm` read. A stdout overrun kills the child
 * with `status: null` and EMPTY stderr, so without this the failure surfaces as
 * an unexplained error (or, worse, as an empty result set). */
function describePmReadFailure(error: Error, limitBytes: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOBUFS") {
    return `pm output exceeded the ${limitBytes} byte read buffer. `
      + "The workspace is larger than this integration's read limit; narrow the "
      + "operation or raise PM_JSON_MAX_BUFFER.";
  }
  return `pm read failed: ${error.message}`;
}

function readPmItems(pmRoot: string): PmItem[] {
  const maxBuffer = pmJsonMaxBuffer();
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list", "--full", "--include-body", "--limit", "10000"],
    { encoding: "utf-8", maxBuffer }
  );
  if (result.error) {
    throw new CommandError(describePmReadFailure(result.error, maxBuffer));
  }
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
    priority?: { name: string };
  };
}

export interface PayloadOptions {
  projectKey?: string;
  fieldMap?: FieldMap;
  // When true, derive issuetype + priority from the pm item (export depth).
  // Kept opt-in so the historical "always Task, no priority" shape is the
  // default and existing tests/consumers are unaffected.
  richMapping?: boolean;
}

// Convert a pm item to a Jira create payload. `projectKey` is optional so the
// transform stays pure/testable; the exporter requires it before POSTing.
// Accepts either a bare projectKey (back-compat) or a PayloadOptions object.
export function itemToJiraPayload(
  item: PmItem,
  projectKeyOrOptions?: string | PayloadOptions
): JiraCreatePayload {
  const opts: PayloadOptions =
    typeof projectKeyOrOptions === "string"
      ? { projectKey: projectKeyOrOptions }
      : projectKeyOrOptions ?? {};
  const { projectKey, fieldMap, richMapping } = opts;

  const summary = (item.title ?? "(untitled)").trim() || "(untitled)";
  const bodyText = item.body || item.description || "";
  const issuetypeName = richMapping
    ? mapPmTypeToJira(item.type, fieldMap?.["issuetype"] ?? fieldMap?.["type"])
    : "Task";
  const fields: JiraCreatePayload["fields"] = {
    ...(projectKey ? { project: { key: projectKey } } : {}),
    summary,
    description: plainTextToAdf(bodyText),
    issuetype: { name: issuetypeName },
    labels: (item.tags ?? []).map((t) => t.replace(/\s+/g, "-")),
  };
  if (richMapping && item.priority !== undefined) {
    fields.priority = { name: mapPmPriorityToJira(item.priority) };
  }
  return { fields };
}

// ---------------------------------------------------------------------------
// Export plan — pure description of the Jira mutations an export WOULD make.
// Each entry is "create" (no provenance marker) or "update" (item already
// carries a Jira key, so a re-create would duplicate; we surface that instead
// of blindly POSTing). Offline-testable; powers --dry-run and the real push.
// ---------------------------------------------------------------------------

export interface ExportPlanEntry {
  op: "create" | "update";
  itemId?: string;
  existingKey?: string;
  method: "POST" | "PUT";
  endpoint: string;
  payload: JiraCreatePayload;
}

export interface ExportPlan {
  baseUrl: string;
  project?: string;
  entries: ExportPlanEntry[];
}

export function buildExportPlan(
  items: PmItem[],
  baseUrl: string,
  opts: { projectKey?: string; fieldMap?: FieldMap; richMapping?: boolean } = {}
): ExportPlan {
  const cleanBase = baseUrl.replace(/\/$/, "");
  const entries: ExportPlanEntry[] = items.map((item) => {
    const provenance = extractJiraKey(item.description) ?? extractJiraKey(item.body);
    const payload = itemToJiraPayload(item, {
      projectKey: opts.projectKey,
      fieldMap: opts.fieldMap,
      richMapping: opts.richMapping,
    });
    if (provenance) {
      return {
        op: "update",
        itemId: item.id,
        existingKey: provenance.key,
        method: "PUT",
        endpoint: `${cleanBase}/rest/api/3/issue/${provenance.key}`,
        payload,
      };
    }
    return {
      op: "create",
      itemId: item.id,
      method: "POST",
      endpoint: `${cleanBase}/rest/api/3/issue`,
      payload,
    };
  });
  return { baseUrl: cleanBase, project: opts.projectKey, entries };
}

// ---------------------------------------------------------------------------
// Per-item-isolated push runner. Drives the create + update phases of
// `pm jira export --push`, mirroring the import path's (and the sibling
// pm-linear exporter's) per-item failure isolation: a single failed item
// (invalid issuetype, a required custom field, a 4xx, a transient network
// error, ...) is CAUGHT, counted into `failed`, logged to stderr, and the
// loop CONTINUES — instead of a mid-batch `throw` that abandons every
// remaining item with no record of what already succeeded. Successful items
// are durable (counted/logged) before any later item can fail.
//
// The HTTP layer is injected (defaults to httpsPost/httpsPut) so the loop is
// unit-testable offline without hitting the network.
// ---------------------------------------------------------------------------

export interface ExportPushDeps {
  post: (url: string, authHeader: string, payload: string) => Promise<string>;
  put: (url: string, authHeader: string, payload: string) => Promise<string>;
  /** Where per-item failures are logged. Injectable so tests don't have to
   * monkey-patch the global `console.error`. Defaults to `console.error`. */
  logError?: (message: string) => void;
}

export interface ExportPushFailure {
  /** pm item id when known, else the create endpoint / existing Jira key. */
  ref: string;
  op: "create" | "update";
  message: string;
}

export interface ExportPushResult {
  created: number;
  updated: number;
  /** Items already carrying a Jira key, not PUT because --update-existing was off. */
  skipped: number;
  /** Items whose create/update API call FAILED and were isolated. */
  failed: number;
  failures: ExportPushFailure[];
}

export async function runExportPush(
  plan: ExportPlan,
  opts: { authHeader: string; updateExisting: boolean },
  deps: ExportPushDeps = { post: httpsPost, put: httpsPut }
): Promise<ExportPushResult> {
  const toCreate = plan.entries.filter((e) => e.op === "create");
  const toUpdate = plan.entries.filter((e) => e.op === "update");
  const logError = deps.logError ?? ((message: string) => console.error(message));

  let created = 0;
  let updated = 0;
  let failed = 0;
  const failures: ExportPushFailure[] = [];

  for (const entry of toCreate) {
    const ref = entry.itemId ?? entry.endpoint;
    try {
      if (!entry.payload) throw new Error("export entry has no payload");
      await deps.post(entry.endpoint, opts.authHeader, JSON.stringify(entry.payload));
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to create Jira issue for ${ref}: ${message}`);
      failures.push({ ref, op: "create", message });
      failed++;
      continue;
    }
  }

  if (opts.updateExisting) {
    for (const entry of toUpdate) {
      const ref = entry.existingKey ?? entry.itemId ?? entry.endpoint;
      try {
        if (!entry.payload?.fields) throw new Error("export entry has no fields to update");
        // Jira's edit-issue API rejects the immutable `project` field on a
        // PUT, so strip it; only mutable fields are sent.
        const { project: _project, ...mutableFields } = entry.payload.fields;
        await deps.put(
          entry.endpoint,
          opts.authHeader,
          JSON.stringify({ fields: mutableFields })
        );
        updated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Failed to update Jira issue ${ref}: ${message}`);
        failures.push({ ref, op: "update", message });
        failed++;
        continue;
      }
    }
  }

  // `skipped` keeps its existing meaning: provenance-matched items that were
  // NOT PUT because --update-existing was off (back-compat). Failures are a
  // distinct, separately-counted category.
  const skipped = opts.updateExisting ? 0 : toUpdate.length;

  return { created, updated, skipped, failed, failures };
}

// ---------------------------------------------------------------------------
// Export-on-write hook decision — pure + offline-testable. Decides whether the
// opt-in onWrite mirror should act for a given write event. It only acts when
// PM_JIRA_PUSH_ON_WRITE is truthy AND the event is a project-scoped item
// create/update (never a history-stream write, never a delete). This keeps the
// hook a strict no-op by default and trivially unit-testable.
// ---------------------------------------------------------------------------

export interface PushOnWriteDecision {
  shouldPush: boolean;
  reason: string;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const s = value.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function decidePushOnWrite(
  hookCtx: { path?: string; scope?: string; op?: string } | undefined,
  envLike: NodeJS.ProcessEnv = process.env
): PushOnWriteDecision {
  if (!isTruthyEnv(envLike["PM_JIRA_PUSH_ON_WRITE"])) {
    return { shouldPush: false, reason: "disabled (PM_JIRA_PUSH_ON_WRITE not set)" };
  }
  const op = hookCtx?.op ?? "";
  if (op.endsWith(":history")) {
    return { shouldPush: false, reason: "history-stream write ignored" };
  }
  if (op === "delete") {
    return { shouldPush: false, reason: "deletes are not mirrored" };
  }
  if (hookCtx?.scope && hookCtx.scope !== "project") {
    return { shouldPush: false, reason: `non-project scope (${hookCtx.scope})` };
  }
  if (op !== "create" && op !== "update") {
    return { shouldPush: false, reason: `unhandled op (${op || "none"})` };
  }
  return { shouldPush: true, reason: `mirror ${op}` };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const PULL_FLAGS = [
  { long: "--project", value_name: "KEY", description: "Jira project key (e.g. PROJ). Alias: --project-key." },
  { long: "--project-key", value_name: "KEY", description: "Alias for --project (Jira project key filter)." },
  { long: "--jql", value_name: "query", description: "Custom JQL query (overrides --project default)" },
  { long: "--host", value_name: "url", description: "Jira base URL override (else JIRA_BASE_URL)" },
  { long: "--max-results", value_name: "n", description: "Max issues to fetch (default: 500)" },
  {
    long: "--status",
    value_name: "filter",
    description:
      "Filter by status: pm status (open|in_progress|closed|blocked, aliases: todo/wip/done) or raw Jira status",
  },
  { long: "--assignee", value_name: "user", description: "Filter by assignee (accountId, name, or currentUser())" },
  { long: "--issue-type", value_name: "type", description: "Filter by Jira issue type (e.g. Bug)" },
  { long: "--label", value_name: "label", description: "Filter by Jira label" },
  { long: "--updated-since", value_name: "date", description: 'Filter by updated date (e.g. "-7d" or "2026-01-01")' },
  { long: "--status-map", value_name: "map", description: 'Override status mapping, e.g. "QA=blocked,Done=closed"' },
  { long: "--map", value_name: "pairs", description: 'Override field mapping, e.g. "issuetype=Task,assignee=skip". Alias: --field-map.' },
  { long: "--field-map", value_name: "pairs", description: 'Alias for --map (override field mapping, e.g. "issuetype=Task,assignee=skip").' },
  { long: "--dry-run", description: "Preview the JQL + request without any network call" },
  { long: "--atomic", description: "Import all creates atomically under one workspace writer-locked, crash-recoverable transaction (pm-cli >=2026.7.20). On failure every applied create is compensated (deleted); interrupted runs resume" },
];

const EXPORT_FLAGS = [
  { long: "--project", value_name: "KEY", description: "Target Jira project key for created issues. Alias: --project-key." },
  { long: "--project-key", value_name: "KEY", description: "Alias for --project (target Jira project key)." },
  { long: "--host", value_name: "url", description: "Jira base URL override (else JIRA_BASE_URL)" },
  { long: "--map", value_name: "pairs", description: 'Override field mapping, e.g. "issuetype=Story". Alias: --field-map.' },
  { long: "--field-map", value_name: "pairs", description: 'Alias for --map (override field mapping).' },
  { long: "--rich", description: "Derive Jira issuetype + priority from pm item type/priority" },
  { long: "--update-existing", description: "PUT changed fields to issues that already carry a Jira key (else they are skipped)" },
  { long: "--dry-run", description: "Print the Jira mutations that would be made, without any network call" },
  { long: "--push", description: "POST the payloads to Jira (requires creds + --project)" },
];

const VALIDATE_FLAGS = [
  { long: "--host", value_name: "url", description: "Jira base URL override (else JIRA_BASE_URL)" },
];

export default defineExtension({
  name: "pm-jira",
  version: "2026.7.25",

  activate(api) {
    // -----------------------------------------------------------------------
    // schema — declare Jira provenance fields so the workspace knows them
    // -----------------------------------------------------------------------
    api.registerItemFields([
      { name: "jira_key", type: "string", optional: true },
      { name: "jira_url", type: "string", optional: true },
    ]);

    // -----------------------------------------------------------------------
    // preflight — fail-fast credential validation gate (registerPreflight).
    //
    // Fires ONLY for pm-jira's network-mutating command paths and ONLY when
    // they are actually about to hit Jira (see isMutatingJiraInvocation). It
    // validates that JIRA_BASE_URL (or --host), JIRA_EMAIL and JIRA_API_TOKEN
    // are present and ABORTS the command with a clear, actionable error BEFORE
    // any pm-store read or Jira REST call happens.
    //
    // IMPORTANT runtime fact: the pm-cli preflight-override runtime wraps this
    // callback in a try/catch that SWALLOWS any throw into a non-fatal warning
    // (extension_preflight_override_failed) and lets the command proceed. So a
    // bare `throw` here can NOT fail-fast. To genuinely abort BEFORE the command
    // body runs we print the actionable message and `process.exit()` directly —
    // process termination bypasses the runtime's catch. Verified functionally.
    // -----------------------------------------------------------------------
    api.registerPreflight((ctx: any) => {
      const command: string = ctx?.command ?? "";
      const options: Record<string, unknown> = ctx?.options ?? {};
      if (jiraPreflightShouldFailFast(command, options, process.env)) {
        const diag = diagnoseCreds(options, process.env);
        process.stderr.write(jiraPreflightErrorMessage(command, diag) + "\n");
        process.exit(EXIT_CODE.USAGE);
      }
      // Success / not-applicable: silent pass-through (no decision delta).
      return {};
    });

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
        "pm jira sync --project PROJ --assignee currentUser() --updated-since -7d",
        "pm jira sync --project PROJ --issue-type Bug --status-map 'QA=blocked,Done=closed'",
        "pm jira sync --project PROJ --map 'issuetype=Task,assignee=skip'",
        "pm jira sync --project PROJ --atomic # all-or-nothing import (pm-cli >=2026.7.20)",
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
      const project = readStringOptionAliased(options, "project", "project-key");
      const customJql = readStringOption(options, "jql");
      const maxResults = readNumberOption(options, "max-results") ?? 500;
      const statusMap = parseStatusMap(readStringOption(options, "status-map"));
      const fieldMap = parseFieldMap(readStringOptionAliased(options, "map", "field-map"));

      if (!project && !customJql) {
        throw new CommandError(
          "jira-sync importer requires either options.project or options.jql",
          EXIT_CODE.USAGE
        );
      }

      const jql = buildJql(readJqlFilters(options));

      console.error(`[jira-sync] Fetching issues with JQL: ${jql}`);
      const issues = await fetchAllJiraIssues(
        creds.baseUrl,
        creds.authHeader,
        jql,
        maxResults,
        (fetched, jiraTotal) =>
          console.error(`[jira-sync] ${formatImportProgress(fetched, jiraTotal, maxResults)}`)
      );
      console.error(`[jira-sync] Importing ${issues.length} issues`);

      const syncExtras = issues.reduce((n, i) => (countIssueExtras(i).hasExtras ? n + 1 : n), 0);
      if (syncExtras > 0) {
        console.error(
          `[jira-sync] Note: ${syncExtras} issue(s) carry attachments/comments that are NOT imported.`
        );
      }

      let created = 0;
      for (const issue of issues) {
        if (createPmItem(ctx.pm_root, issueToItem(issue, creds.baseUrl, { statusMap, fieldMap }))) created++;
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
      const dryRun = readBooleanOption(options, "dry-run");
      const rich = readBooleanOption(options, "rich");
      const updateExistingFlag = readBooleanOption(options, "update-existing");
      const project = readStringOptionAliased(options, "project", "project-key");
      const fieldMap = parseFieldMap(readStringOptionAliased(options, "map", "field-map"));
      const items = readPmItems(ctx.pm_root);

      // --dry-run: build and PRINT the exact Jira mutations that WOULD be made
      // from the current pm items, without resolving creds or hitting the
      // network. Uses --host if given else a placeholder base so the endpoint
      // shape is still inspectable offline.
      if (dryRun) {
        const baseUrl =
          readStringOption(options, "host") ??
          (process.env["JIRA_BASE_URL"]?.trim() || "https://<JIRA_BASE_URL>");
        const plan = buildExportPlan(items, baseUrl, {
          projectKey: project,
          fieldMap,
          richMapping: rich,
        });
        const creates = plan.entries.filter((e) => e.op === "create").length;
        const updates = plan.entries.filter((e) => e.op === "update").length;
        // Mirror what a real --push would do: updates are only applied with
        // --update-existing; otherwise they are skipped. Surface that here so
        // the preview matches the live behavior exactly.
        const updateVerb = updateExistingFlag ? "update" : "skip";
        console.error(`[dry-run] No network call will be made.`);
        console.error(
          `[dry-run] Would issue ${creates} create` +
            `${updateExistingFlag ? ` + ${updates} update` : ""} Jira mutation(s)` +
            `${updateExistingFlag ? "" : ` (and ${updates} skip — pass --update-existing to PUT them)`}.`
        );
        for (const entry of plan.entries.slice(0, 20)) {
          if (entry.op === "update") {
            console.error(
              `[dry-run]   ${updateVerb.toUpperCase()} ${entry.method} ${entry.endpoint} (existing ${entry.existingKey}) :: ${entry.payload.fields.summary}`
            );
          } else {
            console.error(
              `[dry-run]   CREATE ${entry.method} ${entry.endpoint} :: ${entry.payload.fields.summary}`
            );
          }
        }
        if (plan.entries.length > 20) {
          console.error(`[dry-run]   ... and ${plan.entries.length - 20} more`);
        }
        return { dryRun: true, pushed: false, updateExisting: updateExistingFlag, plan };
      }

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
        const updateExisting = readBooleanOption(options, "update-existing");
        const plan = buildExportPlan(items, creds.baseUrl, {
          projectKey: project,
          fieldMap,
          richMapping: rich,
        });

        // Per-item failure isolation: a single bad item (invalid issuetype, a
        // required custom field, a 4xx, ...) is caught + counted + logged and
        // the batch CONTINUES, instead of a mid-batch throw that abandons every
        // remaining item. Errors are streamed to stderr by runExportPush.
        const { created, updated, skipped, failed, failures } = await runExportPush(
          plan,
          { authHeader: creds.authHeader, updateExisting }
        );

        console.error(
          `Created ${created} issue(s) in Jira project ${project}.` +
            (updateExisting
              ? ` Updated ${updated} existing issue(s).`
              : skipped > 0
                ? ` Skipped ${skipped} item(s) that already have a Jira key (pass --update-existing to PUT them).`
                : "") +
            (failed > 0 ? ` Failed ${failed} item(s) (see errors above).` : "")
        );

        if (failed > 0 && created === 0 && updated === 0) {
          // Nothing landed at all — surface a non-zero exit so callers/CI notice,
          // but only after the whole batch was attempted and reported.
          throw new CommandError(
            `pm jira export --push failed: all ${failed} item(s) errored (see above).`
          );
        }

        return { pushed: true, created, updated, skipped, failed, failures, project };
      }

      const baseUrl =
        readStringOption(options, "host") ??
        (process.env["JIRA_BASE_URL"]?.trim() || "https://<JIRA_BASE_URL>");
      const plan = buildExportPlan(items, baseUrl, {
        projectKey: project,
        fieldMap,
        richMapping: rich,
      });
      const payloads = plan.entries.map((e) => e.payload);
      // Route the human preview to STDERR so stdout stays a single stream
      // (the SDK host renders our return object to stdout). Writing the
      // payloads to stdout here used to interleave JSON (this preview) with
      // trailing YAML (the host-rendered return), corrupting `pm jira
      // export --json`. The returned object now carries the full plan entries
      // (op/method/endpoint/payload) — the same array-of-entries shape as
      // `pm github export`'s `plan` field — so machine consumers get the
      // complete, actionable export plan as clean parseable JSON.
      console.error(JSON.stringify(payloads, null, 2));
      return { exported: payloads.length, pushed: false, dryRun: true, plan: plan.entries };
    });

    // -----------------------------------------------------------------------
    // Command: pm jira validate — credential / readiness diagnostics.
    // Never performs a network call and never leaks the token or email; it
    // reports presence booleans + a redacted host preview. --json returns the
    // structured object (the global --json flag controls rendering).
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "jira validate",
      description: "Check Jira credential / base-URL readiness (no secrets leaked, no network)",
      intent: "Diagnose whether pm-jira has the env/config it needs to talk to Jira",
      examples: ["pm jira validate", "pm jira validate --json", "pm jira validate --host https://co.atlassian.net"],
      flags: VALIDATE_FLAGS,
      async run(ctx) {
        const diag = diagnoseCreds(ctx.options || {});
        const json = Boolean(ctx.global?.json);
        if (!json) {
          // Human-readable summary on stderr; the returned object is what pm
          // renders to stdout. Never print the token/email values.
          console.error(diag.ready ? "Jira credentials: READY" : "Jira credentials: NOT READY");
          console.error(`  base URL present: ${diag.baseUrlPresent} (source: ${diag.baseUrlSource})`);
          if (diag.hostPreview) console.error(`  host: ${diag.hostPreview}`);
          console.error(`  email present:    ${diag.emailPresent}`);
          console.error(`  token present:    ${diag.tokenPresent}`);
          if (!diag.ready) console.error(`  missing: ${diag.missing.join(", ")}`);
        }
        // Return the object: in --json mode pm serializes it; otherwise pm
        // renders a compact view. Either way we do not corrupt stdout.
        return diag;
      },
    });

    // -----------------------------------------------------------------------
    // hooks — best-effort export-on-write mirror (OPT-IN).
    // Gated on PM_JIRA_PUSH_ON_WRITE being truthy AND full creds present. When
    // disabled or unconfigured it is a strict no-op. The pm hook runtime already
    // swallows any throw from a hook into a warning, so this can NEVER fail the
    // user's pm command; we additionally guard internally for clarity.
    // -----------------------------------------------------------------------
    api.hooks.onWrite(async (hookCtx: any) => {
      const decision = decidePushOnWrite(hookCtx, process.env);
      if (!decision.shouldPush) return;
      // Live mirror requires creds + network; in this build it is intentionally
      // a best-effort stub that no-ops without creds. When creds are present a
      // future revision can PUT the changed item upstream. We keep the network
      // call out of the default path so writes stay fast and offline-safe.
      try {
        const diag = diagnoseCreds({}, process.env);
        if (!diag.ready) return; // no creds → silent no-op
        // Intentionally minimal: real upstream PUT is left to an explicit
        // `pm jira export --push` so a stray write never spams Jira. The hook
        // exists to make the opt-in surface real + testable.
      } catch {
        // Swallow — a hook must never break the user's pm command.
      }
    });
  },
});
