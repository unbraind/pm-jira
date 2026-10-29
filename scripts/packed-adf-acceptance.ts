/** Verify one immutable npm artifact through six real host installation/launcher modes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { decodePmTableRows } from "@unbrained/pm-cli/sdk";
import type { PmEncodedTableRows, PmTableCellEncoding } from "@unbrained/pm-cli/sdk";
import type { AdfCaptureInput, AdfEvidencePacket } from "../adf-evidence.ts";

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
  // Raw extracted SDK consumers need the declared peer, just like installed consumers.
  run("npm", ["install", "--prefix", extracted, "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.28"], root);
  let passed = 0; let assertions = 0;
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
    cpSync(join(packageRoot, "docs/examples/adf-capture.json"), join(cwd, "capture.json"));
    const contract = JSON.parse(readFileSync(join(cwd, "capture.json"), "utf8")) as AdfCaptureInput;
    for (const select of [contract.select, ["/content/2"]]) {
      contract.select = select; delete contract.approval;
      writeFileSync(join(cwd, "capture.json"), JSON.stringify(contract));
      const preview = JSON.parse(invoke(["jira", "capture-adf", "--contract", "capture.json", "--json"])) as { kind: string; packet: AdfEvidencePacket };
      assert.equal(preview.kind, "preview"); assertions++;
      contract.approval = { revision: preview.packet.source.revision, digest: preview.packet.source.digest }; writeFileSync(join(cwd, "capture.json"), JSON.stringify(contract));
      const captured = JSON.parse(invoke(["jira", "capture-adf", "--contract", "capture.json", "--json"])) as { kind: string; packet: AdfEvidencePacket };
      assert.equal(captured.kind, "captured"); assertions++; assert.deepEqual(captured.packet, preview.packet); assertions++;
      const toon = decodeToon(invoke(["jira", "capture-adf", "--contract", "capture.json"])) as unknown as { kind: string; packet: AdfEvidencePacket & { nodes_encoding?: PmTableCellEncoding } };
      const { nodes_encoding: encoding, ...packet } = toon.packet;
      if (encoding) packet.nodes = decodePmTableRows({ rows: packet.nodes as unknown as PmEncodedTableRows["rows"], encoding }) as unknown as AdfEvidencePacket["nodes"];
      toon.packet = packet;
      assert.deepEqual(toon, captured); assertions++;
      assert.equal(captured.packet.nodes.find(row => row.type === "codeBlock")!.attrs!.language, null); assertions++;
      const cells = captured.packet.nodes.filter(row => ["tableCell", "tableHeader"].includes(row.type));
      assert.equal(cells.length, select.length === 1 ? 0 : 2); assertions++;
      for (const cell of cells) { assert.deepEqual([cell.attrs!.colwidth, cell.attrs!.background], [null, null]); assertions++; }
      assert.ok(!JSON.stringify(captured).includes("Not selected")); assertions++;
      const sdkConsumer = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {captureAdfEvidence,replayAdfEvidence} from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/index.js")).href)};
        const contract=JSON.parse(readFileSync('capture.json','utf8')); const captured=captureAdfEvidence(contract); assert.equal(captured.kind,'captured');
        const replay=replayAdfEvidence(JSON.parse(JSON.stringify(captured.packet))); assert.equal(replay.kind,'replayed');
        const code=replay.document.content.find(node=>node.type==='codeBlock'); assert.equal(code.attrs.language,null);
        for(const row of replay.document.content.filter(node=>node.type==='table').flatMap(node=>node.content).flatMap(node=>node.content)) {assert.equal(row.attrs.colwidth,null);assert.equal(row.attrs.background,null);}`;
      run(process.execPath, ["--input-type=module", "-e", sdkConsumer], cwd); assertions++;
    }
    passed++;
    console.log(JSON.stringify({ mode, passed: true }));
  }
  assert.equal(createHash("sha256").update(readFileSync(artifact)).digest("hex"), artifactHash);
  console.log(JSON.stringify({ artifact: packed[0]!.filename, sha256: artifactHash, files: packed[0]!.files.length, modes: passed, assertions, host: "2026.10.28" }));
} finally { rmSync(root, { recursive: true, force: true }); }
