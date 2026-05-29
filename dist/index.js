import https from "node:https";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
const defineExtension = ((extension) => extension);
function mapJiraPriority(jiraPriority) {
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
function mapJiraStatus(jiraStatus) {
    const name = jiraStatus.toLowerCase();
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
// ---------------------------------------------------------------------------
// Jira description (Atlassian Document Format) → plain text
// ---------------------------------------------------------------------------
function adfToPlainText(node) {
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
function readStringOption(options, kebab) {
    const v = options[kebab] ?? options[camelKey(kebab)];
    return typeof v === "string" ? v : v === undefined ? undefined : String(v);
}
function readNumberOption(options, kebab) {
    const v = options[kebab] ?? options[camelKey(kebab)];
    if (v === undefined || v === null)
        return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
}
function readBooleanOption(options, kebab) {
    const v = options[kebab] ?? options[camelKey(kebab)];
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "1" || s === "yes" || s === "";
    }
    return Boolean(v);
}
// ---------------------------------------------------------------------------
// HTTP helper using Node.js native https module
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
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Fetch all pages from Jira search API
// ---------------------------------------------------------------------------
async function fetchAllJiraIssues(baseUrl, authHeader, jql, maxResults) {
    const fields = "summary,description,status,priority,labels,assignee,duedate,fixVersions";
    const allIssues = [];
    let startAt = 0;
    const pageSize = Math.min(maxResults, 100);
    while (allIssues.length < maxResults) {
        const remaining = maxResults - allIssues.length;
        const fetchSize = Math.min(remaining, pageSize);
        const url = `${baseUrl}/rest/api/3/search` +
            `?jql=${encodeURIComponent(jql)}` +
            `&fields=${encodeURIComponent(fields)}` +
            `&startAt=${startAt}` +
            `&maxResults=${fetchSize}`;
        const raw = await httpsGet(url, authHeader);
        const data = JSON.parse(raw);
        if (!data.issues || data.issues.length === 0)
            break;
        allIssues.push(...data.issues);
        startAt += data.issues.length;
        if (startAt >= data.total)
            break;
    }
    return allIssues;
}
// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-jira",
    version: "2026.5.29-1",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm jira sync
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
                const project = readStringOption(ctx.options, "project");
                const customJql = readStringOption(ctx.options, "jql");
                const maxResults = readNumberOption(ctx.options, "max-results") ?? 500;
                const dryRun = readBooleanOption(ctx.options, "dry-run");
                const statusFilter = readStringOption(ctx.options, "status");
                // Validate env vars
                const baseUrl = process.env["JIRA_BASE_URL"];
                const token = process.env["JIRA_API_TOKEN"];
                const email = process.env["JIRA_EMAIL"];
                if (!baseUrl || !token || !email) {
                    throw new Error("Missing required environment variables. Please set JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_EMAIL.");
                }
                if (!project && !customJql) {
                    throw new Error("Provide either --project <KEY> or --jql <query> to specify which issues to sync.");
                }
                const jql = customJql ??
                    `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;
                const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
                console.error(`Fetching issues from Jira... (JQL: ${jql})`);
                let issues;
                try {
                    issues = await fetchAllJiraIssues(baseUrl.replace(/\/$/, ""), authHeader, jql, maxResults);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    throw new Error(`Failed to fetch issues from Jira: ${msg}`);
                }
                console.error(`Fetched ${issues.length} issues from Jira`);
                // Apply status filter before upsert
                const filtered = statusFilter
                    ? issues.filter((issue) => mapJiraStatus(issue.fields.status.name) === statusFilter)
                    : issues;
                if (statusFilter && filtered.length !== issues.length) {
                    console.error(`Filtered to ${filtered.length} issues with pm status "${statusFilter}"`);
                }
                if (dryRun) {
                    console.error(`[dry-run] Would upsert ${filtered.length} items:`);
                    for (const issue of filtered.slice(0, 20)) {
                        console.error(`  ${issue.key}: ${issue.fields.summary} [${mapJiraStatus(issue.fields.status.name)}]`);
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
                    const tags = [
                        ...(issue.fields.labels ?? []),
                        ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
                    ];
                    const body = adfToPlainText(issue.fields.description);
                    const priority = mapJiraPriority(issue.fields.priority?.name);
                    const result = spawnSync("pm", [
                        "--path", ctx.pm_root,
                        "create",
                        "--title", `[${issue.key}] ${issue.fields.summary}`,
                        "--status", mapJiraStatus(issue.fields.status.name),
                        "--type", "Issue",
                        "--priority", String(priority),
                        ...(body ? ["--body", body] : []),
                        ...(issue.fields.duedate ? ["--deadline", issue.fields.duedate] : []),
                        ...(tags.length > 0 ? ["--tags", tags.join(",")] : []),
                    ], { encoding: "utf-8" });
                    if (result.status === 0) {
                        upserted++;
                    }
                    else {
                        console.error(`Failed to create item for ${issue.key}: ${result.stderr ?? ""}`);
                    }
                }
                const projectLabel = project ?? "custom-jql";
                console.error(`Synced ${upserted} issues from Jira project ${projectLabel}`);
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
            const baseUrl = ctx.options["JIRA_BASE_URL"] ??
                process.env["JIRA_BASE_URL"];
            const token = ctx.options["JIRA_API_TOKEN"] ??
                process.env["JIRA_API_TOKEN"];
            const email = ctx.options["JIRA_EMAIL"] ??
                process.env["JIRA_EMAIL"];
            const project = readStringOption(ctx.options, "project");
            const customJql = readStringOption(ctx.options, "jql");
            const maxResults = readNumberOption(ctx.options, "max-results") ?? 500;
            if (!baseUrl || !token || !email) {
                throw new Error("jira-sync importer requires JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_EMAIL (via options or env)");
            }
            if (!project && !customJql) {
                throw new Error("jira-sync importer requires either options.project or options.jql");
            }
            const jql = customJql ??
                `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;
            const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
            console.error(`[jira-sync] Fetching issues with JQL: ${jql}`);
            const issues = await fetchAllJiraIssues(baseUrl.replace(/\/$/, ""), authHeader, jql, maxResults);
            console.error(`[jira-sync] Importing ${issues.length} issues`);
            for (const issue of issues) {
                const tags = [
                    ...(issue.fields.labels ?? []),
                    ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
                ];
                const body = adfToPlainText(issue.fields.description);
                const priority = mapJiraPriority(issue.fields.priority?.name);
                spawnSync("pm", [
                    "--path", ctx.pm_root,
                    "create",
                    "--title", `[${issue.key}] ${issue.fields.summary}`,
                    "--status", mapJiraStatus(issue.fields.status.name),
                    "--type", "Issue",
                    "--priority", String(priority),
                    ...(body ? ["--body", body] : []),
                    ...(issue.fields.duedate ? ["--deadline", issue.fields.duedate] : []),
                    ...(tags.length > 0 ? ["--tags", tags.join(",")] : []),
                ], { encoding: "utf-8" });
            }
            console.error(`[jira-sync] Done. Imported ${issues.length} issues.`);
        });
    },
});
//# sourceMappingURL=index.js.map