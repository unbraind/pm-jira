/** Verify one immutable npm artifact through six real host installation/launcher modes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "adf-packed-"));
const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull, NPM_CONFIG_CACHE: join(root, "npm-cache"), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: tmpdir(), PM_AUTHOR: "packed-fixture" };
for (const key of Object.keys(childEnv)) if (/token|secret|password|credential|auth|NPM_MEDIA_SERVER|^JIRA_/i.test(key)) delete childEnv[key];
/** Run credential-free package/host commands without exposing successful installer chatter. */
function run(command: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(command, args, { cwd, env: { ...childEnv, ...extra }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}\n${result.stdout}`); return result.stdout;
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], process.cwd())) as { filename: string; files: { path: string }[] }[];
  const artifact = join(root, packed[0]!.filename); const artifactHash = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  for (const file of ["dist/adf-evidence.js", "dist/adf-evidence.d.ts", "docs/adf-evidence.md", "docs/examples/adf-capture.json"]) assert.ok(packed[0]!.files.some(entry => entry.path === file), file);
  const extracted = join(root, "artifact"); mkdirSync(extracted); run("tar", ["-xzf", artifact, "-C", extracted], root);
  let passed = 0;
  for (const mode of ["npm-global", "bun-global", "npx", "bunx", "npm-local", "bun-local"]) {
    const cwd = join(root, mode); mkdirSync(cwd);
    const prefix = join(cwd, "prefix"); let command = ""; let leading: string[] = []; let packageRoot = join(extracted, "package");
    const extra = { BUN_INSTALL_GLOBAL_DIR: join(prefix, "global"), BUN_INSTALL_BIN: join(prefix, "bin"), BUN_INSTALL_CACHE_DIR: join(root, "bun-cache") };
    if (mode === "npm-global") { run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.28", artifact], cwd); command = join(prefix, "bin", "pm"); packageRoot = join(prefix, "lib", "node_modules", "pm-jira"); }
    if (mode === "bun-global") { run("bun", ["add", "--global", "--ignore-scripts", "@unbrained/pm-cli@2026.10.28", artifact], cwd, extra); command = join(prefix, "bin", "pm"); packageRoot = join(prefix, "global", "node_modules", "pm-jira"); }
    if (mode === "npx") { command = "npx"; leading = ["--yes", "--package", "@unbrained/pm-cli@2026.10.28", "--package", artifact, "pm"]; }
    if (mode === "bunx") { command = "bunx"; leading = ["--package", "@unbrained/pm-cli@2026.10.28", "pm"]; }
    if (mode.endsWith("-local")) {
      writeFileSync(join(cwd, "package.json"), '{"private":true,"type":"module"}\n');
      run(mode.startsWith("npm") ? "npm" : "bun", mode.startsWith("npm") ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.28", artifact] : ["add", "--ignore-scripts", "@unbrained/pm-cli@2026.10.28", artifact], cwd, extra);
      command = join(cwd, "node_modules", ".bin", "pm"); packageRoot = join(cwd, "node_modules", "pm-jira");
    }
    const invoke = (args: string[]) => run(command, [...leading, "--path", join(cwd, "tracker"), ...args], cwd, extra);
    invoke(["init", "fixture"]); invoke(["package", "install", packageRoot, "--project"]);
    cpSync(resolve("docs/examples/adf-capture.json"), join(cwd, "capture.json"));
    const preview = JSON.parse(invoke(["jira", "capture-adf", "--contract", "capture.json", "--json"])) as { kind: string; packet: { source: { revision: string; digest: string } } };
    assert.equal(preview.kind, "preview");
    const contract = JSON.parse(readFileSync(join(cwd, "capture.json"), "utf8")) as Record<string, unknown>;
    contract.approval = { revision: preview.packet.source.revision, digest: preview.packet.source.digest }; writeFileSync(join(cwd, "capture.json"), JSON.stringify(contract));
    const captured = JSON.parse(invoke(["jira", "capture-adf", "--contract", "capture.json", "--json"])) as { kind: string; packet: unknown };
    assert.equal(captured.kind, "captured"); assert.deepEqual(captured.packet, preview.packet);
    assert.match(invoke(["jira", "capture-adf", "--contract", "capture.json"]), /captured/);
    passed++;
    console.log(JSON.stringify({ mode, passed: true }));
  }
  assert.equal(createHash("sha256").update(readFileSync(artifact)).digest("hex"), artifactHash);
  console.log(JSON.stringify({ artifact: packed[0]!.filename, sha256: artifactHash, files: packed[0]!.files.length, modes: passed, assertions: passed * 4, host: "2026.10.28" }));
} finally { rmSync(root, { recursive: true, force: true }); }
