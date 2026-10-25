/** Real command rendering and immutable no-git SDK state verification. */
import assert from "node:assert/strict";
import test from "node:test";
import fs, { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PmClient, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { readCreateContract, runCreatePreview } from "../create-preview-command.ts";

/** Minimal metadata remains explicit even for an empty answer set. */
function input() { return { metadata: { version: 1, revision: "r1", project: "DEMO", issueType: "Task", fields: [
  { id: "customfield_1", name: "Team", required: true, type: "option", allowedValues: [{ id: "1" }] },
] }, project: "DEMO", issueType: "Task", answers: {} }; }

test("bounded file adapter rejects missing, invalid, nonregular and oversized input", t => {
  const root = mkdtempSync(join(tmpdir(), "create-files-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const contract of [undefined, "", " ", false]) assert.equal(runCreatePreview({ contract }, root).kind, "refused");
  for (const file of ["missing", "."]) assert.equal(runCreatePreview({ contract: file }, root).kind, "refused");
  writeFileSync(join(root, "bad"), "{"); assert.equal(runCreatePreview({ contract: "bad" }, root).kind, "refused");
  writeFileSync(join(root, "big"), Buffer.alloc(1024 * 1024 + 1, 32)); assert.equal(runCreatePreview({ contract: "big" }, root).kind, "refused");
  writeFileSync(join(root, "good"), JSON.stringify(input())); assert.equal(runCreatePreview({ contract: "good" }, root).kind, "incomplete");
  t.mock.method(fs, "readSync", () => { throw new Error("synthetic disk fault"); }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal("kind" in readCreateContract(join(root, "good")), true);
});

test("registered SDK command uses semantic refusals", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  ext.assertCommandContract({ command: "jira preview-create", flags: ["--contract"] });
  const result = await ext.runCommand({ command: "jira preview-create", pmRoot: ".", options: {} });
  assert.equal(result.exitCode, 2); assert.equal(result.errorCode, "invalid_input");
});

test("installed CLI produces JSON/TOON in a non-git tracker with no git executable", async t => {
  const root = mkdtempSync(join(tmpdir(), "create-no-git-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root), PM_AUTHOR: "create-fixture", HOME: join(root, "home") };
  execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], { env, stdio: "pipe" });
  const pkg = join(root, "package"); mkdirSync(pkg); cpSync(resolve("dist"), join(pkg, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(pkg, "manifest.json"));
  execFileSync(process.execPath, [cli, "--path", root, "package", "install", pkg, "--project"], { env, stdio: "pipe" });
  const client = new PmClient({ pmRoot: root, cwd: root, author: "create-fixture", noExtensions: true });
  const parent = await client.create({ title: "Parent", type: "Epic", status: "open" });
  await client.create({ title: "Child", type: "Task", status: "open", parent: parent.item.id, body: "  Independent\r\nnotes  " });
  const before = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true });
  const bin = join(root, "empty-bin"); mkdirSync(bin);
  for (const json of [true, false]) for (const ready of [true, false]) {
    const fixture = input(); if (ready) Object.assign(fixture.answers, { customfield_1: { id: "1" } });
    writeFileSync(join(root, "create.json"), JSON.stringify(fixture));
    const result = spawnSync(process.execPath, [cli, "--path", root, "jira", "preview-create", "--contract", "create.json", ...(json ? ["--json"] : [])], { cwd: root, env: { ...env, PATH: bin }, encoding: "utf8" });
    assert.equal(result.status, ready ? 0 : 2, result.stdout + result.stderr);
    assert.match(result.stdout, ready ? /ready/ : /incomplete/);
    if (json) assert.equal((JSON.parse(result.stdout) as { posts: number }).posts, 0);
  }
  const large = input();
  large.metadata.fields[0]!.allowedValues = Array.from({ length: 128 }, (_, index) => ({ id: `${index}-${"x".repeat(60)}` }));
  writeFileSync(join(root, "create.json"), JSON.stringify({ ...large, budget: 4096 }));
  for (const format of ["json", "toon"]) {
    const result = spawnSync(process.execPath, [cli, "--path", root, "jira", "preview-create", "--contract", "create.json", ...(format === "json" ? ["--json"] : [])], { cwd: root, env: { ...env, PATH: bin }, encoding: "utf8" });
    assert.equal(result.status, 2, result.stdout + result.stderr); assert.ok(Buffer.byteLength(result.stdout) <= 4096);
    if (format === "json") assert.ok((JSON.parse(result.stdout) as { page: { nextOffset: number } }).page.nextOffset > 0);
    else assert.match(result.stdout, /nextOffset/);
  }
  assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items, before.items);
});

test("registered export push reads the contract and refuses before any HTTP request", async t => {
  const root = mkdtempSync(join(tmpdir(), "create-export-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], { stdio: "pipe" });
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true });
  await client.create({ title: "Unanswered required team", type: "Task", status: "open" });
  const ext = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  const previous = { JIRA_EMAIL: process.env.JIRA_EMAIL, JIRA_API_TOKEN: process.env.JIRA_API_TOKEN };
  process.env.JIRA_EMAIL = "fixture@example.invalid"; process.env.JIRA_API_TOKEN = "synthetic";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const contractFile = join(root, "create.json"); writeFileSync(contractFile, JSON.stringify(input()));
  for (const file of [join(root, "missing"), contractFile]) {
    await assert.rejects(ext.runExporter({ exporter: "jira", pmRoot: root, options: { push: true, host: "https://example.invalid", project: "DEMO", "create-contract": file } }), /regular JSON|missing or invalid/);
  }
});
