/** Recovery diagnostics must describe observed outcomes, not presumed rollback. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmClient, commitItemMutations, readWorkspaceTransaction, WorkspaceTransactionInterruptedError } from "@unbrained/pm-cli/sdk";
import { importJiraAtomic, issueToItem, readPmItems, runImport, type JiraIssue } from "../index.ts";

/** Use real SDK initialization without Git or a CLI subprocess. */
async function tracker() {
  const root = await mkdtemp(join(tmpdir(), "jira-outcome-"));
  await new PmClient({ pmRoot: root, cwd: root, noExtensions: true }).init("fixture");
  return root;
}

/** Build a deterministic synthetic batch. */
function issues(summary = "Original"): JiraIssue[] {
  return [1, 2].map(n => ({ key: `ONE-${n}`, fields: { summary, status: { name: "To Do", statusCategory: { key: "new" } } } }));
}
const options = { project: "ONE", host: "https://example.invalid" };

test("interruption reports resumable retained work, then retries the real SDK journal", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => runImport(options, root, { atomic: true, issues: issues(),
    commitItemMutations: params => commitItemMutations({ ...params, onTransition(context) {
      if (context.transition === "step_applied") throw new WorkspaceTransactionInterruptedError("Synthetic boundary");
    } }),
  }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /interrupted.*Retry the same input to resume/s);
    assert.doesNotMatch(error.message, /was rolled back|no committed items|every applied create was compensated/);
    return true;
  });
  assert.equal((await readPmItems(root)).length, 1);
  const resumed = await runImport(options, root, { atomic: true, issues: issues() });
  assert.ok("imported" in resumed);
  assert.equal(resumed.imported, 1);
  assert.equal((await readPmItems(root)).length, 2);
});

test("a journal-plan refusal never claims existing committed work was deleted", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  await runImport(options, root, { atomic: true, issues: issues() });
  const before = await readPmItems(root);
  await assert.rejects(() => runImport(options, root, { atomic: true, issues: issues("Changed") }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /rollback is not confirmed.*transaction journal/s);
    assert.doesNotMatch(error.message, /was rolled back|no committed items|every applied create was compensated/);
    return true;
  });
  assert.deepEqual(await readPmItems(root), before);
});


/** Snapshot durable native state to prove validation precedes every tracker write. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const result = new Map<string, string>();
  for (const entry of entries) if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name);
    result.set(path.slice(root.length + 1), await readFile(path, "utf8"));
  }
  return result;
}

for (const scenario of [
  { name: "empty batch", empty: true, controls: {} },
  { name: "blank author", empty: false, controls: { atomicAuthor: " \t " } },
  { name: "invalid transaction identity", empty: false, controls: { atomicTransactionId: "invalid/id" } },
]) test(`pre-commit ${scenario.name} refusal gives no journal recovery advice`, async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await snapshot(root);
  const selected = scenario.empty ? [] : issues().map(issue => ({ issue, item: issueToItem(issue, options.host) }));
  await assert.rejects(() => importJiraAtomic(root, "project = ONE", selected, scenario.controls), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Atomic Jira import validation failed/);
    assert.doesNotMatch(error.message, /journal|rollback|Retry the same input|Transaction id:/);
    assert.equal(Reflect.get(error, "exitCode"), 2);
    return true;
  });
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(await readPmItems(root), []);
  // Valid padded controls retain the existing item-ID derivation and SDK normalization.
  const fetched = issues();
  const validSelected = fetched.map(issue => ({ issue, item: issueToItem(issue, options.host) }));
  const first = await importJiraAtomic(root, "project = ONE", validSelected,
    { atomicAuthor: "  fixture café  ", atomicTransactionId: "  valid-identity  " });
  assert.equal(first.created, 2);
  assert.equal(first.transactionId, "  valid-identity  ");
  assert.equal((await readWorkspaceTransaction(root, "valid-identity"))!.transactionId, "valid-identity");
  const journal = await readWorkspaceTransaction(root, first.transactionId);
  assert.equal(journal!.author, "fixture café");
  const committed = await snapshot(root);
  const replay = await importJiraAtomic(root, "project = ONE", validSelected,
    { atomicAuthor: "  fixture café  ", atomicTransactionId: "  valid-identity  " });
  assert.equal(replay.transactionId, first.transactionId);
  assert.deepEqual(await snapshot(root), committed);
  assert.equal((await readPmItems(root)).length, 2);
});
