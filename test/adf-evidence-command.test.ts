/** Installed command readback and non-git guarantees use the actual host SDK and renderer. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PmClient, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { replayAdfEvidence } from "../index.ts";
import { runAdfCapture } from "../adf-evidence-command.ts";

test("CLI adapter refuses before reads/writes; host recognizes semantic refusals", async t => {
  const root = mkdtempSync(join(tmpdir(), "adf-adapter-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(runAdfCapture({}, root).kind, "refused");
  assert.throws(() => runAdfCapture({ contract: " " }, root), /nonblank/);
  for (const contract of ["missing", "."]) { const result = runAdfCapture({ contract }, root); assert.equal(result.kind, "refused"); if (result.kind === "refused") assert.equal(result.code, "input_read"); }
  const good = JSON.parse(readFileSync(resolve("docs/examples/adf-capture.json"), "utf8"));
  writeFileSync(join(root, "good.json"), JSON.stringify(good));
  assert.equal(runAdfCapture({ contract: "good.json" }, root).kind, "preview");
  const harness = await createExtensionTestHarness(extension, { name: "pm-jira", capabilities: ["commands", "schema", "importers", "hooks", "preflight"] });
  harness.assertCommandContract({ command: "jira capture-adf", flags: ["--contract"] });
  const result = await harness.runCommand({ command: "jira capture-adf", pmRoot: root, options: {} });
  assert.equal(result.exitCode, 2); assert.equal(result.errorCode, "invalid_input");
});

test("installed JSON/TOON capture works without git, preserving native fields, custom status roles and relationships", async t => {
  const root = mkdtempSync(join(tmpdir(), "adf-no-git-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const childEnv = { ...process.env, HOME: join(root, "home"), PM_AUTHOR: "adf-fixture", GIT_CEILING_DIRECTORIES: dirname(root) };
  for (const key of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_MEDIA_SERVER"]) delete (childEnv as Record<string, string | undefined>)[key];
  execFileSync(process.execPath, [cli, "--path", root, "init", "fixture"], { env: childEnv, stdio: "pipe" });
  const pkg = join(root, "package"); mkdirSync(pkg); cpSync(resolve("dist"), join(pkg, "dist"), { recursive: true }); cpSync(resolve("manifest.json"), join(pkg, "manifest.json"));
  execFileSync(process.execPath, [cli, "--path", root, "package", "install", pkg, "--project"], { env: childEnv, stdio: "pipe" });
  const client = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "adf-fixture" });
  await client.schemaAddStatus("investigating_custom", { role: ["active"] });
  const parent = await client.create({ title: "Parent", type: "Epic", status: "open", parent: "none", goal: "none", objective: "none", sprint: "none", release: "none" });
  await client.create({ title: "Child", type: "Task", status: "investigating_custom", body: " independent\r\nnotes ", parent: parent.item.id, dep: [`id=${parent.item.id},kind=related`], goal: "none", objective: "none", sprint: "none", release: "none" });
  const before = await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true });
  const contract = JSON.parse(readFileSync(resolve("docs/examples/adf-capture.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(root, "capture.json"), JSON.stringify(contract));
  const empty = join(root, "empty-bin"); mkdirSync(empty);
  const run = (json: boolean) => spawnSync(process.execPath, [cli, "--path", root, "jira", "capture-adf", "--contract", "capture.json", ...(json ? ["--json"] : [])], { cwd: root, env: { ...childEnv, PATH: empty }, encoding: "utf8" });
  const preview = run(true); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const parsed = JSON.parse(preview.stdout) as { kind: string; packet: { source: { revision: string; digest: string } } };
  assert.equal(parsed.kind, "preview");
  contract.approval = { revision: parsed.packet.source.revision, digest: parsed.packet.source.digest };
  writeFileSync(join(root, "capture.json"), JSON.stringify(contract));
  for (const json of [true, false]) {
    const result = run(json); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 8192); assert.match(result.stdout, /captured/);
    assert.ok(!result.stdout.includes("Not selected")); assert.ok(!result.stdout.includes("excluded"));
    if (json) assert.equal(replayAdfEvidence((JSON.parse(result.stdout) as { packet: unknown }).packet).kind, "replayed");
  }
  (contract.source as Record<string, unknown>).revision = "new-revision";
  writeFileSync(join(root, "capture.json"), JSON.stringify(contract));
  const refused = run(true); assert.equal(refused.status, 2, refused.stdout + refused.stderr); assert.match(refused.stdout, /source_changed/);
  assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })).items, before.items);
});
