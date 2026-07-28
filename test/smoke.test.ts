import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  CommandError,
  EXIT_CODE,
  optionString,
  optionEnabled,
  optionInt,
  mapJiraStatus,
  mapJiraPriority,
  parseStatusMap,
  normalizePmStatusInput,
  resolveStatusFilter,
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
  runExportPush,
  diagnoseCreds,
  isMutatingJiraInvocation,
  jiraPreflightShouldFailFast,
  jiraPreflightErrorMessage,
  decidePushOnWrite,
  formatImportProgress,
  countIssueExtras,
  readStringOptionAliased,
  classifyHttpError,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Activation proof: drive the extension through pm's REAL registration
// validation and activation engine via createExtensionTestHarness, so a host
// rejection (e.g. a host-owned flag collision that aborts command registration)
// fails this suite instead of staying green against a hand-rolled api double.
// The single harness is activated once (first test) and reused by every
// behavioural test below via runCommand / runImporter / runExporter.
// ---------------------------------------------------------------------------

let harness: ExtensionTestHarness | undefined;

async function getHarness(): Promise<ExtensionTestHarness> {
  if (!harness) {
    harness = await createExtensionTestHarness(extension, {
      name: "pm-jira",
      capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
    });
    assert.deepEqual(harness.activation.failed, [], "activation must not fail");
  }
  return harness;
}

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension activates cleanly and registers importer, exporter, schema fields, sync/validate commands, preflight, and the onWrite hook", async () => {
  const ext = await getHarness();
  // commands
  ext.assertCommandContract({ command: "jira sync" });
  ext.assertCommandContract({ command: "jira validate" });
  // schema item fields
  ext.assertItemField({ field: "jira_key", type: "string" });
  ext.assertItemField({ field: "jira_url", type: "string" });
  // importers (native + legacy) + exporter
  ext.assertImporter({ importer: "jira" });
  ext.assertImporter({ importer: "jira-sync" });
  ext.assertExporter({ exporter: "jira" });
  // preflight gate + onWrite hook
  ext.assertPreflightOverride();
  ext.assertHook({ kind: "on_write" });
});

test("preflight gate: fires only for network-mutating jira invocations", () => {
  // Mutating: sync/import without --dry-run, export with --push.
  assert.strictEqual(isMutatingJiraInvocation("jira sync", {}), true);
  assert.strictEqual(isMutatingJiraInvocation("jira import", { project: "P" }), true);
  assert.strictEqual(isMutatingJiraInvocation("jira export", { push: true }), true);
  // Non-mutating: --dry-run (camelCase as normalized by pm), validate, export without push.
  assert.strictEqual(isMutatingJiraInvocation("jira sync", { dryRun: true }), false);
  assert.strictEqual(isMutatingJiraInvocation("jira import", { "dry-run": true }), false);
  assert.strictEqual(isMutatingJiraInvocation("jira export", {}), false);
  assert.strictEqual(isMutatingJiraInvocation("jira export", { push: true, dryRun: true }), false);
  assert.strictEqual(isMutatingJiraInvocation("jira validate", {}), false);
  // Unrelated commands never fire.
  assert.strictEqual(isMutatingJiraInvocation("list", {}), false);
  assert.strictEqual(isMutatingJiraInvocation("create", {}), false);
});

test("preflight gate: fails fast only when mutating AND creds missing", () => {
  const noCreds: NodeJS.ProcessEnv = {};
  const fullCreds: NodeJS.ProcessEnv = {
    JIRA_BASE_URL: "https://co.atlassian.net",
    JIRA_EMAIL: "a@b.com",
    JIRA_API_TOKEN: "tok",
  };
  // Mutating + missing creds → fail fast.
  assert.strictEqual(jiraPreflightShouldFailFast("jira sync", {}, noCreds), true);
  assert.strictEqual(jiraPreflightShouldFailFast("jira import", { project: "P" }, noCreds), true);
  assert.strictEqual(jiraPreflightShouldFailFast("jira export", { push: true }, noCreds), true);
  // Mutating + creds present → pass.
  assert.strictEqual(jiraPreflightShouldFailFast("jira sync", {}, fullCreds), false);
  // --host satisfies the base-URL requirement without JIRA_BASE_URL.
  assert.strictEqual(
    jiraPreflightShouldFailFast(
      "jira sync",
      { host: "https://co.atlassian.net" },
      { JIRA_EMAIL: "a@b.com", JIRA_API_TOKEN: "tok" }
    ),
    false
  );
  // Non-mutating never fails even with no creds.
  assert.strictEqual(jiraPreflightShouldFailFast("jira sync", { dryRun: true }, noCreds), false);
  assert.strictEqual(jiraPreflightShouldFailFast("jira validate", {}, noCreds), false);
  assert.strictEqual(jiraPreflightShouldFailFast("jira export", {}, noCreds), false);
});

test("preflight error message is actionable and leaks no secrets", () => {
  const diag = diagnoseCreds({}, {});
  const msg = jiraPreflightErrorMessage("jira sync", diag);
  assert.match(msg, /pm-jira preflight/);
  assert.match(msg, /pm jira sync/);
  assert.match(msg, /JIRA_BASE_URL/);
  assert.match(msg, /JIRA_EMAIL/);
  assert.match(msg, /JIRA_API_TOKEN/);
  assert.match(msg, /jira validate/);
  assert.match(msg, /--dry-run/);
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

test("normalizePmStatusInput accepts common pm status aliases", () => {
  assert.strictEqual(normalizePmStatusInput("todo"), "open");
  assert.strictEqual(normalizePmStatusInput("to-do"), "open");
  assert.strictEqual(normalizePmStatusInput("wip"), "in_progress");
  assert.strictEqual(normalizePmStatusInput("in-progress"), "in_progress");
  assert.strictEqual(normalizePmStatusInput("done"), "closed");
  assert.strictEqual(normalizePmStatusInput("on hold"), "blocked");
  assert.strictEqual(normalizePmStatusInput("Code Review"), undefined);
});

test("resolveStatusFilter separates pm aliases from raw Jira status names", () => {
  assert.deepStrictEqual(resolveStatusFilter(undefined), { mode: "none" });
  assert.deepStrictEqual(resolveStatusFilter("wip"), {
    mode: "pm",
    raw: "wip",
    pmStatus: "in_progress",
  });
  assert.deepStrictEqual(resolveStatusFilter("Code Review"), {
    mode: "jira",
    raw: "Code Review",
  });
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
  assert.deepStrictEqual(parseStatusMap("QA=done,In Review=wip"), {
    qa: "closed",
    "in review": "in_progress",
  });
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
      components: [{ name: "api" }],
      assignee: null,
      duedate: "2026-07-01",
      fixVersions: [{ name: "v2" }],
      customfield_10020: [{ name: "Sprint 12" }],
    },
  };
  const item = issueToItem(issue as any, "https://x.atlassian.net");
  assert.strictEqual(item.title, "[PROJ-7] Fix the thing");
  assert.strictEqual(item.status, "in_progress");
  assert.strictEqual(item.priority, 2);
  assert.strictEqual(item.body, "details");
  assert.deepStrictEqual(item.tags, ["backend", "v2", "component:api", "sprint:Sprint 12"]);
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
// Behavioural tests below exercise the registered sync command, jira importer,
// and jira exporter through pm's REAL dispatch engine (runCommand / runImporter /
// runExporter on the shared harness) rather than a hand-rolled api double.

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
    const ext = await getHarness();
    await assert.rejects(
      async () => ext.runCommand({ command: "jira sync", options: { project: "PROJ" }, pmRoot: ".agents/pm" }),
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
    const ext = await getHarness();
    await assert.rejects(
      async () => ext.runImporter({ importer: "jira", options: { project: "PROJ" }, pmRoot: ".agents/pm" }),
      (err: unknown) => {
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
        return true;
      }
    );
  });
});

test("pm jira export --push throws a USAGE CommandError when credentials are missing", async () => {
  await withoutCreds(async () => {
    const ext = await getHarness();
    await assert.rejects(
      async () => ext.runExporter({ exporter: "jira", options: { push: true, project: "PROJ" }, pmRoot: ".agents/pm" }),
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
    const ext = await getHarness();
    await assert.rejects(
      async () => ext.runCommand({ command: "jira sync", options: {}, pmRoot: ".agents/pm" }),
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
  assert.strictEqual(
    buildJql({ project: "PROJ", status: "wip" }),
    'project = PROJ AND statusCategory = "In Progress" ORDER BY priority ASC'
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
  assert.deepStrictEqual(parseFieldMap("issuetype=Task,assignee=skip,components=ignore,sprint=ignore"), {
    issuetype: "Task",
    assignee: "skip",
    components: "ignore",
    sprint: "ignore",
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

test("issueToItem can suppress noisy Jira context tags with --map ignore", () => {
  const issue = {
    key: "PROJ-12",
    fields: {
      summary: "customized context",
      description: null,
      status: { name: "To Do", statusCategory: { key: "new" } },
      priority: null,
      labels: ["backend"],
      components: [{ name: "api" }],
      assignee: { displayName: "Someone", emailAddress: "s@x.y" },
      duedate: "2026-07-01",
      fixVersions: [{ name: "v2" }],
      customfield_10020: [{ name: "Sprint 12" }],
      issuetype: { name: "Task" },
    },
  };
  const item = issueToItem(issue as any, "https://x.atlassian.net", {
    fieldMap: parseFieldMap("labels=ignore,fixversions=ignore,components=ignore,sprint=ignore,assignee=ignore,duedate=ignore"),
  });
  assert.deepStrictEqual(item.tags, []);
  assert.strictEqual(item.deadline, undefined);
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

// --- update-existing export plan / payloads -------------------------------

test("buildExportPlan update entries carry a PUT to the issue endpoint and a payload", () => {
  // The --update-existing push path filters on op==='update' and PUTs each
  // entry; assert the plan supplies exactly what that path needs.
  const plan = buildExportPlan(
    [
      { id: "new1", title: "Brand new", tags: [] },
      {
        id: "old1",
        title: "Has a key",
        description: jiraProvenance("PROJ-42", "https://x.atlassian.net/browse/PROJ-42"),
        body: "updated body",
      },
    ],
    "https://x.atlassian.net",
    { projectKey: "PROJ" }
  );
  const updates = plan.entries.filter((e) => e.op === "update");
  const creates = plan.entries.filter((e) => e.op === "create");
  assert.strictEqual(updates.length, 1, "provenance-matched item -> update");
  assert.strictEqual(creates.length, 1, "unkeyed item -> create");
  const upd = updates[0]!;
  assert.strictEqual(upd.method, "PUT");
  assert.strictEqual(upd.existingKey, "PROJ-42");
  assert.ok(upd.endpoint.endsWith("/rest/api/3/issue/PROJ-42"));
  // The payload the PUT will send (project stripped at PUT time, but summary
  // is what the user sees in the dry-run plan).
  assert.strictEqual(upd.payload.fields.summary, "Has a key");
  assert.strictEqual(adfToPlainText(upd.payload.fields.description as any), "updated body");
});

// --- import progress feedback ---------------------------------------------

test("formatImportProgress clamps the denominator to maxResults", () => {
  assert.strictEqual(formatImportProgress(100, 512, 500), "Fetched 100/500...");
  assert.strictEqual(formatImportProgress(50, 50, 500), "Fetched 50/50...");
  // When Jira reports fewer than the cap, the real total wins.
  assert.strictEqual(formatImportProgress(30, 30, 1000), "Fetched 30/30...");
});

// --- attachment / comment transparency ------------------------------------

test("countIssueExtras counts attachments and comments (total or array length)", () => {
  const withBoth = {
    key: "X-1",
    fields: {
      summary: "s",
      status: { name: "To Do", statusCategory: { key: "new" } },
      attachment: [{}, {}],
      comment: { total: 3 },
    },
  } as any;
  const r = countIssueExtras(withBoth);
  assert.strictEqual(r.attachments, 2);
  assert.strictEqual(r.comments, 3);
  assert.strictEqual(r.hasExtras, true);

  // comment.total absent -> fall back to comments array length.
  const arrComments = countIssueExtras({
    key: "X-2",
    fields: { summary: "s", status: { name: "To Do", statusCategory: { key: "new" } }, comment: { comments: [{}] } },
  } as any);
  assert.strictEqual(arrComments.comments, 1);

  // None present -> hasExtras false, zero counts.
  const none = countIssueExtras({
    key: "X-3",
    fields: { summary: "s", status: { name: "To Do", statusCategory: { key: "new" } } },
  } as any);
  assert.deepStrictEqual(none, { attachments: 0, comments: 0, hasExtras: false });
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

// ---------------------------------------------------------------------------
// runExportPush — per-item failure isolation (regression: a single failed
// create/update used to throw mid-batch and abandon every remaining item).
// ---------------------------------------------------------------------------

// A capturing logger injected via `deps.logError` — no global `console.error`
// monkey-patching (which would leak across tests if a body threw).
function makeLogCapture(): { logError: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { logError: (m: string) => lines.push(m), lines };
}

// Three create-only pm items -> a 3-create export plan (no provenance).
function threeCreatePlan() {
  const items = [
    { id: "item-1", title: "First", type: "task" },
    { id: "item-2", title: "Second", type: "bug" },
    { id: "item-3", title: "Third", type: "feature" },
  ];
  return buildExportPlan(items as any, "https://example.atlassian.net", { projectKey: "PROJ" });
}

test("runExportPush: a failing create item is isolated and the batch continues", async () => {
  const plan = threeCreatePlan();
  const attempted: string[] = [];
  const cap = makeLogCapture();
  const deps = {
    // Fail on the 2nd create; the 1st and 3rd must still be attempted.
    post: async (url: string) => {
      attempted.push(url);
      if (attempted.length === 2) throw new Error("Jira API error 400: invalid issuetype");
      return "{}";
    },
    put: async () => "{}",
    logError: cap.logError,
  };

  const result = await runExportPush(plan, { authHeader: "Basic x", updateExisting: false }, deps);
  const lines = cap.lines;

  assert.strictEqual(attempted.length, 3, "all three creates should be attempted (no abort)");
  assert.strictEqual(result.created, 2, "two creates should have succeeded");
  assert.strictEqual(result.failed, 1, "one create should be counted as failed");
  assert.strictEqual(result.failures.length, 1, "one failure record should be captured");
  assert.strictEqual(result.failures[0]!.op, "create");
  assert.match(result.failures[0]!.message, /invalid issuetype/);
  assert.ok(
    lines.some((l) => /Failed to create Jira issue/.test(l)),
    "the failure should be logged to stderr"
  );
});

test("runExportPush: a failing update item is isolated and the batch continues", async () => {
  // Two items that already carry Jira provenance -> two updates.
  const items = [
    { id: "item-a", title: "A", description: jiraProvenance("PROJ-1", "https://example.atlassian.net/browse/PROJ-1") },
    { id: "item-b", title: "B", description: jiraProvenance("PROJ-2", "https://example.atlassian.net/browse/PROJ-2") },
  ];
  const plan = buildExportPlan(items as any, "https://example.atlassian.net", { projectKey: "PROJ" });
  const attempted: string[] = [];
  const deps = {
    post: async () => "{}",
    put: async (url: string) => {
      attempted.push(url);
      if (attempted.length === 1) throw new Error("Jira API error 403: forbidden");
      return "";
    },
    logError: makeLogCapture().logError,
  };

  const result = await runExportPush(plan, { authHeader: "Basic x", updateExisting: true }, deps);

  assert.strictEqual(attempted.length, 2, "both updates should be attempted (no abort)");
  assert.strictEqual(result.updated, 1, "the second update should have succeeded");
  assert.strictEqual(result.failed, 1, "the first update should be counted as failed");
  assert.strictEqual(result.failures[0]!.op, "update");
  assert.strictEqual(result.failures[0]!.ref, "PROJ-1", "failure should reference the Jira key");
});

test("runExportPush: happy path reports zero failures (no regression)", async () => {
  const plan = threeCreatePlan();
  const deps = { post: async () => "{}", put: async () => "{}", logError: makeLogCapture().logError };
  const result = await runExportPush(plan, { authHeader: "Basic x", updateExisting: false }, deps);
  assert.deepStrictEqual(
    { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed },
    { created: 3, updated: 0, skipped: 0, failed: 0 }
  );
  assert.strictEqual(result.failures.length, 0);
});

test("runExportPush: never PUTs an existing item when updateExisting is off (counts it skipped)", async () => {
  const items = [
    { id: "new-1", title: "New", type: "task" },
    { id: "old-1", title: "Old", description: jiraProvenance("PROJ-9", "https://example.atlassian.net/browse/PROJ-9") },
  ];
  const plan = buildExportPlan(items as any, "https://example.atlassian.net", { projectKey: "PROJ" });
  let puts = 0;
  const deps = { post: async () => "{}", put: async () => { puts++; return ""; }, logError: makeLogCapture().logError };
  const result = await runExportPush(plan, { authHeader: "Basic x", updateExisting: false }, deps);
  assert.strictEqual(puts, 0, "no PUT should be issued when --update-existing is off");
  assert.strictEqual(result.created, 1);
  assert.strictEqual(result.skipped, 1, "the provenance-matched item is skipped, not failed");
  assert.strictEqual(result.failed, 0);
});

// --- alias flags: --field-map / --project-key -----------------------------

test("readStringOptionAliased returns the first non-empty value across alias keys", () => {
  assert.strictEqual(readStringOptionAliased({ map: "a=b" }, "map", "field-map"), "a=b");
  assert.strictEqual(readStringOptionAliased({ fieldMap: "x=y" }, "map", "field-map"), "x=y");
  assert.strictEqual(readStringOptionAliased({ "field-map": "p=q" }, "map", "field-map"), "p=q");
  assert.strictEqual(readStringOptionAliased({}, "map", "field-map"), undefined);
  // project-key alias for project
  assert.strictEqual(readStringOptionAliased({ projectKey: "PROJ" }, "project", "project-key"), "PROJ");
  assert.strictEqual(readStringOptionAliased({ "project-key": "PROJ" }, "project", "project-key"), "PROJ");
});

test("readJqlFilters reads --project-key as an alias for --project", () => {
  assert.strictEqual(readJqlFilters({ "project-key": "PROJ" }).project, "PROJ");
  assert.strictEqual(readJqlFilters({ projectKey: "PK" }).project, "PK");
  assert.strictEqual(readJqlFilters({ project: "P" }).project, "P");
});

test("buildJql uses the project-key alias via readJqlFilters", () => {
  assert.strictEqual(
    buildJql(readJqlFilters({ "project-key": "ALIAS" })),
    "project = ALIAS AND statusCategory != Done ORDER BY priority ASC"
  );
});

test("parseFieldMap is reached via --field-map alias in runImport dry-run", async () => {
  // --field-map with an unknown source field must still surface a USAGE error
  // through the alias path (proves the alias is wired into parseFieldMap).
  const ext = await getHarness();
  await assert.rejects(
    async () =>
      ext.runCommand({
        command: "jira sync",
        options: { "project-key": "PROJ", "field-map": "bogus=x", "dry-run": true },
        pmRoot: ".agents/pm",
      }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      return true;
    }
  );
});

test("--project-key alias drives the import dry-run (no creds needed)", async () => {
  const prev = {
    url: process.env.JIRA_BASE_URL, token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL,
  };
  try {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_EMAIL;
    const ext = await getHarness();
    const { result } = await ext.runCommand({
      command: "jira sync",
      options: { "project-key": "ALIASPROJ", "dry-run": true },
      pmRoot: ".agents/pm",
    });
    const res = result as { dryRun: boolean; project: string; jql: string };
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.project, "ALIASPROJ");
    assert.match(res.jql, /^project = ALIASPROJ AND statusCategory != Done/);
  } finally {
    if (prev.url) process.env.JIRA_BASE_URL = prev.url; else delete process.env.JIRA_BASE_URL;
    if (prev.token) process.env.JIRA_API_TOKEN = prev.token; else delete process.env.JIRA_API_TOKEN;
    if (prev.email) process.env.JIRA_EMAIL = prev.email; else delete process.env.JIRA_EMAIL;
  }
});

// --- improved auth-failure error messages -------------------------------

test("classifyHttpError produces a prescriptive 401 auth message", () => {
  const msg = classifyHttpError(401, "{\"message\":\"unauthorized\"}");
  assert.match(msg, /authentication failed/);
  assert.match(msg, /HTTP 401/);
  assert.match(msg, /JIRA_API_TOKEN/);
  assert.match(msg, /api-tokens/);
  assert.match(msg, /unauthorized/); // body snippet preserved
});

test("classifyHttpError produces a prescriptive 403 authorization message", () => {
  const msg = classifyHttpError(403, "forbidden");
  assert.match(msg, /authorization failed/);
  assert.match(msg, /HTTP 403/);
  assert.match(msg, /permission/);
});

test("classifyHttpError falls back to compact message for other status codes", () => {
  assert.match(classifyHttpError(404, "nope"), /Jira API error 404: nope/);
  assert.match(classifyHttpError(500, "boom"), /Jira API error 500: boom/);
  assert.match(classifyHttpError(undefined, "x"), /Jira API error 0: x/);
  assert.match(classifyHttpError(500, null), /Jira API error 500: $/);
});

// ---------------------------------------------------------------------------
// Regression: `pm jira export` (dry-run / default, no --push) used to write
// the payloads preview to STDOUT via console.log while the SDK host also
// rendered the returned object to stdout — so stdout was JSON + trailing
// YAML and not valid JSON. The fix routes the preview to STDERR and
// enriches the returned object with the payloads so `--json` yields a single
// clean, complete JSON object. This test is deterministic + offline (no real
// Jira network): it spins up a throwaway pm tracker with two known items.
// ---------------------------------------------------------------------------

// On Windows the runnable pm shim is `pm.cmd`; the extensionless `pm` name is
// not spawnable. Node also refuses to spawn `.cmd`/`.bat` directly since the
// CVE-2024-27980 mitigation (EINVAL), so on win32 we must go through a shell.
// Args here are static test values (never user input), so `shell:true` is safe.
const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32" };

function withTempTracker(items: { title: string; type?: string }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-jira-export-"));
  // If any setup spawn fails, remove the freshly-created temp dir before
  // rethrowing so a setup failure never leaks a workspace (the caller's
  // try/finally only covers the dir once it has been returned).
  try {
    // Initialize a fresh tracker so `pm list --json` succeeds (returns []).
    const init = spawnSync(PM_BIN, ["--path", dir, "init"], PM_SPAWN_OPTS);
    assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
    // Assert the tracker starts empty — proves the precondition and catches
    // future changes in tracker initialization that could skew the export.
    const list = spawnSync(PM_BIN, ["--path", dir, "list", "--json"], PM_SPAWN_OPTS);
    assert.strictEqual(list.status, 0, `pm list failed: ${list.error?.message ?? list.stderr}`);
    const listed = JSON.parse(list.stdout) as { items?: unknown[] } | unknown[];
    const listedItems = Array.isArray(listed) ? listed : (listed.items ?? []);
    assert.strictEqual(listedItems.length, 0, "expected a freshly initialized tracker to be empty");
    for (const it of items) {
      const args = ["--path", dir, "create", "task", it.title, "--priority", "3"];
      if (it.type) args.push("--type", it.type);
      const created = spawnSync(PM_BIN, args, {
        ...PM_SPAWN_OPTS,
        env: { ...process.env, PM_AUTHOR: "pm-jira-test" },
      });
      assert.strictEqual(created.status, 0, `pm create failed: ${created.error?.message ?? created.stderr}`);
    }
    return dir;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

test("pm jira export (no --push) routes preview to stderr and returns payloads", async () => {
  const dir = withTempTracker([
    { title: "Export item alpha" },
    { title: "Export item beta" },
  ]);
  try {
    const ext = await getHarness();

    // Spy on stdout/console.log and stderr/console.error to prove the preview
    // is no longer written to stdout. Restore unconditionally via finally.
    const logCalls: unknown[] = [];
    const errorCalls: unknown[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => logCalls.push(args);
    console.error = (...args: unknown[]) => errorCalls.push(args);
    try {
      const { result } = await ext.runExporter({
        exporter: "jira",
        options: { project: "PROJ" },
        pmRoot: dir,
      });
      const exportResult = result as {
        exported: number;
        pushed: boolean;
        dryRun: boolean;
        plan: { op: string; method: string; endpoint: string; payload: { fields: unknown } }[];
      };

      // 1) stdout MUST be clean: the extension must not console.log anything.
      assert.strictEqual(logCalls.length, 0, "exporter must not write to stdout (console.log)");
      // 2) the human payload preview now goes to stderr as a JSON array.
      assert.ok(errorCalls.length > 0, "exporter should write the preview to stderr");
      // Robustly locate the JSON-array preview: parse each stderr line and keep
      // the one that yields an array, rather than matching a leading "[" (which
      // could false-match a "[dry-run] ..." note or "[object Object]").
      let preview: unknown;
      const previewJson = errorCalls.find((c) => {
        try {
          const parsed = JSON.parse(Array.isArray(c) ? String(c[0]) : String(c));
          if (Array.isArray(parsed)) {
            preview = parsed;
            return true;
          }
        } catch {
          /* not JSON — keep looking */
        }
        return false;
      });
      assert.ok(previewJson, "stderr should contain the JSON array preview");
      assert.ok(Array.isArray(preview), "preview must be a JSON array");
      assert.strictEqual(preview.length, 2, "preview should list both payloads");
      for (const p of preview) {
        assert.ok(p && typeof p === "object" && "fields" in p, "each preview entry is a Jira payload");
      }
      // 3) the returned object carries the full plan entries (op/method/
      //    endpoint/payload) — the same array-of-entries shape as pm-github's
      //    `plan` — so `--json` consumers get the complete, actionable plan.
      assert.strictEqual(exportResult.exported, 2, "exported count matches item count");
      assert.strictEqual(exportResult.pushed, false, "default export is a non-push preview");
      assert.strictEqual(exportResult.dryRun, true, "default export is marked as a dry-run preview");
      assert.ok(Array.isArray(exportResult.plan), "return must include the plan entries array");
      assert.strictEqual(exportResult.plan.length, 2, "returned plan carries every entry");
      for (const entry of exportResult.plan) {
        assert.ok(entry && typeof entry === "object", "each plan entry is an object");
        assert.ok(entry.op === "create" || entry.op === "update", "entry has a create/update op");
        assert.ok(entry.payload && "fields" in entry.payload, "entry carries its Jira payload");
      }
      // The stderr preview is exactly the payloads of the returned plan entries.
      assert.deepStrictEqual(
        exportResult.plan.map((e) => e.payload),
        preview,
        "returned plan entries' payloads match the stderr preview exactly"
      );
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
