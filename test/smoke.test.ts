import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  optionString,
  optionEnabled,
  optionInt,
  mapJiraStatus,
  mapJiraPriority,
  parseStatusMap,
  adfToPlainText,
  plainTextToAdf,
  issueToItem,
  itemToJiraPayload,
  jiraProvenance,
  extractJiraKey,
  resolveCreds,
  buildJql,
  readJqlFilters,
  jqlQuote,
  parseFieldMap,
  mapJiraStatusCategory,
  mapJiraIssueType,
  mapPmPriorityToJira,
  mapPmTypeToJira,
  buildSearchRequest,
  buildExportPlan,
  diagnoseCreds,
  decidePushOnWrite,
} from "../dist/index.js";

// Mirror the real ExtensionApi surface so activate() can register every
// capability the extension uses (commands, importers, exporters, schema
// fields, hooks). A partial mock throws TypeError when activate touches a
// missing method.
function fullApi(sink: (name: string, def?: any) => void) {
  const noop = (name: string) => () => sink(name);
  return {
    registerCommand: (def: any) => sink("command", def),
    registerParser: noop("parser"),
    registerPreflight: noop("preflight"),
    registerService: noop("service"),
    registerFlags: noop("flags"),
    registerItemFields: noop("itemFields"),
    registerItemTypes: noop("itemTypes"),
    registerMigration: noop("migration"),
    registerRenderer: noop("renderer"),
    registerImporter: (name: string, fn: any) => sink("importer", { name, fn }),
    registerExporter: (name: string, fn: any) => sink("exporter", { name, fn }),
    registerSearchProvider: noop("search"),
    registerVectorStoreAdapter: noop("vectorStore"),
    hooks: {
      beforeCommand: noop("hook:before"),
      afterCommand: noop("hook:after"),
      onWrite: noop("hook:onWrite"),
      onRead: noop("hook:onRead"),
      onIndex: noop("hook:onIndex"),
    },
  };
}

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers importer, exporter, schema fields, and the sync command", () => {
  const registered: string[] = [];
  const names: Record<string, string[]> = { importer: [], exporter: [] };
  const api = fullApi((name, def) => {
    registered.push(name);
    if ((name === "importer" || name === "exporter") && def?.name) names[name].push(def.name);
  });
  extension.activate(api as any);
  assert.ok(registered.includes("command"), "should register the sync command");
  assert.ok(registered.includes("importer"), "should register importers");
  assert.ok(registered.includes("exporter"), "should register the jira exporter");
  assert.ok(registered.includes("itemFields"), "should register jira schema fields");
  assert.ok(names.importer.includes("jira"), "should register the `jira` importer (pm jira import)");
  assert.ok(names.importer.includes("jira-sync"), "should keep the legacy jira-sync importer");
  assert.ok(names.exporter.includes("jira"), "should register the `jira` exporter (pm jira export)");
});

test("optionEnabled honors kebab and camelCase keys", () => {
  assert.strictEqual(optionEnabled({ dryRun: true }, "dry-run", "dryRun"), true);
  assert.strictEqual(optionEnabled({ "dry-run": true }, "dry-run", "dryRun"), true);
  assert.strictEqual(optionEnabled({ "dry-run": "true" }, "dry-run", "dryRun"), true);
  assert.strictEqual(optionEnabled({}, "dry-run", "dryRun"), false);
});

test("optionInt reads camelCase key and coerces string values", () => {
  assert.strictEqual(optionInt({ maxResults: "200" }, 500, "max-results", "maxResults"), 200);
  assert.strictEqual(optionInt({ "max-results": "200" }, 500, "max-results", "maxResults"), 200);
  assert.strictEqual(optionInt({}, 500, "max-results", "maxResults"), 500);
  assert.strictEqual(optionInt({ maxResults: "nope" }, 500, "max-results", "maxResults"), 500);
});

test("optionString trims and ignores empty values", () => {
  assert.strictEqual(optionString({ project: "  PROJ " }, "project"), "PROJ");
  assert.strictEqual(optionString({ project: "   " }, "project"), undefined);
  assert.strictEqual(optionString({}, "project"), undefined);
});

// --- pure transforms ------------------------------------------------------

test("mapJiraStatus maps common Jira states to pm statuses", () => {
  assert.strictEqual(mapJiraStatus("To Do"), "open");
  assert.strictEqual(mapJiraStatus("Backlog"), "open");
  assert.strictEqual(mapJiraStatus("In Progress"), "in_progress");
  assert.strictEqual(mapJiraStatus("Code Review"), "in_progress");
  assert.strictEqual(mapJiraStatus("Done"), "closed");
  assert.strictEqual(mapJiraStatus("Resolved"), "closed");
  assert.strictEqual(mapJiraStatus("Blocked"), "blocked");
});

test("mapJiraStatus honors a --status-map override", () => {
  const map = parseStatusMap("QA=blocked,Done=closed");
  assert.strictEqual(mapJiraStatus("QA", map), "blocked");
  assert.strictEqual(mapJiraStatus("Done", map), "closed");
  // Unmapped falls through to the built-in heuristics.
  assert.strictEqual(mapJiraStatus("In Progress", map), "in_progress");
});

test("parseStatusMap rejects invalid targets and malformed entries", () => {
  assert.strictEqual(parseStatusMap(undefined), undefined);
  assert.throws(() => parseStatusMap("QA=nonsense"), (e: unknown) => {
    assert.strictEqual((e as CommandError).exitCode, EXIT_CODE.USAGE);
    return true;
  });
  assert.throws(() => parseStatusMap("noEqualsSign"), /status-map/);
});

test("mapJiraPriority maps Jira priorities to pm priorities", () => {
  assert.strictEqual(mapJiraPriority("Highest"), 1);
  assert.strictEqual(mapJiraPriority("High"), 2);
  assert.strictEqual(mapJiraPriority("Medium"), 3);
  assert.strictEqual(mapJiraPriority("Low"), 4);
  assert.strictEqual(mapJiraPriority(undefined), 3);
});

test("adfToPlainText extracts text from nested ADF nodes", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
    ],
  };
  assert.strictEqual(adfToPlainText(adf as any), "Hello world");
  assert.strictEqual(adfToPlainText(null), "");
});

test("plainTextToAdf round-trips through adfToPlainText", () => {
  const adf = plainTextToAdf("round trip");
  assert.strictEqual(adfToPlainText(adf as any), "round trip");
  // Empty text must still produce a valid (non-empty) ADF doc.
  assert.strictEqual(plainTextToAdf("").content.length, 1);
});

test("jiraProvenance / extractJiraKey round-trip", () => {
  const line = jiraProvenance("PROJ-123", "https://x.atlassian.net/browse/PROJ-123");
  const got = extractJiraKey(`some body\n\n${line}\n`);
  assert.deepStrictEqual(got, { key: "PROJ-123", url: "https://x.atlassian.net/browse/PROJ-123" });
  assert.strictEqual(extractJiraKey("no marker here"), undefined);
});

test("issueToItem maps a Jira issue to pm-create fields with provenance", () => {
  const issue = {
    key: "PROJ-7",
    fields: {
      summary: "Fix the thing",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "details" }] }] },
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      priority: { name: "High" },
      labels: ["backend"],
      assignee: null,
      duedate: "2026-07-01",
      fixVersions: [{ name: "v2" }],
    },
  };
  const item = issueToItem(issue as any, "https://x.atlassian.net");
  assert.strictEqual(item.title, "[PROJ-7] Fix the thing");
  assert.strictEqual(item.status, "in_progress");
  assert.strictEqual(item.priority, 2);
  assert.strictEqual(item.body, "details");
  assert.deepStrictEqual(item.tags, ["backend", "v2"]);
  assert.strictEqual(item.deadline, "2026-07-01");
  assert.deepStrictEqual(extractJiraKey(item.description), {
    key: "PROJ-7",
    url: "https://x.atlassian.net/browse/PROJ-7",
  });
});

test("itemToJiraPayload renders a Jira create payload", () => {
  const payload = itemToJiraPayload(
    { title: "Ship it", body: "the body", tags: ["a b", "c"] },
    "PROJ"
  );
  assert.strictEqual(payload.fields.project?.key, "PROJ");
  assert.strictEqual(payload.fields.summary, "Ship it");
  assert.strictEqual(payload.fields.issuetype.name, "Task");
  assert.deepStrictEqual(payload.fields.labels, ["a-b", "c"]); // spaces -> dashes
  assert.strictEqual(adfToPlainText(payload.fields.description as any), "the body");
  // Without a project key the field is omitted (transform stays pure).
  assert.strictEqual(itemToJiraPayload({ title: "x" }).fields.project, undefined);
});

// --- credentials / graceful no-creds --------------------------------------

test("resolveCreds throws a USAGE CommandError when creds are missing", () => {
  assert.throws(
    () => resolveCreds({}, {} as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.match((err as Error).message, /JIRA_BASE_URL/);
      assert.match((err as Error).message, /JIRA_API_TOKEN/);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      return true;
    }
  );
});

test("resolveCreds accepts --host as the base-URL source", () => {
  const creds = resolveCreds(
    { host: "https://h.atlassian.net/" },
    { JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "tok" } as NodeJS.ProcessEnv
  );
  assert.strictEqual(creds.baseUrl, "https://h.atlassian.net"); // trailing slash stripped
  assert.ok(creds.authHeader.startsWith("Basic "));
});

// --- command / importer / exporter graceful no-creds ----------------------

function capture() {
  let cmd: { run: (ctx: any) => unknown } | undefined;
  const importers: Record<string, (ctx: any) => unknown> = {};
  const exporters: Record<string, (ctx: any) => unknown> = {};
  const api = fullApi((name, def) => {
    if (name === "command" && def?.name === "jira sync") cmd = def;
    if (name === "importer" && def?.name) importers[def.name] = def.fn;
    if (name === "exporter" && def?.name) exporters[def.name] = def.fn;
  });
  extension.activate(api as any);
  return { cmd: cmd!, importers, exporters };
}

function withoutCreds<T>(fn: () => Promise<T>): Promise<T> {
  const prev = {
    url: process.env.JIRA_BASE_URL, token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL,
  };
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_API_TOKEN;
  delete process.env.JIRA_EMAIL;
  return fn().finally(() => {
    if (prev.url) process.env.JIRA_BASE_URL = prev.url;
    if (prev.token) process.env.JIRA_API_TOKEN = prev.token;
    if (prev.email) process.env.JIRA_EMAIL = prev.email;
  });
}

test("jira sync throws a USAGE CommandError when credentials are missing", async () => {
  await withoutCreds(async () => {
    const { cmd } = capture();
    await assert.rejects(
      async () => cmd.run({ args: [], options: { project: "PROJ" }, pm_root: ".agents/pm" }),
      (err: unknown) => {
        assert.match((err as Error).message, /JIRA_BASE_URL/);
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
        return true;
      }
    );
  });
});

test("pm jira import (importer) throws a USAGE CommandError when credentials are missing", async () => {
  await withoutCreds(async () => {
    const { importers } = capture();
    await assert.rejects(
      async () => importers["jira"]!({ args: [], options: { project: "PROJ" }, pm_root: ".agents/pm" }),
      (err: unknown) => {
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
        return true;
      }
    );
  });
});

test("pm jira export --push throws a USAGE CommandError when credentials are missing", async () => {
  await withoutCreds(async () => {
    const { exporters } = capture();
    await assert.rejects(
      async () => exporters["jira"]!({ args: [], options: { push: true, project: "PROJ" }, pm_root: ".agents/pm" }),
      (err: unknown) => {
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
        return true;
      }
    );
  });
});

test("jira sync throws when neither --project nor --jql is given", async () => {
  const prev = {
    url: process.env.JIRA_BASE_URL, token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL,
  };
  try {
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_API_TOKEN = "x";
    process.env.JIRA_EMAIL = "a@b.c";
    const { cmd } = capture();
    await assert.rejects(
      async () => cmd.run({ args: [], options: {}, pm_root: ".agents/pm" }),
      /--project|--jql/
    );
  } finally {
    if (prev.url) process.env.JIRA_BASE_URL = prev.url; else delete process.env.JIRA_BASE_URL;
    if (prev.token) process.env.JIRA_API_TOKEN = prev.token; else delete process.env.JIRA_API_TOKEN;
    if (prev.email) process.env.JIRA_EMAIL = prev.email; else delete process.env.JIRA_EMAIL;
  }
});

// --- JQL builder ----------------------------------------------------------

test("buildJql returns an explicit --jql verbatim", () => {
  assert.strictEqual(
    buildJql({ jql: "project = X AND foo = bar" }),
    "project = X AND foo = bar"
  );
  // Explicit JQL wins even if other filters are present.
  assert.strictEqual(buildJql({ jql: "key = X-1", project: "Y" }), "key = X-1");
});

test("buildJql defaults to historical 'not done' when unconstrained", () => {
  assert.strictEqual(buildJql({}), "statusCategory != Done ORDER BY priority ASC");
});

test("buildJql composes project + filters and keeps not-done default", () => {
  assert.strictEqual(
    buildJql({ project: "PROJ" }),
    "project = PROJ AND statusCategory != Done ORDER BY priority ASC"
  );
  assert.strictEqual(
    buildJql({ project: "PROJ", assignee: "currentUser()", updatedSince: "-7d" }),
    'project = PROJ AND assignee = currentUser() AND updated >= "-7d" AND statusCategory != Done ORDER BY priority ASC'
  );
});

test("buildJql maps pm status to statusCategory and does not re-add not-done", () => {
  assert.strictEqual(
    buildJql({ project: "PROJ", status: "closed" }),
    'project = PROJ AND statusCategory = Done ORDER BY priority ASC'
  );
  // A raw Jira status name passes through as a status= clause.
  assert.strictEqual(
    buildJql({ status: "Code Review" }),
    'status = "Code Review" ORDER BY priority ASC'
  );
});

test("buildJql escapes / quotes values to prevent clause break-out", () => {
  assert.strictEqual(buildJql({ label: "back end" }).startsWith('labels = "back end"'), true);
  assert.strictEqual(jqlQuote('a"b'), '"a\\"b"');
  assert.strictEqual(jqlQuote("PROJ-1"), "PROJ-1");
});

test("readJqlFilters reads kebab + camel keys", () => {
  const f = readJqlFilters({ project: "P", "updated-since": "-1d", issueType: "Bug" });
  assert.strictEqual(f.project, "P");
  assert.strictEqual(f.updatedSince, "-1d");
  assert.strictEqual(f.issueType, "Bug");
});

// --- field mapping depth --------------------------------------------------

test("mapJiraStatusCategory buckets by category key", () => {
  assert.strictEqual(mapJiraStatusCategory("done"), "closed");
  assert.strictEqual(mapJiraStatusCategory("indeterminate"), "in_progress");
  assert.strictEqual(mapJiraStatusCategory("new"), "open");
  assert.strictEqual(mapJiraStatusCategory(undefined), "open");
});

test("mapJiraIssueType maps issue types to pm types", () => {
  assert.strictEqual(mapJiraIssueType("Bug"), "Bug");
  assert.strictEqual(mapJiraIssueType("Story"), "Feature");
  assert.strictEqual(mapJiraIssueType("Epic"), "Feature");
  assert.strictEqual(mapJiraIssueType("Task"), "Task");
  assert.strictEqual(mapJiraIssueType("Spike"), "Issue");
});

test("mapPmPriorityToJira / mapPmTypeToJira reverse-map for export", () => {
  assert.strictEqual(mapPmPriorityToJira(1), "Highest");
  assert.strictEqual(mapPmPriorityToJira(2), "High");
  assert.strictEqual(mapPmPriorityToJira(3), "Medium");
  assert.strictEqual(mapPmPriorityToJira(4), "Low");
  assert.strictEqual(mapPmTypeToJira("Bug"), "Bug");
  assert.strictEqual(mapPmTypeToJira("Feature"), "Story");
  assert.strictEqual(mapPmTypeToJira("Task"), "Task");
  assert.strictEqual(mapPmTypeToJira("Task", "Sub-task"), "Sub-task"); // override
});

test("parseFieldMap parses pairs and rejects unknown / malformed", () => {
  assert.deepStrictEqual(parseFieldMap("issuetype=Task,assignee=skip"), {
    issuetype: "Task",
    assignee: "skip",
  });
  assert.strictEqual(parseFieldMap(undefined), undefined);
  assert.throws(() => parseFieldMap("bogus=x"), (e: unknown) => {
    assert.strictEqual((e as CommandError).exitCode, EXIT_CODE.USAGE);
    return true;
  });
  assert.throws(() => parseFieldMap("noequals"), /--map/);
});

test("issueToItem uses statusCategory fallback + issue type + assignee tag", () => {
  const issue = {
    key: "PROJ-9",
    fields: {
      summary: "Custom workflow item",
      description: null,
      // Unrecognized status NAME but category says in-progress.
      status: { name: "Awaiting Triage", statusCategory: { key: "indeterminate" } },
      priority: { name: "Low" },
      labels: ["api"],
      assignee: { displayName: "Ada Lovelace", emailAddress: "a@b.c" },
      duedate: null,
      fixVersions: [],
      issuetype: { name: "Bug" },
    },
  };
  const item = issueToItem(issue as any, "https://x.atlassian.net");
  assert.strictEqual(item.status, "in_progress"); // via category fallback
  assert.strictEqual(item.type, "Bug");
  assert.strictEqual(item.priority, 4);
  assert.ok(item.tags.includes("api"));
  assert.ok(item.tags.includes("assignee:Ada-Lovelace"));
  assert.strictEqual(item.jiraKey, "PROJ-9");
});

test("issueToItem honors --map type/status pins and assignee=skip", () => {
  const issue = {
    key: "PROJ-10",
    fields: {
      summary: "pinned",
      description: null,
      status: { name: "Done", statusCategory: { key: "done" } },
      priority: null,
      labels: [],
      assignee: { displayName: "Someone", emailAddress: "s@x.y" },
      duedate: null,
      fixVersions: [],
      issuetype: { name: "Task" },
    },
  };
  const item = issueToItem(issue as any, "https://x.atlassian.net", {
    fieldMap: { type: "Chore", status: "open", assignee: "skip" },
  });
  assert.strictEqual(item.type, "Chore");
  assert.strictEqual(item.status, "open"); // pinned, overrides Done->closed
  assert.ok(!item.tags.some((t) => t.startsWith("assignee:")));
});

test("issueToItem still accepts a bare statusMap (back-compat 3rd arg)", () => {
  const issue = {
    key: "PROJ-11",
    fields: {
      summary: "x",
      description: null,
      status: { name: "QA", statusCategory: { key: "indeterminate" } },
      priority: null,
      labels: [],
      assignee: null,
      duedate: null,
      fixVersions: [],
      issuetype: { name: "Task" },
    },
  };
  const item = issueToItem(issue as any, "https://x.atlassian.net", parseStatusMap("QA=blocked"));
  assert.strictEqual(item.status, "blocked");
});

// --- search request (dry-run import) --------------------------------------

test("buildSearchRequest builds the exact GET url with encoded jql", () => {
  const req = buildSearchRequest("https://x.atlassian.net/", "project = P AND a = b", 0, 250);
  assert.strictEqual(req.method, "GET");
  assert.ok(req.url.startsWith("https://x.atlassian.net/rest/api/3/search?"));
  assert.ok(req.url.includes("jql=project%20%3D%20P%20AND%20a%20%3D%20b"));
  assert.ok(req.url.includes("maxResults=100")); // capped at 100 per page
  assert.ok(req.url.includes("issuetype")); // fields include issuetype
});

// --- export plan (dry-run export) -----------------------------------------

test("buildExportPlan emits create for new items, update for keyed items", () => {
  const plan = buildExportPlan(
    [
      { id: "a1", title: "New thing", tags: ["x"] },
      {
        id: "a2",
        title: "Existing",
        description: jiraProvenance("PROJ-5", "https://x.atlassian.net/browse/PROJ-5"),
      },
    ],
    "https://x.atlassian.net",
    { projectKey: "PROJ" }
  );
  assert.strictEqual(plan.entries.length, 2);
  assert.strictEqual(plan.entries[0]!.op, "create");
  assert.strictEqual(plan.entries[0]!.method, "POST");
  assert.ok(plan.entries[0]!.endpoint.endsWith("/rest/api/3/issue"));
  assert.strictEqual(plan.entries[1]!.op, "update");
  assert.strictEqual(plan.entries[1]!.existingKey, "PROJ-5");
  assert.ok(plan.entries[1]!.endpoint.endsWith("/rest/api/3/issue/PROJ-5"));
});

test("buildExportPlan richMapping derives issuetype + priority", () => {
  const plan = buildExportPlan(
    [{ id: "a", title: "Bugfix", type: "Bug", priority: 1, tags: [] }],
    "https://x.atlassian.net",
    { projectKey: "P", richMapping: true }
  );
  assert.strictEqual(plan.entries[0]!.payload.fields.issuetype.name, "Bug");
  assert.strictEqual(plan.entries[0]!.payload.fields.priority?.name, "Highest");
});

test("itemToJiraPayload default (no rich) stays Task with no priority", () => {
  const p = itemToJiraPayload({ title: "x", type: "Bug", priority: 1 });
  assert.strictEqual(p.fields.issuetype.name, "Task");
  assert.strictEqual(p.fields.priority, undefined);
});

// --- credential diagnostics (jira validate) -------------------------------

test("diagnoseCreds reports not-ready + missing without leaking secrets", () => {
  const d = diagnoseCreds({}, {} as NodeJS.ProcessEnv);
  assert.strictEqual(d.ready, false);
  assert.strictEqual(d.tokenPresent, false);
  assert.strictEqual(d.baseUrlSource, "none");
  assert.deepStrictEqual(
    d.missing.sort(),
    ["JIRA_API_TOKEN", "JIRA_BASE_URL (or --host)", "JIRA_EMAIL"].sort()
  );
  // The diagnostics object must never carry the raw token/email.
  assert.strictEqual(JSON.stringify(d).includes("secret-token"), false);
});

test("diagnoseCreds redacts to hostname preview and reports source", () => {
  const d = diagnoseCreds(
    {},
    { JIRA_BASE_URL: "https://co.atlassian.net/wiki", JIRA_EMAIL: "x@y.z", JIRA_API_TOKEN: "secret-token" } as NodeJS.ProcessEnv
  );
  assert.strictEqual(d.ready, true);
  assert.strictEqual(d.hostPreview, "co.atlassian.net"); // hostname only
  assert.strictEqual(d.baseUrlSource, "env");
  assert.strictEqual(JSON.stringify(d).includes("secret-token"), false);
});

test("diagnoseCreds prefers --host and marks source=option", () => {
  const d = diagnoseCreds(
    { host: "https://opt.atlassian.net" },
    { JIRA_EMAIL: "x@y.z", JIRA_API_TOKEN: "t" } as NodeJS.ProcessEnv
  );
  assert.strictEqual(d.baseUrlSource, "option");
  assert.strictEqual(d.hostPreview, "opt.atlassian.net");
});

// --- export-on-write hook decision ----------------------------------------

test("decidePushOnWrite is a no-op unless PM_JIRA_PUSH_ON_WRITE is truthy", () => {
  assert.strictEqual(
    decidePushOnWrite({ op: "create", scope: "project" }, {} as NodeJS.ProcessEnv).shouldPush,
    false
  );
  assert.strictEqual(
    decidePushOnWrite({ op: "create", scope: "project" }, { PM_JIRA_PUSH_ON_WRITE: "1" } as NodeJS.ProcessEnv).shouldPush,
    true
  );
});

test("decidePushOnWrite ignores history writes, deletes, and non-project scope", () => {
  const env = { PM_JIRA_PUSH_ON_WRITE: "true" } as NodeJS.ProcessEnv;
  assert.strictEqual(decidePushOnWrite({ op: "create:history", scope: "project" }, env).shouldPush, false);
  assert.strictEqual(decidePushOnWrite({ op: "delete", scope: "project" }, env).shouldPush, false);
  assert.strictEqual(decidePushOnWrite({ op: "create", scope: "global" }, env).shouldPush, false);
  assert.strictEqual(decidePushOnWrite({ op: "update", scope: "project" }, env).shouldPush, true);
});

// --- activation: validate command + onWrite hook registered ---------------

test("extension registers the jira validate command and an onWrite hook", () => {
  const registered: string[] = [];
  const commandNames: string[] = [];
  const api = {
    registerCommand: (def: any) => { registered.push("command"); commandNames.push(def.name); },
    registerImporter: () => registered.push("importer"),
    registerExporter: () => registered.push("exporter"),
    registerItemFields: () => registered.push("itemFields"),
    hooks: {
      beforeCommand: () => registered.push("hook:before"),
      afterCommand: () => registered.push("hook:after"),
      onWrite: () => registered.push("hook:onWrite"),
      onRead: () => registered.push("hook:onRead"),
      onIndex: () => registered.push("hook:onIndex"),
    },
  };
  extension.activate(api as any);
  assert.ok(commandNames.includes("jira validate"), "should register jira validate");
  assert.ok(registered.includes("hook:onWrite"), "should register an onWrite hook");
});
