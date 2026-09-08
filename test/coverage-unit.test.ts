/**
 * Behavioural tests for previously unreached branches in the public surface.
 *
 * These are pure (no https, no process.exit, no PATH swaps) so they can run
 * alongside the rest of the suite without serialising on global mocks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandError,
  EXIT_CODE,
  adfToPlainText,
  buildJql,
  decidePushOnWrite,
  diagnoseCreds,
  extractJiraKey,
  handlePushOnWrite,
  itemToJiraPayload,
  issueToItem,
  jqlQuote,
  mapJiraIssueType,
  mapJiraPriority,
  mapJiraStatus,
  mapPmPriorityToJira,
  mapPmTypeToJira,
  normalizePmStatusInput,
  optionEnabled,
  optionInt,
  optionString,
  optionsOrEmpty,
  parseFieldMap,
  parseStatusMap,
  plainTextToAdf,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  readStringOptionAliased,
  resolveCreds,
} from "../index.ts";
import type { JiraIssue } from "../index.ts";

function fakeIssue(overrides: Partial<JiraIssue["fields"]> & { key?: string } = {}): JiraIssue {
  const { key, ...fields } = overrides;
  return {
    key: key ?? "PROJ-1",
    fields: {
      summary: "summary",
      description: null,
      status: { name: "To Do", statusCategory: { key: "new" } },
      priority: { name: "Medium" },
      labels: [],
      components: [],
      assignee: null,
      duedate: null,
      fixVersions: [],
      issuetype: { name: "Task" },
      customfield_10020: null,
      ...fields,
    },
  };
}

test("mapJiraPriority covers critical, lowest, and unknown names", () => {
  assert.equal(mapJiraPriority("critical"), 1);
  assert.equal(mapJiraPriority("Critical"), 1);
  assert.equal(mapJiraPriority("lowest"), 4);
  assert.equal(mapJiraPriority("Lowest"), 4);
  assert.equal(mapJiraPriority("unmapped"), 3);
});

test("mapJiraStatus covers the remaining built-in names", () => {
  assert.equal(mapJiraStatus("In Review"), "in_progress");
  assert.equal(mapJiraStatus("In Development"), "in_progress");
  assert.equal(mapJiraStatus("Closed"), "closed");
  assert.equal(mapJiraStatus("Complete"), "closed");
  assert.equal(mapJiraStatus("Completed"), "closed");
});

test("normalizePmStatusInput treats empty and whitespace as missing", () => {
  assert.equal(normalizePmStatusInput(undefined), undefined);
  assert.equal(normalizePmStatusInput(""), undefined);
  assert.equal(normalizePmStatusInput("   "), undefined);
});

test("parseFieldMap rejects empty names, skips blank pairs, and collapses an empty map", () => {
  assert.throws(() => parseFieldMap("=Task"), (err: unknown) => {
    assert.ok(err instanceof CommandError);
    assert.equal(err.exitCode, EXIT_CODE.USAGE);
    assert.match(err.message, /empty field name/);
    return true;
  });
  assert.throws(() => parseFieldMap("issuetype="), /empty field name/);
  assert.deepEqual(parseFieldMap("issuetype=Task,,assignee=skip"), {
    issuetype: "Task",
    assignee: "skip",
  });
  assert.equal(parseFieldMap(",, ,"), undefined);
});

test("parseStatusMap rejects an empty Jira status and collapses an empty map", () => {
  assert.throws(() => parseStatusMap("=open"), (err: unknown) => {
    assert.ok(err instanceof CommandError);
    assert.match(err.message, /empty Jira status/);
    return true;
  });
  assert.deepEqual(parseStatusMap("QA=done,,WIP=wip"), {
    qa: "closed",
    wip: "in_progress",
  });
  assert.equal(parseStatusMap(" , , "), undefined);
});

test("adfToPlainText returns empty for a node with neither text nor content", () => {
  assert.equal(adfToPlainText({ type: "hardBreak" }), "");
  assert.equal(adfToPlainText({ type: "doc", content: "not-an-array" as unknown as never }), "");
  assert.equal(adfToPlainText({ type: "text", text: 1 as unknown as never }), "");
});

test("plainTextToAdf keeps non-empty whitespace-padded text", () => {
  const adf = plainTextToAdf("  kept  ");
  assert.equal(adf.content[0]?.content[0]?.text, "  kept  ");
});

test("extractJiraKey returns undefined for missing text", () => {
  assert.equal(extractJiraKey(undefined), undefined);
  assert.equal(extractJiraKey(""), undefined);
});

test("diagnoseCreds host without a scheme, and an unparseable URL", () => {
  const noScheme = diagnoseCreds(
    { host: "co.atlassian.net" },
    { JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" },
  );
  assert.equal(noScheme.hostPreview, "co.atlassian.net");
  const invalid = diagnoseCreds(
    { host: "http://[not-a-host" },
    { JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" },
  );
  assert.equal(invalid.hostPreview, undefined);
  assert.equal(invalid.ready, true);
});

test("resolveCreds treats a blank JIRA_BASE_URL as missing", () => {
  assert.throws(
    () =>
      resolveCreds(
        {},
        { JIRA_BASE_URL: "   ", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" },
      ),
    /JIRA_BASE_URL/,
  );
});

test("option readers coerce non-strings, numbers, null, and boolean strings", () => {
  assert.equal(readStringOption({ project: 12 }, "project"), "12");
  assert.equal(readNumberOption({ "max-results": 50 }, "max-results"), 50);
  assert.equal(readNumberOption({ "max-results": null }, "max-results"), undefined);
  assert.equal(readBooleanOption({ push: true }, "push"), true);
  assert.equal(readBooleanOption({ push: "yes" }, "push"), true);
  assert.equal(readBooleanOption({ push: "" }, "push"), true);
  assert.equal(readBooleanOption({ push: "1" }, "push"), true);
  assert.equal(readBooleanOption({ push: "false" }, "push"), false);
  assert.equal(readBooleanOption({ push: 2 }, "push"), true);
  assert.equal(optionString({}, "missing"), undefined);
  assert.equal(optionInt({ n: Number.NaN }, 7, "n"), 7);
  assert.equal(optionEnabled({ x: "nope" }, "x"), false);
  assert.equal(readStringOptionAliased({}, "map", "field-map"), undefined);
});

test("buildJql covers issue type, blocked/open status, quoted assignee, and blank --jql", () => {
  assert.match(buildJql({ issueType: "Bug" }), /issuetype = Bug/);
  assert.match(buildJql({ status: "open" }), /statusCategory = "To Do"/);
  assert.match(buildJql({ status: "blocked" }), /status = "Blocked"/);
  assert.match(buildJql({ assignee: "ada" }), /assignee = ada/);
  assert.equal(
    buildJql({ jql: "   " }),
    "statusCategory != Done ORDER BY priority ASC",
  );
  assert.equal(jqlQuote("PROJ.1"), "PROJ.1");
});

test("mapJiraIssueType and reverse maps cover remaining names", () => {
  assert.equal(mapJiraIssueType("defect"), "Bug");
  assert.equal(mapJiraIssueType("User Story"), "Feature");
  assert.equal(mapJiraIssueType("sub-task"), "Task");
  assert.equal(mapJiraIssueType("subtask"), "Task");
  assert.equal(mapPmTypeToJira(undefined), "Task");
  assert.equal(mapPmTypeToJira("epic"), "Story");
  assert.equal(mapPmTypeToJira("story"), "Story");
  assert.equal(mapPmPriorityToJira(undefined), "Medium");
  assert.equal(mapPmPriorityToJira(99), "Medium");
});

test("issueToItem covers missing collections, object sprints, and a statusCategory pin", () => {
  const issue = fakeIssue({
    labels: undefined,
    fixVersions: undefined,
    components: undefined,
    customfield_10020: { name: "Sprint 9" },
    status: { name: "Awaiting", statusCategory: { key: "indeterminate" } },
  });
  const item = issueToItem(issue, "https://x.atlassian.net/", {
    fieldMap: { statuscategory: "blocked" },
  });
  assert.equal(item.status, "blocked");
  assert.ok(item.tags.includes("sprint:Sprint 9"));

  const unnamed = issueToItem(
    fakeIssue({ customfield_10020: { name: undefined } }),
    "https://x.atlassian.net",
  );
  assert.ok(!unnamed.tags.some((tag) => tag.startsWith("sprint:")));

  const skippedPin = issueToItem(fakeIssue({ status: { name: "Done", statusCategory: { key: "done" } } }), "https://x.atlassian.net", {
    fieldMap: { status: "not-a-pm-status" },
  });
  assert.equal(skippedPin.status, "closed");

  const typed = issueToItem(fakeIssue(), "https://x.atlassian.net", {
    fieldMap: { issuetype: "Chore" },
  });
  assert.equal(typed.type, "Chore");
});

test("itemToJiraPayload untitled titles and rich type pins", () => {
  assert.equal(itemToJiraPayload({}).fields.summary, "(untitled)");
  assert.equal(itemToJiraPayload({ title: "   " }).fields.summary, "(untitled)");
  const byType = itemToJiraPayload(
    { title: "x", type: "Task" },
    { richMapping: true, fieldMap: { type: "Story" } },
  );
  assert.equal(byType.fields.issuetype.name, "Story");
  const byIssueType = itemToJiraPayload(
    { title: "x", type: "Task" },
    { richMapping: true, fieldMap: { issuetype: "Bug" } },
  );
  assert.equal(byIssueType.fields.issuetype.name, "Bug");
});

test("decidePushOnWrite accepts yes/on and ignores unhandled or missing ops", () => {
  assert.equal(
    decidePushOnWrite({ op: "create", scope: "project" }, { PM_JIRA_PUSH_ON_WRITE: "yes" }).shouldPush,
    true,
  );
  assert.equal(
    decidePushOnWrite({ op: "update", scope: "project" }, { PM_JIRA_PUSH_ON_WRITE: "on" }).shouldPush,
    true,
  );
  assert.equal(decidePushOnWrite(undefined, { PM_JIRA_PUSH_ON_WRITE: "1" }).shouldPush, false);
  assert.match(
    decidePushOnWrite({ op: "rename", scope: "project" }, { PM_JIRA_PUSH_ON_WRITE: "1" }).reason,
    /unhandled op/,
  );
});

test("handlePushOnWrite no-ops, swallows diagnose failures, and ignores missing creds", () => {
  handlePushOnWrite({ op: "create", scope: "project" }, {});
  handlePushOnWrite(
    { op: "create", scope: "project" },
    { PM_JIRA_PUSH_ON_WRITE: "1" },
  );
  handlePushOnWrite(
    { op: "create", scope: "project" },
    {
      PM_JIRA_PUSH_ON_WRITE: "1",
      JIRA_BASE_URL: "https://x.atlassian.net",
      JIRA_EMAIL: "a@b.c",
      JIRA_API_TOKEN: "t",
    },
  );
  let called = false;
  handlePushOnWrite(
    { op: "create", scope: "project" },
    { PM_JIRA_PUSH_ON_WRITE: "1" },
    () => {
      called = true;
      throw new Error("diagnose boom");
    },
  );
  assert.equal(called, true);
});

test("optionsOrEmpty returns the bag when present and {} when falsy", () => {
  const bag = { project: "P" };
  assert.equal(optionsOrEmpty(bag), bag);
  assert.deepEqual(optionsOrEmpty(undefined), {});
  assert.deepEqual(optionsOrEmpty(null), {});
  assert.deepEqual(optionsOrEmpty(""), {});
  assert.deepEqual(optionsOrEmpty(0), {});
  assert.deepEqual(optionsOrEmpty(false), {});
});

test("CommandError defaults to GENERIC_FAILURE", () => {
  const err = new CommandError("nope");
  assert.equal(err.exitCode, EXIT_CODE.GENERIC_FAILURE);
  assert.equal(err.name, "CommandError");
});
