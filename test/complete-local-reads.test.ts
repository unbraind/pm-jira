/** Real SDK/tracker regressions for complete reads; no SDK replacement or mock. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  createHistoryEntry, emptyImportedDocument, getHistoryPath, getItemPath, listAllComplete,
  nowIso, serializeItemDocument, writeFileAtomic, commitItemMutations, WorkspaceTransactionInterruptedError,
} from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { CommandError, certifyPmItems, jiraProvenance, readPmItems, runImport } from "../index.ts";
import type { JiraIssue } from "../index.ts";

/** Initialize a real disposable tracker with the installed CLI, outside the package tracker. */
async function tracker(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jira-complete-"));
  execFileSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
    "--path", root, "init", "fixture"], { stdio: "pipe" });
  return root;
}

/** Generate real TOON items and hashed import history through public SDK serialization and writers. */
async function seed(root: string, count: number): Promise<void> {
  const timestamp = nowIso();
  await mkdir(dirname(getItemPath(root, "Task", "fixture-0")), { recursive: true });
  for (let start = 0; start < count; start += 32) {
    await Promise.all(Array.from({ length: Math.min(32, count - start) }, async (_, offset) => {
      const n = start + offset;
      const id = `fixture-${String(n).padStart(5, "0")}`;
      const document = emptyImportedDocument();
      document.metadata = {
        id, title: `Local work ${n}`, type: "Task", status: n === 0 ? "closed" : n === 1 ? "canceled" : "open",
        priority: 3, tags: [], created_at: timestamp, updated_at: timestamp,
        ...(n === 0 ? { jira_url: "https://example.invalid/browse/ONE-0" } : {}),
        description: n === 1 ? "" : jiraProvenance(`ONE-${n === 2 ? 0 : n}`, `https://example.invalid/browse/ONE-${n === 2 ? 0 : n}`),
      };
      document.body = `Retained body ${n}` + (n === 1 ? "\n" + jiraProvenance("ONE-1", "https://example.invalid/browse/ONE-1") : "");
      await writeFileAtomic(getItemPath(root, "Task", id), serializeItemDocument(document, { format: "toon" }));
      const history = createHistoryEntry({ nowIso: timestamp, author: "jira-fixture", op: "import",
        before: emptyImportedDocument(), after: document, message: "Seed synthetic read fixture" });
      await writeFileAtomic(getHistoryPath(root, id), `${JSON.stringify(history)}\n`);
    }));
  }
}

/** Build offline prefetched Jira issues so import tests never need credentials or a service. */
function issues(keys: number[]): JiraIssue[] {
  return keys.map(n => ({ key: `ONE-${n}`, fields: {
    summary: `Issue ${n}`, status: { name: "To Do", statusCategory: { key: "new" } },
  } }));
}

/** Snapshot durable item/history content to prove refusal precedes every tracker write. */
async function durableSnapshot(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  for (const folder of ["tasks", "history"]) {
    for (const file of (await readdir(join(root, folder))).sort()) {
      snapshot.push(`${folder}/${file}:${await readFile(join(root, folder, file), "utf8")}`);
    }
  }
  return snapshot;
}

test("complete export retains more than 10000 items, terminal work, and bodies", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seed(root, 10003);
  const certified = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true });
  execFileSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
    "--path", root, "history", "fixture-10002", "--verify", "--strict-exit"], { stdio: "pipe" });
  assert.equal(certified.complete_list.item_count, 10003);
  assert.equal(certified.complete_list.terminal_items_included, true);
  const ext = await createExtensionTestHarness(extension, {
    name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
  });
  const { result } = await ext.runExporter({ exporter: "jira", pmRoot: root,
    options: { "dry-run": true, "update-existing": true, project: "ONE" } });
  const exported = result as { plan: { entries: { existingKey?: string; payload: unknown }[] } };
  assert.equal(exported.plan.entries.length, 10003);
  assert.ok(exported.plan.entries.some(entry => entry.existingKey === "ONE-0"));
  assert.ok(exported.plan.entries.some(entry => entry.existingKey === "ONE-1"));
  assert.match(JSON.stringify(exported.plan.entries), /Retained body 10002/);
});

test("terminal matching and re-import create nothing on the second import in either mode", async t => {
  for (const atomic of [false, true]) await t.test(atomic ? "atomic" : "sequential", async t => {
    const root = await tracker();
    t.after(() => rm(root, { recursive: true, force: true }));
    await seed(root, 2);
    const options = { project: "ONE", host: "https://example.invalid" };
    const first = await runImport(options, root, { atomic, issues: issues([0, 1, 2]) });
    assert.ok("imported" in first);
    assert.equal(first.imported, 1, "closed/canceled matches are skipped");
    const before = await durableSnapshot(root);
    const second = await runImport(options, root, { atomic, issues: issues([0, 1, 2]) });
    assert.ok("imported" in second);
    assert.equal(second.imported, 0);
    assert.deepEqual(await durableSnapshot(root), before, "no local item or history write on re-import");
    assert.equal((await readPmItems(root)).length, 3);
    // A different Jira instance with the same key remains a distinct identity.
    const otherHost = await runImport({ ...options, host: "https://other.invalid" }, root,
      { atomic, issues: issues([0]) });
    assert.ok("imported" in otherHost);
    assert.equal(otherHost.imported, 1);
  });
});

test("every incomplete or malformed answer is refused using a real SDK envelope", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seed(root, 2);
  const answer = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true });
  assert.equal((await certifyPmItems(answer)).length, 2);
  assert.equal((await certifyPmItems({ ...answer, items: answer.items.map(item => ({
    ...item, tags: undefined, priority: undefined, description: undefined, jira_key: undefined, jira_url: undefined,
  })) })).length, 2, "optional payload fields can be absent without omissions");
  const cases: [string, unknown][] = [
    ["missing answer", undefined], ["null answer", null], ["array envelope", answer.items],
    ["missing items", { ...answer, items: undefined }], ["results alias", { results: answer.items }],
    ["non-array items", { ...answer, items: {} }],
    ["truncated", { ...answer, truncated: true }], ["has_more", { ...answer, has_more: true }],
    ["next_cursor", { ...answer, next_cursor: "more" }], ["row ceiling", { ...answer, applied_limit: 2 }],
    ["missing body proof", { ...answer, filters: { ...answer.filters, include_body: undefined } }],
    ["missing pagination proof", { ...answer, truncated: undefined }],
    ["count mismatch", { ...answer, total: 3 }],
    ["partial source", { ...answer, completeness: { ...answer.completeness, status: "partial" } }],
    ["unchecked source", { ...answer, completeness: { status: "unchecked" } }],
    ["missing source proof", { ...answer, completeness: undefined }],
    ["unreadable source", { ...answer, completeness: { ...answer.completeness, unreadable_item_count: 1 } }],
    ["filtered", { ...answer, filters: { ...answer.filters, status: "open" } }],
    ["terminal exclusion", { ...answer, filters: { ...answer.filters, exclude_terminal: true } }],
    ["non-strict", { ...answer, filters: { ...answer.filters, strict_read: false } }],
    ["compact projection", { ...answer, projection: { mode: "compact", fields: null } }],
    ["missing omission receipt", { ...answer, omission_receipt: undefined }],
    ["field omission", { ...answer, omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: [] } }],
    ["contradictory omission receipt", { ...answer, omission_receipt: { has_omissions: false, omitted_field_groups: [], omitted_field_group_count: 1 } }],
    ["missing output receipt", { ...answer, read_output: undefined }],
    ["malformed output receipt", { ...answer, read_output: {} }],
    ["unproven output dimensions", { ...answer, read_output: { ...answer.read_output, requested_dimensions: [] } }],
    ["string compaction", { ...answer, read_output: { ...answer.read_output, strings_compacted: true } }],
    ["row compaction", { ...answer, read_output: { ...answer.read_output, rows_compacted: true } }],
    ["output truncation", { ...answer, output_budget_truncation: {} }],
    ["result omission", { ...answer, read_output: { ...answer.read_output, result_omitted: true } }],
    ["budget omission", { ...answer, output_budget_exceeded: { omitted_result: true } }],
    ["session projection", { ...answer, read_session: {} }],
    ["null row", { ...answer, items: [null, answer.items[1]] }],
    ["missing id", { ...answer, items: [{ ...answer.items[0], id: undefined }, answer.items[1]] }],
    ["duplicate id", { ...answer, items: [answer.items[0], answer.items[0]] }],
    ...["title", "status", "type", "body", "description", "jira_key", "jira_url", "tags", "priority"].map(field =>
      [`malformed ${field}`, { ...answer, items: [{ ...answer.items[0], [field]: {} }, answer.items[1]] }] as [string, unknown]),
    ["missing body", { ...answer, items: [{ ...answer.items[0], body: undefined }, answer.items[1]] }],
    ["blank title", { ...answer, items: [{ ...answer.items[0], title: " " }, answer.items[1]] }],
    ["bad tag element", { ...answer, items: [{ ...answer.items[0], tags: [4] }, answer.items[1]] }],
    ...[-1, 5, 2.5].map(priority => [`invalid priority ${priority}`,
      { ...answer, items: [{ ...answer.items[0], priority }, answer.items[1]] }] as [string, unknown]),
  ];
  const before = await durableSnapshot(root);
  for (const [name, candidate] of cases) await t.test(name, async () => {
    await assert.rejects(() => certifyPmItems(candidate), (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /Cannot certify complete local items/);
      assert.match(error.message, /strict-read.*no-truncate.*unbounded/);
      return true;
    });
  });
  assert.deepEqual(await durableSnapshot(root), before);
});

test("corrupt tracker refuses export push and import before writes without credentials", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seed(root, 2);
  await writeFile(join(root, "tasks", "broken.toon"), "{ invalid tracker document");
  const before = await durableSnapshot(root);
  const ext = await createExtensionTestHarness(extension, {
    name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
  });
  await assert.rejects(() => ext.runExporter({ exporter: "jira", pmRoot: root,
    options: { push: true, project: "ONE" } }), /Cannot read complete local items.*strict-read/s);
  await assert.rejects(() => runImport({ project: "ONE", host: "https://example.invalid" }, root,
    { atomic: true, issues: issues([2]) }), /Cannot read complete local items/);
  assert.deepEqual(await durableSnapshot(root), before);
});

test("empty certified tracker succeeds and an uninitialized tracker refuses", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readPmItems(root), []);
  assert.deepEqual(await readPmItems(relative(process.cwd(), root)), []);
  const missing = join(root, "uninitialized");
  await mkdir(missing);
  await assert.rejects(() => readPmItems(missing), /Cannot read complete local items/);
});


test("atomic recovery retains its original plan after a real SDK interruption", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { project: "ONE", host: "https://example.invalid" };
  const fetched = issues([10, 11, 12]);
  await assert.rejects(() => runImport(options, root, { atomic: true, issues: fetched,
    commitItemMutations: params => commitItemMutations({ ...params, onTransition(context) {
      if (context.transition === "step_applied") throw new WorkspaceTransactionInterruptedError("Synthetic interruption");
    } }),
  }), /Synthetic interruption/);
  assert.equal((await readPmItems(root)).length, 1);
  const resumed = await runImport(options, root, { atomic: true, issues: fetched });
  assert.ok("imported" in resumed);
  assert.equal(resumed.imported, 2, "only newly applied creates count as imported");
  assert.equal((await readPmItems(root)).length, 3);
  const before = await durableSnapshot(root);
  const repeated = await runImport(options, root, { atomic: true, issues: fetched });
  assert.ok("imported" in repeated);
  assert.equal(repeated.imported, 0);
  assert.deepEqual(await durableSnapshot(root), before);
});


test("matching indexes URL fields, body provenance, and repeated local identities", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seed(root, 3);
  const result = await runImport({ project: "ONE", host: "https://example.invalid" }, root,
    { issues: issues([0, 1]) });
  assert.ok("imported" in result);
  assert.equal(result.imported, 0);
  assert.equal((await readPmItems(root)).length, 3);
});
