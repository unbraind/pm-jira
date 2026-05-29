import assert from "node:assert/strict";
import test from "node:test";

import extension, { optionString, optionEnabled, optionInt } from "../dist/index.js";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one capability", () => {
  const registered: string[] = [];
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerHook: () => { registered.push("hook"); },
    registerImporter: () => { registered.push("importer"); },
    registerSchema: () => { registered.push("schema"); },
    registerRenderer: () => { registered.push("renderer"); },
    registerSearchProvider: () => { registered.push("search"); },
    registerPreflight: () => { registered.push("preflight"); },
    registerService: () => { registered.push("service"); },
  };
  extension.activate(api as any);
  assert.ok(registered.length > 0, `extension should register at least one capability, got: ${JSON.stringify(registered)}`);
});

test("optionEnabled honors kebab and camelCase keys", () => {
  assert.strictEqual(optionEnabled({ dryRun: true }, "dry-run", "dryRun"), true);
  assert.strictEqual(optionEnabled({ "dry-run": true }, "dry-run", "dryRun"), true);
  assert.strictEqual(optionEnabled({ "dry-run": "true" }, "dry-run", "dryRun"), true);
  assert.strictEqual(optionEnabled({}, "dry-run", "dryRun"), false);
});

test("optionInt reads camelCase key and coerces string values", () => {
  assert.strictEqual(optionInt({ maxResults: "200" }, 500, "max-results", "maxResults"), 200);
  assert.strictEqual(optionInt({ "max-results": "200" }, 500, "max-results", "maxResults"), 200);
  assert.strictEqual(optionInt({}, 500, "max-results", "maxResults"), 500);
  assert.strictEqual(optionInt({ maxResults: "nope" }, 500, "max-results", "maxResults"), 500);
});

test("optionString trims and ignores empty values", () => {
  assert.strictEqual(optionString({ project: "  PROJ " }, "project"), "PROJ");
  assert.strictEqual(optionString({ project: "   " }, "project"), undefined);
  assert.strictEqual(optionString({}, "project"), undefined);
});

function captureSyncCommand() {
  let cmd: { run: (ctx: any) => unknown } | undefined;
  const api = {
    registerCommand: (def: any) => { if (def?.name === "jira sync") cmd = def; },
    registerHook: () => {}, registerImporter: () => {}, registerSchema: () => {},
    registerRenderer: () => {}, registerSearchProvider: () => {},
    registerPreflight: () => {}, registerService: () => {},
  };
  extension.activate(api as any);
  return cmd!;
}

test("jira sync throws (non-zero exit) when credentials are missing", async () => {
  const prev = {
    url: process.env.JIRA_BASE_URL, token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL,
  };
  try {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_EMAIL;
    const cmd = captureSyncCommand();
    await assert.rejects(
      async () => cmd.run({ args: [], options: { project: "PROJ" }, pm_root: ".agents/pm" }),
      /JIRA_BASE_URL/,
    );
  } finally {
    if (prev.url) process.env.JIRA_BASE_URL = prev.url;
    if (prev.token) process.env.JIRA_API_TOKEN = prev.token;
    if (prev.email) process.env.JIRA_EMAIL = prev.email;
  }
});

test("jira sync throws when neither --project nor --jql is given", async () => {
  const prev = {
    url: process.env.JIRA_BASE_URL, token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL,
  };
  try {
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_API_TOKEN = "x";
    process.env.JIRA_EMAIL = "a@b.c";
    const cmd = captureSyncCommand();
    await assert.rejects(
      async () => cmd.run({ args: [], options: {}, pm_root: ".agents/pm" }),
      /--project|--jql/,
    );
  } finally {
    if (prev.url) process.env.JIRA_BASE_URL = prev.url; else delete process.env.JIRA_BASE_URL;
    if (prev.token) process.env.JIRA_API_TOKEN = prev.token; else delete process.env.JIRA_API_TOKEN;
    if (prev.email) process.env.JIRA_EMAIL = prev.email; else delete process.env.JIRA_EMAIL;
  }
});
