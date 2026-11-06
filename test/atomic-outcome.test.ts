/** Recovery diagnostics must describe observed outcomes, not presumed rollback. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmClient, commitItemMutations, WorkspaceTransactionInterruptedError } from "@unbrained/pm-cli/sdk";
import { readPmItems, runImport, type JiraIssue } from "../index.ts";

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
