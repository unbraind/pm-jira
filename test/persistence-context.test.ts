/** Bound persistence regressions using real SDK trackers outside Git. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmClient, getHistoryPath, readHistoryEntries, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
import { bindJiraPersistence, readPmItems, runImport, type JiraIssue } from "../index.ts";

/** Create two independent real trackers sharing the same relative path. */
async function trackers() {
  const root = await mkdtemp(join(tmpdir(), "jira-binding-"));
  for (const name of ["first", "second"]) {
    const cwd = join(root, name);
    await mkdir(cwd);
    const client = new PmClient({ pmRoot: join(cwd, "tracker"), cwd, noExtensions: true });
    await client.init(name);
    await client.create({ title: name });
  }
  return root;
}

/** A synthetic remote issue whose fields exercise the normal mapping path. */
function issue(): JiraIssue {
  return { key: "ONE-1", fields: { summary: "Bound target", status: { name: "To Do", statusCategory: { key: "new" } } } };
}

test("complete reads bind relative roots before their first asynchronous boundary", async t => {
  const root = await trackers();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = process.cwd();
  try {
    process.chdir(join(root, "first"));
    const reading = readPmItems("tracker");
    process.chdir(join(root, "second"));
    assert.equal((await reading)[0]!.title, "first");
  } finally { process.chdir(cwd); }
});

for (const atomic of [false, true]) test(`imports keep reads, settings and writes on the bound root (atomic=${atomic})`, async t => {
  const root = await trackers();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = process.cwd();
  try {
    process.chdir(join(root, "first"));
    const importing = runImport({ project: "ONE", host: "https://example.invalid" }, "tracker",
      { atomic, issues: [issue()] });
    process.chdir(join(root, "second"));
    const result = await importing;
    assert.ok("imported" in result);
    assert.equal(result.imported, 1);
    const first = await readPmItems(join(root, "first", "tracker"));
    assert.equal(first.length, 2);
    assert.match(first.find(row => row.title?.includes("Bound target"))!.id!, /^first-/);
    assert.equal((await readPmItems(join(root, "second", "tracker"))).length, 1);
  } finally { process.chdir(cwd); }
});


test("reusable bindings are immutable and separate processes preserve shared tracker writes", { timeout: 60000 }, async t => {
  const root = await trackers();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = bindJiraPersistence(join(root, "first", "tracker"));
  assert.equal(bindJiraPersistence(target), target);
  assert.ok(Object.isFrozen(target));
  assert.ok(Object.isFrozen(target.capabilities));
  assert.deepEqual(target.capabilities, { backend: "filesystem", completeRead: "certified-corpus",
    batchWrite: "recoverable-compensation" });
  const children = [10, 11].map(key => fork(fileURLToPath(new URL("./fixtures/persistence-worker.ts", import.meta.url)),
    [join(root, "second"), String(key)], { cwd: join(root, "first"),
      env: { PATH: process.env.PATH, PM_AUTHOR: "jira-fixture" }, silent: true }));
  const exits = children.map(child => once(child, "exit"));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  for (const [message] of await Promise.all(children.map(child => once(child, "message")))) assert.equal(message, "ready");
  const results = children.map(child => once(child, "message"));
  for (const child of children) child.send("start");
  for (const [result] of await Promise.all(results)) assert.equal(result.imported, 1, JSON.stringify(result));
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  const rows = await readPmItems(target);
  assert.equal(rows.length, 3);
  assert.equal((await readPmItems(join(root, "second", "tracker"))).length, 1);
  for (const row of rows.filter(row => row.title?.includes("Concurrent"))) {
    assert.match(row.id!, /^first-/);
    assert.equal(row.status, "in_progress");
    assert.equal(row.body, "Preserved body");
    const history = await readHistoryEntries(getHistoryPath(target.pmRoot, row.id!), row.id!);
    assert.ok(history.length > 0);
    assert.equal(verifyHistoryEntries(history).ok, true);
  }
});
