/** SDK adoption behavior against real stores, with no SDK substitutes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  getHistoryPath, isPmCliExpectedError, listAllComplete, listMutationEvents,
  readHistoryEntries, verifyHistoryEntries,
} from "@unbrained/pm-cli/sdk";
import { createCommandError, parseFieldMap, readPmItems, runImport, type JiraIssue } from "../index.ts";

/** Initialize a disposable tracker outside any git repository. */
async function tracker(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jira-sdk-"));
  execFileSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
    "--path", root, "init", "fixture"], { stdio: "pipe" });
  return root;
}

/** Include the fields previously passed as CLI arguments. */
function issue(key: string, deadline?: string): JiraIssue {
  return { key, fields: { summary: "SDK create fixture", description: { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Retained body" }] },
  ] }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
  priority: { name: "High" }, labels: ["sdk", "fixture"], duedate: deadline } };
}

test("ordinary imports work with neither pm nor git on PATH and preserve every create field", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
  Object.assign(process.env, { PATH: root, GIT_CEILING_DIRECTORIES: tmpdir() });
  try {
    const result = await runImport({ project: "ONE", host: "https://example.invalid" }, root,
      { issues: [issue("ONE-1", "2026-12-01")] });
    assert.ok("imported" in result);
    assert.equal(result.imported, 1);
    const [row] = await readPmItems(root);
    assert.equal(row!.title, "[ONE-1] SDK create fixture");
    assert.equal(row!.status, "in_progress");
    assert.equal(row!.priority, 2);
    assert.deepEqual(row!.tags, ["fixture", "sdk"]);
    assert.equal(row!.body, "Retained body");
    assert.match(row!.description!, /Jira ONE-1: https:\/\/example.invalid\/browse\/ONE-1/);
    const full = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true });
    assert.equal(full.items[0]!.deadline, "2026-12-01T00:00:00.000Z");
    const history = await readHistoryEntries(getHistoryPath(root, row!.id!), row!.id!);
    assert.equal(history.length, 1, "one local commit contains every imported field");
    assert.equal(verifyHistoryEntries(history).ok, true);
    const repeated = await runImport({ project: "ONE", host: "https://example.invalid" }, root,
      { issues: [issue("ONE-1", "2026-12-01")] });
    assert.ok("imported" in repeated);
    assert.equal(repeated.imported, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("ordinary imports retain partial success when a real SDK create refuses an invalid deadline", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runImport({ project: "ONE", host: "https://example.invalid" }, root,
    { issues: [issue("ONE-1", "not-a-date"), issue("ONE-2")] });
  assert.ok("imported" in result);
  assert.equal(result.imported, 1);
  assert.equal((await readPmItems(root))[0]!.title, "[ONE-2] SDK create fixture");
});

test("SDK-created history still detects corruption after priming the SDK event cache", async t => {
  const root = await tracker();
  t.after(() => rm(root, { recursive: true, force: true }));
  await runImport({ project: "ONE", host: "https://example.invalid" }, root, { issues: [issue("ONE-1")] });
  const [row] = await readPmItems(root);
  const historyPath = getHistoryPath(root, row!.id!);
  const primed = await listMutationEvents({ pmRoot: root, cwd: root, item: row!.id!, full: true });
  assert.equal(primed.count, 1);
  assert.equal(verifyHistoryEntries(await readHistoryEntries(historyPath, row!.id!)).ok, true);
  const original = await readFile(historyPath, "utf8");
  await writeFile(historyPath, original.replace("SDK create fixture", "Bad create fixture"));
  const verification = verifyHistoryEntries(await readHistoryEntries(historyPath, row!.id!));
  assert.equal(verification.ok, false, "authoritative history verification must not use cached events");
  assert.ok(verification.errors.length > 0);
});

test("expected failures use the SDK public contract, preserving messages and selected exit codes", () => {
  for (const code of [1, 2, 3]) {
    const error = createCommandError("Sanitized provider diagnostic", code);
    assert.ok(isPmCliExpectedError(error));
    assert.equal(error.name, "PmCliError");
    assert.equal(error.exitCode, code);
    assert.equal(error.message, "Sanitized provider diagnostic");
  }
  assert.equal(createCommandError("Default").exitCode, 1);
  assert.throws(() => parseFieldMap("invalid"), error => {
    assert.ok(isPmCliExpectedError(error));
    assert.equal(error.exitCode, 2);
    return true;
  });
});
