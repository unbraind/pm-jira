import https from "node:https";
import { URL } from "node:url";
function defineExtension(m){return m}
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
        return "wip";
    if (name === "done" ||
        name === "resolved" ||
        name === "closed" ||
        name === "complete" ||
        name === "completed")
        return "done";
    // Default: to do / open / backlog / any other
    return "todo";
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
    name: "pm-ext-jira",
    version: "0.1.0",
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
                "pm jira sync --project PROJ --status todo --dry-run",
            ],
            flags: [
                {
                    long: "--project",
                    short: "-p",
                    value_name: "key",
                    description: "Jira project key (e.g. PROJ). Used to build the default JQL query.",
                },
                {
                    long: "--jql",
                    short: "-q",
                    value_name: "query",
                    description: "Custom JQL query. Overrides --project default JQL when provided.",
                },
                {
                    long: "--max-results",
                    short: "-n",
                    value_name: "n",
                    description: "Maximum number of issues to sync (default: 500)",
                },
                {
                    long: "--dry-run",
                    description: "Preview what would be synced without writing any items",
                },
                {
                    long: "--status",
                    short: "-s",
                    value_name: "filter",
                    description: "Filter issues by pm status after mapping (todo|wip|done|blocked)",
                },
            ],
            async run(ctx) {
                const project = ctx.args["project"];
                const customJql = ctx.args["jql"];
                const maxResults = ctx.args["max-results"] ?? 500;
                const dryRun = ctx.args["dry-run"] ?? false;
                const statusFilter = ctx.args["status"];
                // Validate env vars
                const baseUrl = process.env["JIRA_BASE_URL"];
                const token = process.env["JIRA_API_TOKEN"];
                const email = process.env["JIRA_EMAIL"];
                if (!baseUrl || !token || !email) {
                    ctx.log.error("Missing required environment variables. Please set JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_EMAIL.");
                    return { success: false, error: "Missing Jira credentials" };
                }
                if (!project && !customJql) {
                    ctx.log.error("Provide either --project <KEY> or --jql <query> to specify which issues to sync.");
                    return { success: false, error: "No project or JQL specified" };
                }
                const jql = customJql ??
                    `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;
                const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
                ctx.log.info(`Fetching issues from Jira... (JQL: ${jql})`);
                let issues;
                try {
                    issues = await fetchAllJiraIssues(baseUrl.replace(/\/$/, ""), authHeader, jql, maxResults);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    ctx.log.error(`Failed to fetch issues from Jira: ${msg}`);
                    return { success: false, error: msg };
                }
                ctx.log.info(`Fetched ${issues.length} issues from Jira`);
                // Apply status filter before upsert
                const filtered = statusFilter
                    ? issues.filter((issue) => mapJiraStatus(issue.fields.status.name) === statusFilter)
                    : issues;
                if (statusFilter && filtered.length !== issues.length) {
                    ctx.log.info(`Filtered to ${filtered.length} issues with pm status "${statusFilter}"`);
                }
                if (dryRun) {
                    ctx.log.info(`[dry-run] Would upsert ${filtered.length} items:`);
                    for (const issue of filtered.slice(0, 20)) {
                        ctx.log.info(`  ${issue.key}: ${issue.fields.summary} [${mapJiraStatus(issue.fields.status.name)}]`);
                    }
                    if (filtered.length > 20) {
                        ctx.log.info(`  ... and ${filtered.length - 20} more`);
                    }
                    return {
                        success: true,
                        dryRun: true,
                        total: filtered.length,
                        project: project ?? "custom-jql",
                    };
                }
                // Upsert items
                let upserted = 0;
                for (const issue of filtered) {
                    const projectKey = project ?? issue.key.split("-")[0];
                    const issueNumber = issue.key.split("-")[1] ?? issue.key;
                    const idSuffix = `${projectKey}-${issueNumber}`;
                    const tags = [
                        ...(issue.fields.labels ?? []),
                        ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
                    ];
                    const body = adfToPlainText(issue.fields.description);
                    await ctx.pm.upsertItem({
                        idSuffix,
                        title: `[${issue.key}] ${issue.fields.summary}`,
                        body: body || undefined,
                        status: mapJiraStatus(issue.fields.status.name),
                        priority: mapJiraPriority(issue.fields.priority?.name),
                        tags: tags.length > 0 ? tags : undefined,
                        meta: {
                            jira_key: issue.key,
                            jira_project: projectKey,
                            ...(issue.fields.assignee
                                ? { jira_assignee: issue.fields.assignee.displayName }
                                : {}),
                            ...(issue.fields.duedate
                                ? { jira_duedate: issue.fields.duedate }
                                : {}),
                        },
                    });
                    upserted++;
                }
                const projectLabel = project ?? "custom-jql";
                ctx.log.info(`Synced ${upserted} issues from Jira project ${projectLabel}`);
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
        api.registerImporter("jira-sync", async ({ config, pm, log }) => {
            const baseUrl = config["JIRA_BASE_URL"] ??
                process.env["JIRA_BASE_URL"];
            const token = config["JIRA_API_TOKEN"] ??
                process.env["JIRA_API_TOKEN"];
            const email = config["JIRA_EMAIL"] ??
                process.env["JIRA_EMAIL"];
            const project = config["project"];
            const customJql = config["jql"];
            const maxResults = config["maxResults"] ?? 500;
            if (!baseUrl || !token || !email) {
                throw new Error("jira-sync importer requires JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_EMAIL (via config or env)");
            }
            if (!project && !customJql) {
                throw new Error("jira-sync importer requires either config.project or config.jql");
            }
            const jql = customJql ??
                `project = ${project} AND statusCategory != Done ORDER BY priority ASC`;
            const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
            log.info(`[jira-sync] Fetching issues with JQL: ${jql}`);
            const issues = await fetchAllJiraIssues(baseUrl.replace(/\/$/, ""), authHeader, jql, maxResults);
            log.info(`[jira-sync] Importing ${issues.length} issues`);
            for (const issue of issues) {
                const projectKey = project ?? issue.key.split("-")[0];
                const issueNumber = issue.key.split("-")[1] ?? issue.key;
                const idSuffix = `${projectKey}-${issueNumber}`;
                const tags = [
                    ...(issue.fields.labels ?? []),
                    ...(issue.fields.fixVersions?.map((v) => v.name) ?? []),
                ];
                const body = adfToPlainText(issue.fields.description);
                await pm.upsertItem({
                    idSuffix,
                    title: `[${issue.key}] ${issue.fields.summary}`,
                    body: body || undefined,
                    status: mapJiraStatus(issue.fields.status.name),
                    priority: mapJiraPriority(issue.fields.priority?.name),
                    tags: tags.length > 0 ? tags : undefined,
                    meta: {
                        jira_key: issue.key,
                        jira_project: projectKey,
                        ...(issue.fields.assignee
                            ? { jira_assignee: issue.fields.assignee.displayName }
                            : {}),
                        ...(issue.fields.duedate
                            ? { jira_duedate: issue.fields.duedate }
                            : {}),
                    },
                });
            }
            log.info(`[jira-sync] Done. Imported ${issues.length} issues.`);
        });
    },
});
//# sourceMappingURL=index.js.map