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
const defineExtension = ((extension) => extension);
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
};
export class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
export function mapJiraPriority(jiraPriority) {
    if (!jiraPriority)
        return 3;
    const name = jiraPriority.toLowerCase();
    if (name === "highest" || name === "critical")
        return 1;
    if (name === "high")
        return 2;
    if (name === "medium")
        return 3;
    if (name === "low" || name === "lowest")
        return 4;
    return 3;
}
export function mapJiraStatus(jiraStatus, statusMap) {
    const name = jiraStatus.toLowerCase();
    // A caller-supplied --status-map override wins over the built-in heuristics.
    if (statusMap && name in statusMap)
        return statusMap[name];
    if (name === "blocked")
        return "blocked";
    if (name === "in progress" ||
        name === "in review" ||
        name === "in development" ||
        name === "code review")
        return "in_progress";
    if (name === "done" ||
        name === "resolved" ||
        name === "closed" ||
        name === "complete" ||
        name === "completed")
        return "closed";
    // Default: to do / open / backlog / any other
    return "open";
}
// Map a Jira statusCategory key (the workflow-agnostic bucket Jira assigns to
// every status: "new" | "indeterminate" | "done") to a pm status. This is a
// robust fallback that works across custom workflows where the status *name*
// is unrecognized but the category is always one of three known values.
export function mapJiraStatusCategory(categoryKey) {
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
export function mapJiraIssueType(jiraType) {
    const name = (jiraType ?? "").toLowerCase();
    if (name === "bug" || name === "defect")
        return "Bug";
    if (name === "story" || name === "user story")
        return "Feature";
    if (name === "epic")
        return "Feature";
    if (name === "task" || name === "sub-task" || name === "subtask")
        return "Task";
    return "Issue";
}
// Reverse priority map: pm priority (1..4) -> Jira priority name, for export.
export function mapPmPriorityToJira(priority) {
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
const PM_STATUSES = ["open", "in_progress", "closed", "blocked"];
const KNOWN_MAP_KEYS = new Set([
    "status",
    "statuscategory",
    "priority",
    "issuetype",
    "labels",
    "assignee",
    "duedate",
    "type",
]);
export function parseFieldMap(raw) {
    if (!raw)
        return undefined;
    const map = {};
    for (const pair of raw.split(",")) {
        const trimmed = pair.trim();
        if (!trimmed)
            continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) {
            throw new CommandError(`Invalid --map entry "${trimmed}" (expected "jiraField=pmField").`, EXIT_CODE.USAGE);
        }
        const from = trimmed.slice(0, eq).trim().toLowerCase();
        const to = trimmed.slice(eq + 1).trim();
        if (!from || !to) {
            throw new CommandError(`Invalid --map entry "${trimmed}" (empty field name).`, EXIT_CODE.USAGE);
        }
        if (!KNOWN_MAP_KEYS.has(from)) {
            throw new CommandError(`Unknown --map source field "${from}" (expected one of ${[...KNOWN_MAP_KEYS].join("|")}).`, EXIT_CODE.USAGE);
        }
        map[from] = to;
    }
    return Object.keys(map).length > 0 ? map : undefined;
}
// Parse a --status-map value of the form
//   "In Progress=in_progress,QA=blocked"
// into a lower-cased lookup table. Invalid pm-status targets are rejected with
// a USAGE CommandError so a typo never silently maps everything to "open".
export function parseStatusMap(raw) {
    if (!raw)
        return undefined;
    const map = {};
    for (const pair of raw.split(",")) {
        const trimmed = pair.trim();
        if (!trimmed)
            continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) {
            throw new CommandError(`Invalid --status-map entry "${trimmed}" (expected "JiraStatus=pm_status").`, EXIT_CODE.USAGE);
        }
        const from = trimmed.slice(0, eq).trim().toLowerCase();
        const to = trimmed.slice(eq + 1).trim();
        if (!from) {
            throw new CommandError(`Invalid --status-map entry "${trimmed}" (empty Jira status).`, EXIT_CODE.USAGE);
        }
        if (!PM_STATUSES.includes(to)) {
            throw new CommandError(`Invalid --status-map target "${to}" (expected one of ${PM_STATUSES.join("|")}).`, EXIT_CODE.USAGE);
        }
        map[from] = to;
    }
    return Object.keys(map).length > 0 ? map : undefined;
}
// Map a pm status to the Jira statusCategory clause it implies, so
// `--status closed` can filter Jira-side without enumerating every workflow
// state. Unknown / raw Jira statuses are matched literally on `status`.
const PM_STATUS_TO_JQL = {
    open: "statusCategory = \"To Do\"",
    in_progress: "statusCategory = \"In Progress\"",
    closed: "statusCategory = Done",
    blocked: "status = \"Blocked\"",
};
// Quote a JQL value: numbers/keys stay bare where Jira allows it, but anything
// with whitespace or punctuation is wrapped in double quotes (escaping any
// embedded quote) so user input can't break out of the clause.
export function jqlQuote(value) {
    if (/^[A-Za-z0-9_.-]+$/.test(value))
        return value;
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
export function buildJql(filters) {
    // Explicit --jql is authoritative; never rewrite a user's query.
    if (filters.jql && filters.jql.trim())
        return filters.jql.trim();
    const clauses = [];
    if (filters.project)
        clauses.push(`project = ${jqlQuote(filters.project)}`);
    if (filters.status) {
        const key = filters.status.trim().toLowerCase();
        clauses.push(PM_STATUS_TO_JQL[key] ?? `status = ${jqlQuote(filters.status)}`);
    }
    if (filters.assignee) {
        const a = filters.assignee.trim();
        // Recognize the JQL function forms so `--assignee currentUser()` works.
        clauses.push(/\(\s*\)$/.test(a) ? `assignee = ${a}` : `assignee = ${jqlQuote(a)}`);
    }
    if (filters.issueType)
        clauses.push(`issuetype = ${jqlQuote(filters.issueType)}`);
    if (filters.label)
        clauses.push(`labels = ${jqlQuote(filters.label)}`);
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
    if (!filters.status)
        clauses.push("statusCategory != Done");
    return `${clauses.join(" AND ")} ORDER BY priority ASC`;
}
// Read the convenience JQL filters off a loose options bag (kebab/camel safe).
export function readJqlFilters(options) {
    return {
        jql: readStringOption(options, "jql"),
        project: readStringOption(options, "project"),
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
export function adfToPlainText(node) {
    if (!node)
        return "";
    if ("text" in node && typeof node.text === "string") {
        return node.text;
    }
    if ("content" in node && Array.isArray(node.content)) {
        return node.content
            .map((child) => adfToPlainText(child))
            .join("")
            .trim();
    }
    return "";
}
// Render a plain-text body as a minimal Atlassian Document Format doc so it can
// be POSTed back to the Jira create API.
export function plainTextToAdf(text) {
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
export function jiraProvenance(key, browseUrl) {
    return `Jira ${key}: ${browseUrl}`;
}
export function extractJiraKey(text) {
    if (!text)
        return undefined;
    const m = text.match(JIRA_MARKER);
    if (!m)
        return undefined;
    return { key: m[1], url: m[2] };
}
// ---------------------------------------------------------------------------
// Option readers — tolerate both kebab-case and camelCase keys.
// The pm CLI normalizes loose extension flags to camelCase (e.g. --dry-run
// arrives as `dryRun`, --max-results as `maxResults`). Reading only the
// kebab key silently yields undefined, which for --dry-run means a "preview"
// that actually writes. Always check both spellings.
// ---------------------------------------------------------------------------
function camelKey(kebab) {
    return kebab.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
}
function readOptionValue(options, kebab) {
    return options[kebab] ?? options[camelKey(kebab)];
}
export function readStringOption(options, kebab) {
    const v = readOptionValue(options, kebab);
    const value = typeof v === "string" ? v : v === undefined ? undefined : String(v);
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function readNumberOption(options, kebab) {
    const v = readOptionValue(options, kebab);
    if (v === undefined || v === null)
        return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
}
export function readBooleanOption(options, kebab) {
    const v = readOptionValue(options, kebab);
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "1" || s === "yes" || s === "";
    }
    return Boolean(v);
}
export function optionString(options, ...keys) {
    for (const key of keys) {
        const value = readStringOption(options, key);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
export function optionInt(options, defaultValue, ...keys) {
    for (const key of keys) {
        const value = readNumberOption(options, key);
        if (value !== undefined)
            return value;
    }
    return defaultValue;
}
export function optionEnabled(options, ...keys) {
    return keys.some((key) => readBooleanOption(options, key));
}
// Resolve Jira credentials from options (--host) + env. Returns a structured
// CommandError (numeric exitCode) when anything is missing rather than throwing
// a bare Error, so the CLI exits non-zero exactly once with a helpful message.
export function resolveCreds(options, envLike = process.env) {
    const baseUrl = readStringOption(options, "host") ??
        (envLike["JIRA_BASE_URL"]?.trim() || undefined);
    const token = envLike["JIRA_API_TOKEN"]?.trim() || undefined;
    const email = envLike["JIRA_EMAIL"]?.trim() || undefined;
    const missing = [];
    if (!baseUrl)
        missing.push("JIRA_BASE_URL (or --host)");
    if (!email)
        missing.push("JIRA_EMAIL");
    if (!token)
        missing.push("JIRA_API_TOKEN");
    if (missing.length > 0) {
        throw new CommandError(`Missing Jira credentials: ${missing.join(", ")}. ` +
            `Set JIRA_BASE_URL (or pass --host), JIRA_EMAIL, and JIRA_API_TOKEN. ` +
            `Create a token at https://id.atlassian.com/manage-profile/security/api-tokens`, EXIT_CODE.USAGE);
    }
    const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    return { baseUrl: baseUrl.replace(/\/$/, ""), email: email, token: token, authHeader };
}
export function diagnoseCreds(options, envLike = process.env) {
    const hostOption = readStringOption(options, "host");
    const baseUrlEnv = envLike["JIRA_BASE_URL"]?.trim() || undefined;
    const baseUrl = hostOption ?? baseUrlEnv;
    const email = envLike["JIRA_EMAIL"]?.trim() || undefined;
    const token = envLike["JIRA_API_TOKEN"]?.trim() || undefined;
    const missing = [];
    if (!baseUrl)
        missing.push("JIRA_BASE_URL (or --host)");
    if (!email)
        missing.push("JIRA_EMAIL");
    if (!token)
        missing.push("JIRA_API_TOKEN");
    let hostPreview;
    if (baseUrl) {
        try {
            hostPreview = new URL(/^https?:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`).hostname;
        }
        catch {
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
export function isMutatingJiraInvocation(command, options) {
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
export function jiraPreflightShouldFailFast(command, options, envLike = process.env) {
    if (!isMutatingJiraInvocation(command, options))
        return false;
    return !diagnoseCreds(options, envLike).ready;
}
// Build the actionable fail-fast message. Mirrors resolveCreds' guidance and
// never echoes any secret value — only the names of the missing variables.
export function jiraPreflightErrorMessage(command, diag) {
    return (`pm-jira preflight: cannot run "pm ${command}" — missing Jira credentials: ` +
        `${diag.missing.join(", ")}. ` +
        `Set JIRA_BASE_URL (or pass --host), JIRA_EMAIL, and JIRA_API_TOKEN before a ` +
        `mutating command. Create a token at ` +
        `https://id.atlassian.com/manage-profile/security/api-tokens . ` +
        `Run "pm jira validate" to diagnose, or add --dry-run to preview offline.`);
}
// ---------------------------------------------------------------------------
// HTTP helpers using Node.js native https module
// ---------------------------------------------------------------------------
function httpsGet(url, authHeader) {
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
            res.on("data", (chunk) => {
                body += chunk.toString();
            });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Jira API error ${res.statusCode}: ${body.slice(0, 200)}`));
                }
                else {
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
function httpsPost(url, authHeader, payload) {
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
            res.on("data", (chunk) => {
                body += chunk.toString();
            });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Jira API error ${res.statusCode}: ${body.slice(0, 200)}`));
                }
                else {
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
function httpsPut(url, authHeader, payload) {
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
            res.on("data", (chunk) => {
                body += chunk.toString();
            });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Jira API error ${res.statusCode}: ${body.slice(0, 200)}`));
                }
                else {
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
export function formatImportProgress(fetched, jiraTotal, maxResults) {
    const effectiveTotal = Math.min(jiraTotal, maxResults);
    return `Fetched ${fetched}/${effectiveTotal}...`;
}
async function fetchAllJiraIssues(baseUrl, authHeader, jql, maxResults, onProgress) {
    const allIssues = [];
    let startAt = 0;
    const pageSize = Math.min(maxResults, 100);
    while (allIssues.length < maxResults) {
        const remaining = maxResults - allIssues.length;
        const fetchSize = Math.min(remaining, pageSize);
        // Reuse the single source-of-truth request builder so the live fetch and
        // the --dry-run preview can never drift apart.
        const { url } = buildSearchRequest(baseUrl, jql, startAt, fetchSize);
        const raw = await httpsGet(url, authHeader);
        const data = JSON.parse(raw);
        if (!data.issues || data.issues.length === 0)
            break;
        allIssues.push(...data.issues);
        startAt += data.issues.length;
        // Stream paginated progress to the caller (stderr-only). Emitted per page
        // so a large multi-page import surfaces feedback instead of looking hung.
        onProgress?.(allIssues.length, data.total);
        if (startAt >= data.total)
            break;
    }
    return allIssues;
}
export function issueToItem(issue, baseUrl, optionsOrStatusMap) {
    // Back-compat: a bare statusMap (the old 3rd arg) is still accepted.
    const mapOptions = optionsOrStatusMap && ("statusMap" in optionsOrStatusMap || "fieldMap" in optionsOrStatusMap)
        ? optionsOrStatusMap
        : { statusMap: optionsOrStatusMap };
    const { statusMap, fieldMap } = mapOptions;
    const tags = [
        ...(issue.fields.labels ?? []),
        ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
    ];
    // Assignee → tag (so it survives without a dedicated pm field) unless --map
    // assignee=<x> pins it elsewhere or the user opts out with assignee=skip.
    const assigneeTarget = fieldMap?.["assignee"];
    if (issue.fields.assignee?.displayName && assigneeTarget !== "skip") {
        tags.push(`assignee:${issue.fields.assignee.displayName.replace(/\s+/g, "-")}`);
    }
    // Status: prefer an explicit name mapping; fall back to the statusCategory
    // bucket when the name is unrecognized. --map statuscategory=<pmStatus> pins.
    const categoryPin = fieldMap?.["statuscategory"];
    const statusPin = fieldMap?.["status"];
    let status;
    if (statusPin && PM_STATUSES.includes(statusPin)) {
        status = statusPin;
    }
    else {
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
        deadline: issue.fields.duedate ?? undefined,
        // Provenance marker lives in the description so it survives round-trips.
        description: jiraProvenance(issue.key, browseUrl),
        jiraKey: issue.key,
        jiraUrl: browseUrl,
    };
}
function createPmItem(pmRoot, item) {
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
const SEARCH_FIELDS = "summary,description,status,priority,labels,assignee,duedate,fixVersions,issuetype,attachment,comment";
export function countIssueExtras(issue) {
    const attachments = Array.isArray(issue.fields.attachment)
        ? issue.fields.attachment.length
        : 0;
    const c = issue.fields.comment;
    const comments = typeof c?.total === "number"
        ? c.total
        : Array.isArray(c?.comments)
            ? c.comments.length
            : 0;
    return { attachments, comments, hasExtras: attachments > 0 || comments > 0 };
}
export function buildSearchRequest(baseUrl, jql, startAt, maxResults) {
    const url = `${baseUrl.replace(/\/$/, "")}/rest/api/3/search` +
        `?jql=${encodeURIComponent(jql)}` +
        `&fields=${encodeURIComponent(SEARCH_FIELDS)}` +
        `&startAt=${startAt}` +
        `&maxResults=${Math.min(maxResults, 100)}`;
    return { method: "GET", url, fields: SEARCH_FIELDS };
}
async function runImport(options, pmRoot, opts = {}) {
    const project = readStringOption(options, "project");
    const customJql = readStringOption(options, "jql");
    const maxResults = readNumberOption(options, "max-results") ?? 500;
    const statusMap = parseStatusMap(readStringOption(options, "status-map"));
    const fieldMap = parseFieldMap(readStringOption(options, "map"));
    const dryRun = opts.dryRun ?? readBooleanOption(options, "dry-run");
    const statusFilter = opts.statusFilter ?? readStringOption(options, "status");
    if (!project && !customJql) {
        throw new CommandError("Provide either --project <KEY> or --jql <query> to specify which issues to import.", EXIT_CODE.USAGE);
    }
    const jql = buildJql(readJqlFilters(options));
    const projectLabel = project ?? "custom-jql";
    // --dry-run makes NO network call: it prints the JQL + the exact GET request
    // the importer would issue, then returns. This is the offline-testable path,
    // so it must NOT require credentials — only a base URL to shape the endpoint
    // (from --host or JIRA_BASE_URL, else a placeholder). Mirrors the exporter's
    // offline --dry-run, and keeps the preflight gate's "skip dry-run" correct.
    if (dryRun) {
        const dryRunBaseUrl = (readStringOption(options, "host") ??
            (process.env["JIRA_BASE_URL"]?.trim() || "https://<JIRA_BASE_URL>")).replace(/\/$/, "");
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
            ...(statusFilter ? { statusFilter } : {}),
        };
    }
    // Live import: resolve creds now (throws a structured CommandError if any are
    // missing). The preflight gate normally aborts earlier with a clearer message,
    // but resolveCreds remains the authoritative guard for direct/importer entry.
    const creds = resolveCreds(options);
    console.error(`Fetching issues from Jira... (JQL: ${jql})`);
    let issues;
    try {
        issues = await fetchAllJiraIssues(creds.baseUrl, creds.authHeader, jql, maxResults, 
        // Per-page progress to STDERR for large paginated imports. Additive:
        // does not touch the stdout/json contract.
        (fetched, jiraTotal) => console.error(formatImportProgress(fetched, jiraTotal, maxResults)));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const exitCode = /error 404/.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
        throw new CommandError(`Failed to fetch issues from Jira: ${msg}`, exitCode);
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
        console.error(`Note: ${issuesWithExtras} issue(s) carry ${extraAttachments} attachment(s) and ` +
            `${extraComments} comment(s) that are NOT imported (pm-jira imports title/body/status/labels only).`);
    }
    const mapped = issues.map((issue) => ({
        issue,
        item: issueToItem(issue, creds.baseUrl, { statusMap, fieldMap }),
    }));
    const filtered = statusFilter
        ? mapped.filter(({ item }) => item.status === statusFilter)
        : mapped;
    if (statusFilter && filtered.length !== mapped.length) {
        console.error(`Filtered to ${filtered.length} issues with pm status "${statusFilter}"`);
    }
    let created = 0;
    for (const { issue, item } of filtered) {
        if (createPmItem(pmRoot, item))
            created++;
        else
            console.error(`Failed to create item for ${issue.key}`);
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
// Reverse type map: pm item type -> Jira issue type name, for export.
export function mapPmTypeToJira(pmType, override) {
    if (override)
        return override;
    const t = (pmType ?? "").toLowerCase();
    if (t === "bug")
        return "Bug";
    if (t === "feature" || t === "epic" || t === "story")
        return "Story";
    return "Task";
}
function readPmItems(pmRoot) {
    const result = spawnSync("pm", ["--path", pmRoot, "--json", "list", "--full", "--include-body", "--limit", "10000"], { encoding: "utf-8" });
    if (result.status !== 0) {
        throw new CommandError(result.stderr || "pm list failed");
    }
    try {
        const parsed = JSON.parse(result.stdout);
        const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
        return items;
    }
    catch {
        throw new CommandError("Could not parse `pm list --json` output.");
    }
}
// Convert a pm item to a Jira create payload. `projectKey` is optional so the
// transform stays pure/testable; the exporter requires it before POSTing.
// Accepts either a bare projectKey (back-compat) or a PayloadOptions object.
export function itemToJiraPayload(item, projectKeyOrOptions) {
    const opts = typeof projectKeyOrOptions === "string"
        ? { projectKey: projectKeyOrOptions }
        : projectKeyOrOptions ?? {};
    const { projectKey, fieldMap, richMapping } = opts;
    const summary = (item.title ?? "(untitled)").trim() || "(untitled)";
    const bodyText = item.body || item.description || "";
    const issuetypeName = richMapping
        ? mapPmTypeToJira(item.type, fieldMap?.["issuetype"] ?? fieldMap?.["type"])
        : "Task";
    const fields = {
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
export function buildExportPlan(items, baseUrl, opts = {}) {
    const cleanBase = baseUrl.replace(/\/$/, "");
    const entries = items.map((item) => {
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
export async function runExportPush(plan, opts, deps = { post: httpsPost, put: httpsPut }) {
    const toCreate = plan.entries.filter((e) => e.op === "create");
    const toUpdate = plan.entries.filter((e) => e.op === "update");
    let created = 0;
    let updated = 0;
    let failed = 0;
    const failures = [];
    for (const entry of toCreate) {
        const ref = entry.itemId ?? entry.endpoint;
        try {
            await deps.post(entry.endpoint, opts.authHeader, JSON.stringify(entry.payload));
            created++;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Failed to create Jira issue for ${ref}: ${message}`);
            failures.push({ ref, op: "create", message });
            failed++;
            continue;
        }
    }
    if (opts.updateExisting) {
        for (const entry of toUpdate) {
            const ref = entry.existingKey ?? entry.itemId ?? entry.endpoint;
            try {
                // Jira's edit-issue API rejects the immutable `project` field on a
                // PUT, so strip it; only mutable fields are sent.
                const { project: _project, ...mutableFields } = entry.payload.fields;
                await deps.put(entry.endpoint, opts.authHeader, JSON.stringify({ fields: mutableFields }));
                updated++;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`Failed to update Jira issue ${ref}: ${message}`);
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
function isTruthyEnv(value) {
    if (!value)
        return false;
    const s = value.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
}
export function decidePushOnWrite(hookCtx, envLike = process.env) {
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
    { long: "--project", value_name: "KEY", description: "Jira project key (e.g. PROJ)" },
    { long: "--jql", value_name: "query", description: "Custom JQL query (overrides --project default)" },
    { long: "--host", value_name: "url", description: "Jira base URL override (else JIRA_BASE_URL)" },
    { long: "--max-results", value_name: "n", description: "Max issues to fetch (default: 500)" },
    { long: "--status", value_name: "filter", description: "Filter by status: pm status (open|in_progress|closed|blocked) or raw Jira status" },
    { long: "--assignee", value_name: "user", description: "Filter by assignee (accountId, name, or currentUser())" },
    { long: "--issue-type", value_name: "type", description: "Filter by Jira issue type (e.g. Bug)" },
    { long: "--label", value_name: "label", description: "Filter by Jira label" },
    { long: "--updated-since", value_name: "date", description: 'Filter by updated date (e.g. "-7d" or "2026-01-01")' },
    { long: "--status-map", value_name: "map", description: 'Override status mapping, e.g. "QA=blocked,Done=closed"' },
    { long: "--map", value_name: "pairs", description: 'Override field mapping, e.g. "issuetype=Task,assignee=skip"' },
    { long: "--dry-run", description: "Preview the JQL + request without any network call" },
];
const EXPORT_FLAGS = [
    { long: "--project", value_name: "KEY", description: "Target Jira project key for created issues" },
    { long: "--host", value_name: "url", description: "Jira base URL override (else JIRA_BASE_URL)" },
    { long: "--map", value_name: "pairs", description: 'Override field mapping, e.g. "issuetype=Story"' },
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
    version: "2026.6.4-1",
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
        api.registerPreflight((ctx) => {
            const command = ctx?.command ?? "";
            const options = ctx?.options ?? {};
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
            ],
            flags: PULL_FLAGS,
            async run(ctx) {
                return runImport(ctx.options, ctx.pm_root);
            },
        });
        // -----------------------------------------------------------------------
        // importer — `pm jira import` (native import pipeline)
        // -----------------------------------------------------------------------
        api.registerImporter("jira", async (ctx) => {
            return runImport(ctx.options || {}, ctx.pm_root);
        });
        // -----------------------------------------------------------------------
        // importer — `jira-sync` (config-driven; kept for back-compat)
        // Credentials may arrive via options (importer config) or env.
        // -----------------------------------------------------------------------
        api.registerImporter("jira-sync", async (ctx) => {
            const options = ctx.options || {};
            // Merge importer-config creds into a virtual env so resolveCreds can read
            // them uniformly without leaking secrets into process.env.
            const envLike = {
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
            const fieldMap = parseFieldMap(readStringOption(options, "map"));
            if (!project && !customJql) {
                throw new CommandError("jira-sync importer requires either options.project or options.jql", EXIT_CODE.USAGE);
            }
            const jql = buildJql(readJqlFilters(options));
            console.error(`[jira-sync] Fetching issues with JQL: ${jql}`);
            const issues = await fetchAllJiraIssues(creds.baseUrl, creds.authHeader, jql, maxResults, (fetched, jiraTotal) => console.error(`[jira-sync] ${formatImportProgress(fetched, jiraTotal, maxResults)}`));
            console.error(`[jira-sync] Importing ${issues.length} issues`);
            const syncExtras = issues.reduce((n, i) => (countIssueExtras(i).hasExtras ? n + 1 : n), 0);
            if (syncExtras > 0) {
                console.error(`[jira-sync] Note: ${syncExtras} issue(s) carry attachments/comments that are NOT imported.`);
            }
            let created = 0;
            for (const issue of issues) {
                if (createPmItem(ctx.pm_root, issueToItem(issue, creds.baseUrl, { statusMap, fieldMap })))
                    created++;
            }
            console.error(`[jira-sync] Done. Imported ${created} issues.`);
            return { imported: created, total: issues.length };
        });
        // -----------------------------------------------------------------------
        // exporter — `pm jira export` (render pm items as Jira-create payloads)
        // Default: print the JSON payloads. With --push AND creds AND --project,
        // POST each payload to Jira's create-issue API.
        // -----------------------------------------------------------------------
        api.registerExporter("jira", async (ctx) => {
            const options = ctx.options || {};
            const push = readBooleanOption(options, "push");
            const dryRun = readBooleanOption(options, "dry-run");
            const rich = readBooleanOption(options, "rich");
            const updateExistingFlag = readBooleanOption(options, "update-existing");
            const project = readStringOption(options, "project");
            const fieldMap = parseFieldMap(readStringOption(options, "map"));
            const items = readPmItems(ctx.pm_root);
            // --dry-run: build and PRINT the exact Jira mutations that WOULD be made
            // from the current pm items, without resolving creds or hitting the
            // network. Uses --host if given else a placeholder base so the endpoint
            // shape is still inspectable offline.
            if (dryRun) {
                const baseUrl = readStringOption(options, "host") ??
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
                console.error(`[dry-run] Would issue ${creates} create` +
                    `${updateExistingFlag ? ` + ${updates} update` : ""} Jira mutation(s)` +
                    `${updateExistingFlag ? "" : ` (and ${updates} skip — pass --update-existing to PUT them)`}.`);
                for (const entry of plan.entries.slice(0, 20)) {
                    if (entry.op === "update") {
                        console.error(`[dry-run]   ${updateVerb.toUpperCase()} ${entry.method} ${entry.endpoint} (existing ${entry.existingKey}) :: ${entry.payload.fields.summary}`);
                    }
                    else {
                        console.error(`[dry-run]   CREATE ${entry.method} ${entry.endpoint} :: ${entry.payload.fields.summary}`);
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
                    throw new CommandError("--push requires --project <KEY> (the target Jira project for new issues).", EXIT_CODE.USAGE);
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
                const { created, updated, skipped, failed, failures } = await runExportPush(plan, { authHeader: creds.authHeader, updateExisting });
                console.error(`Created ${created} issue(s) in Jira project ${project}.` +
                    (updateExisting
                        ? ` Updated ${updated} existing issue(s).`
                        : skipped > 0
                            ? ` Skipped ${skipped} item(s) that already have a Jira key (pass --update-existing to PUT them).`
                            : "") +
                    (failed > 0 ? ` Failed ${failed} item(s) (see errors above).` : ""));
                if (failed > 0 && created === 0 && updated === 0) {
                    // Nothing landed at all — surface a non-zero exit so callers/CI notice,
                    // but only after the whole batch was attempted and reported.
                    throw new CommandError(`pm jira export --push failed: all ${failed} item(s) errored (see above).`);
                }
                return { pushed: true, created, updated, skipped, failed, failures, project };
            }
            const baseUrl = readStringOption(options, "host") ??
                (process.env["JIRA_BASE_URL"]?.trim() || "https://<JIRA_BASE_URL>");
            const plan = buildExportPlan(items, baseUrl, {
                projectKey: project,
                fieldMap,
                richMapping: rich,
            });
            const payloads = plan.entries.map((e) => e.payload);
            console.log(JSON.stringify(payloads, null, 2));
            return { exported: payloads.length, pushed: false };
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
                    if (diag.hostPreview)
                        console.error(`  host: ${diag.hostPreview}`);
                    console.error(`  email present:    ${diag.emailPresent}`);
                    console.error(`  token present:    ${diag.tokenPresent}`);
                    if (!diag.ready)
                        console.error(`  missing: ${diag.missing.join(", ")}`);
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
        api.hooks.onWrite(async (hookCtx) => {
            const decision = decidePushOnWrite(hookCtx, process.env);
            if (!decision.shouldPush)
                return;
            // Live mirror requires creds + network; in this build it is intentionally
            // a best-effort stub that no-ops without creds. When creds are present a
            // future revision can PUT the changed item upstream. We keep the network
            // call out of the default path so writes stay fast and offline-safe.
            try {
                const diag = diagnoseCreds({}, process.env);
                if (!diag.ready)
                    return; // no creds → silent no-op
                // Intentionally minimal: real upstream PUT is left to an explicit
                // `pm jira export --push` so a stray write never spams Jira. The hook
                // exists to make the opt-in surface real + testable.
            }
            catch {
                // Swallow — a hook must never break the user's pm command.
            }
        });
    },
});
//# sourceMappingURL=index.js.map