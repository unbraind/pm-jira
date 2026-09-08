/**
 * Runtime coverage for HTTP, spawn, command, importer, exporter, and atomic
 * resolution paths that the pure suite cannot reach.
 *
 * Global mocks (https.request, process.exit, PATH, env, SDK importer) live
 * under a concurrency-1 describe so they cannot interleave with each other.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { IncomingMessage, RequestOptions } from "node:http";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { OnWriteHookContext, PreflightOverrideContext } from "@unbrained/pm-cli/sdk/authoring";

import extension, {
  CommandError,
  EXIT_CODE,
  buildExportPlan,
  importJiraAtomic,
  issueToItem,
  jiraProvenance,
  resolveCommitItemMutations,
  runExportPush,
  runImport,
  setPmSdkImporter,
} from "../index.ts";
import type { ExportPlan, JiraIssue } from "../index.ts";
import type { CommitItemMutationsResult } from "@unbrained/pm-cli/sdk";

function commitResult(
  overrides: Partial<CommitItemMutationsResult> = {},
): CommitItemMutationsResult {
  return {
    transactionId: "jira-import-test",
    status: "committed",
    recovered: false,
    results: {},
    ...overrides,
  };
}

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32" };

function fakeIssue(key: string, summary: string, statusName = "To Do"): JiraIssue {
  return {
    key,
    fields: {
      summary,
      description: null,
      status: { name: statusName, statusCategory: { key: statusName === "Done" ? "done" : "new" } },
      priority: { name: "Medium" },
      labels: ["backend"],
      components: [],
      assignee: null,
      duedate: null,
      fixVersions: [],
      issuetype: { name: "Task" },
      customfield_10020: null,
    },
  };
}

function issueJson(issue: JiraIssue): Record<string, unknown> {
  return issue as unknown as Record<string, unknown>;
}

function freshTracker(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-jira-cov-"));
  try {
    const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
    assert.equal(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
    return root;
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function itemCount(root: string): number {
  const listed = spawnSync(PM_BIN, ["--path", root, "list", "--json"], PM_SPAWN_OPTS);
  assert.equal(listed.status, 0, `pm list failed: ${listed.error?.message ?? listed.stderr}`);
  return JSON.parse(listed.stdout).items.length;
}

function withEnv(updates: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    prev[key] = process.env[key];
    const value = updates[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(prev)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

function withFakePm(source: string, fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pm-"));
  const bin = path.join(dir, process.platform === "win32" ? "pm.cmd" : "pm");
  fs.writeFileSync(bin, source);
  fs.chmodSync(bin, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prev ?? ""}`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

type MockHttpsResult = {
  statusCode?: number;
  body?: string;
  error?: Error;
  timeout?: boolean;
};

type MockHttpsHandler = (request: {
  method?: string;
  path?: string;
  payload: string;
}) => MockHttpsResult;

function installHttpsMock(handler: MockHttpsHandler): () => void {
  const original = https.request;
  https.request = ((options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
    const req = new EventEmitter();
    let payload = "";
    let timeoutCb: (() => void) | undefined;
    Object.assign(req, {
      setTimeout(_ms: number, cb?: () => void) {
        timeoutCb = cb;
        return req;
      },
      destroy() {
        req.emit("close");
      },
      write(chunk: string) {
        payload += chunk;
        return true;
      },
      end() {
        queueMicrotask(() => {
          const result = handler({
            method: typeof options.method === "string" ? options.method : undefined,
            path: typeof options.path === "string" ? options.path : undefined,
            payload,
          });
          if (result.timeout) {
            timeoutCb?.();
            return;
          }
          if (result.error) {
            req.emit("error", result.error);
            return;
          }
          const res = new EventEmitter() as IncomingMessage;
          res.statusCode = result.statusCode;
          callback?.(res);
          if (result.body) res.emit("data", Buffer.from(result.body));
          res.emit("end");
        });
      },
    });
    return req;
  }) as typeof https.request;
  return () => {
    https.request = original;
  };
}

const JIRA_ENV = {
  JIRA_BASE_URL: "https://example.atlassian.net",
  JIRA_EMAIL: "a@b.c",
  JIRA_API_TOKEN: "tok",
};

let harness: ExtensionTestHarness | undefined;

async function getHarness(): Promise<ExtensionTestHarness> {
  if (!harness) {
    harness = await createExtensionTestHarness(extension, {
      name: "pm-jira",
      capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
    });
    assert.deepEqual(harness.activation.failed, [], "activation must not fail");
  }
  return harness;
}

function preflightContext(command: string, options: Record<string, unknown> = {}): PreflightOverrideContext {
  return {
    command,
    args: [],
    options,
    global: { json: false, quiet: true, noPager: true },
    pm_root: "",
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  } as PreflightOverrideContext;
}

describe("runtime coverage (serial mocks)", { concurrency: 1 }, () => {
  test("resolveCommitItemMutations production import, cache hit, poison, and prior-failure", async () => {
    setPmSdkImporter();
    const first = await resolveCommitItemMutations();
    const second = await resolveCommitItemMutations();
    assert.equal(first, second);

    setPmSdkImporter(async () => {
      throw new Error("Cannot find module '@unbrained/pm-cli/sdk'");
    });
    await assert.rejects(
      () => resolveCommitItemMutations(),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /could not be imported/);
        return true;
      },
    );
    await assert.rejects(
      () => resolveCommitItemMutations(),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /prior attempt in this process failed/);
        return true;
      },
    );

    setPmSdkImporter(async () => {
      throw "not-an-error";
    });
    await assert.rejects(() => resolveCommitItemMutations(), /not-an-error/);

    setPmSdkImporter(async () => ({}));
    await assert.rejects(
      () => resolveCommitItemMutations(),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /does not export commitItemMutations as a function/);
        return true;
      },
    );
    await assert.rejects(() => resolveCommitItemMutations(), /prior attempt in this process failed/);
    setPmSdkImporter();
  });

  test("importJiraAtomic getSdk import failure and settings fallback", async () => {
    const root = freshTracker();
    try {
      setPmSdkImporter(async () => {
        throw "sdk-gone";
      });
      await assert.rejects(
        () =>
          runImport({ project: "PROJ" }, root, {
            atomic: true,
            issues: [fakeIssue("PROJ-1", "One")],
            commitItemMutations: async () => commitResult(),
          }),
        /sdk-gone/,
      );
      setPmSdkImporter(async () => {
        throw new Error("sdk missing as Error");
      });
      await assert.rejects(
        () =>
          runImport({ project: "PROJ" }, root, {
            atomic: true,
            issues: [fakeIssue("PROJ-1b", "OneB")],
            commitItemMutations: async () => commitResult(),
          }),
        /sdk missing as Error/,
      );
      setPmSdkImporter();

      const res = (await runImport({ project: "PROJ" }, root, {
        atomic: true,
        issues: [fakeIssue("PROJ-2", "Two")],
        commitItemMutations: async () => commitResult({ results: { a: {} as never } }),
        normalizeItemId: (input, prefix) => `${prefix}${input}`,
        readSettings: async () => {
          throw new Error("unreadable settings");
        },
      })) as { imported: number };
      assert.equal(res.imported, 1);

      const emptyPrefix = (await runImport({ project: "PROJ" }, root, {
        atomic: true,
        issues: [fakeIssue("PROJ-3", "Three")],
        commitItemMutations: async () => undefined as never,
        normalizeItemId: (input, prefix) => `${prefix}${input}`,
        readSettings: async () => ({}),
      })) as { imported: number };
      assert.equal(emptyPrefix.imported, 0);

      await assert.rejects(
        () =>
          runImport({ project: "PROJ" }, root, {
            atomic: true,
            issues: [fakeIssue("PROJ-4", "Four")],
            commitItemMutations: async () => {
              throw "commit-blew";
            },
            normalizeItemId: (input, prefix) => `${prefix}${input}`,
            readSettings: async () => ({ id_prefix: "test-" }),
          }),
        /commit-blew/,
      );
    } finally {
      setPmSdkImporter();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-atomic import creates items, notes extras, filters status, and reports a failed create", async () => {
    const root = freshTracker();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const extras = fakeIssue("PROJ-1", "Has extras");
      extras.fields.attachment = [{}, {}];
      extras.fields.comment = { total: 1 };
      const res = (await runImport(
        { project: "PROJ", status: "wip", host: "https://from-host.atlassian.net" },
        root,
        { issues: [extras, fakeIssue("PROJ-2", "Done one", "Done")] },
      )) as { imported: number; total: number; project: string };
      assert.equal(res.imported, 0);
      assert.equal(res.total, 0);
      assert.ok(errors.some((line) => /NOT imported/.test(line)));
      assert.ok(errors.some((line) => /Interpreting --status "wip"/.test(line)));
      assert.ok(errors.some((line) => /Filtered to 0 issues/.test(line)));

      const jiraStatusRoot = freshTracker();
      try {
        const jiraStatus = (await runImport(
          { jql: "key = PROJ-9", status: "Code Review" },
          jiraStatusRoot,
          { issues: [fakeIssue("PROJ-9", "Review")] },
        )) as { project: string };
        assert.equal(jiraStatus.project, "custom-jql");
        assert.ok(errors.some((line) => /Using Jira status "Code Review"/.test(line)));
      } finally {
        fs.rmSync(jiraStatusRoot, { recursive: true, force: true });
      }

      const rich = fakeIssue("PROJ-10", "Doing", "In Progress");
      rich.fields.description = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "body text" }] }],
      };
      rich.fields.duedate = "2026-12-01";
      const bare = fakeIssue("PROJ-12", "Bare");
      bare.fields.labels = [];
      const created = (await runImport({ project: "PROJ", status: "in_progress" }, root, {
        issues: [rich],
      })) as { imported: number };
      assert.equal(created.imported, 1);
      const createdBare = (await runImport({ project: "PROJ" }, root, {
        issues: [bare],
      })) as { imported: number };
      assert.equal(createdBare.imported, 1);
      assert.equal(itemCount(root), 2);

      const dead = fs.mkdtempSync(path.join(os.tmpdir(), "pm-jira-not-a-tracker-"));
      try {
        const failed = (await runImport({ project: "PROJ" }, dead, {
          issues: [fakeIssue("PROJ-11", "Will fail")],
        })) as { imported: number };
        assert.equal(failed.imported, 0);
        assert.ok(errors.some((line) => /Failed to create item for PROJ-11/.test(line)));
      } finally {
        fs.rmSync(dead, { recursive: true, force: true });
      }
    } finally {
      console.error = origError;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run import reports status filters and uses env/host base URLs", async () => {
    await withEnv({ JIRA_BASE_URL: "https://from-env.atlassian.net" }, async () => {
      const withStatus = (await runImport(
        { project: "PROJ", "dry-run": true, status: "todo" },
        ".",
      )) as { pmStatusFilter?: string; statusFilter?: string };
      assert.equal(withStatus.pmStatusFilter, "open");
      assert.equal(withStatus.statusFilter, "todo");

      const jiraFilter = (await runImport(
        { project: "PROJ", "dry-run": true, status: "QA Review" },
        ".",
      )) as { statusFilterMode?: string; pmStatusFilter?: string };
      assert.equal(jiraFilter.statusFilterMode, "jira");
      assert.equal(jiraFilter.pmStatusFilter, undefined);

      const fromHost = (await runImport(
        { project: "PROJ", "dry-run": true, host: "https://from-opt.atlassian.net/" },
        ".",
      )) as { request: { url: string } };
      assert.match(fromHost.request.url, /from-opt\.atlassian\.net/);
    });
  });

  test("live fetch covers pagination, empty pages, 401/404/timeout/network errors", async () => {
    const pages: MockHttpsResult[] = [
      {
        statusCode: 200,
        body: JSON.stringify({
          total: 2,
          issues: [issueJson(fakeIssue("PROJ-1", "One"))],
        }),
      },
      {
        statusCode: 200,
        body: JSON.stringify({
          total: 2,
          issues: [issueJson(fakeIssue("PROJ-2", "Two"))],
        }),
      },
    ];
    let restore = installHttpsMock(() => pages.shift() ?? { statusCode: 200, body: JSON.stringify({ total: 2, issues: [] }) });
    await withEnv(JIRA_ENV, async () => {
      const root = freshTracker();
      try {
        const res = (await runImport({ project: "PROJ", "max-results": 2 }, root)) as { imported: number };
        assert.equal(res.imported, 2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    restore();

    restore = installHttpsMock(() => ({ statusCode: 200, body: JSON.stringify({ total: 0, issues: [] }) }));
    await withEnv(JIRA_ENV, async () => {
      const root = freshTracker();
      try {
        const res = (await runImport({ project: "PROJ" }, root)) as { imported: number };
        assert.equal(res.imported, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    restore();

    restore = installHttpsMock(() => ({ statusCode: 401, body: "nope" }));
    await withEnv(JIRA_ENV, async () => {
      await assert.rejects(
        () => runImport({ project: "PROJ" }, "."),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.equal(err.exitCode, EXIT_CODE.USAGE);
          assert.match(err.message, /authentication failed/);
          return true;
        },
      );
    });
    restore();

    restore = installHttpsMock(() => ({ statusCode: 404, body: "missing" }));
    await withEnv(JIRA_ENV, async () => {
      await assert.rejects(
        () => runImport({ project: "PROJ" }, "."),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.equal(err.exitCode, EXIT_CODE.NOT_FOUND);
          return true;
        },
      );
    });
    restore();

    restore = installHttpsMock(() => ({ timeout: true }));
    await withEnv(JIRA_ENV, async () => {
      await assert.rejects(
        () => runImport({ project: "PROJ" }, "."),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.equal(err.exitCode, EXIT_CODE.GENERIC_FAILURE);
          assert.match(err.message, /timed out/);
          return true;
        },
      );
    });
    restore();

    restore = installHttpsMock(() => ({ error: new Error("ECONNREFUSED") }));
    await withEnv(JIRA_ENV, async () => {
      await assert.rejects(
        () => runImport({ project: "PROJ" }, "."),
        /ECONNREFUSED/,
      );
    });
    restore();

    restore = installHttpsMock(() => ({ statusCode: undefined, body: JSON.stringify({ total: 0, issues: [] }) }));
    await withEnv(JIRA_ENV, async () => {
      const root = freshTracker();
      try {
        const res = (await runImport({ project: "PROJ" }, root)) as { imported: number };
        assert.equal(res.imported, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    restore();
  });

  test("runExportPush default HTTP layer posts, puts, times out, and isolates non-Error throws", async () => {
    const items = [
      { id: "new-1", title: "New" },
      {
        id: "old-1",
        title: "Old",
        description: jiraProvenance("PROJ-9", "https://example.atlassian.net/browse/PROJ-9"),
      },
    ];
    const plan = buildExportPlan(items, "https://example.atlassian.net", { projectKey: "PROJ" });
    const restore = installHttpsMock((request) => {
      if (request.method === "POST") return { statusCode: 201, body: '{"key":"PROJ-100"}' };
      if (request.method === "PUT") return { statusCode: 200, body: '{"updated":true}' };
      return { statusCode: 500, body: "nope" };
    });
    try {
      const happy = await runExportPush(plan, { authHeader: "Basic x", updateExisting: true });
      assert.equal(happy.created, 1);
      assert.equal(happy.updated, 1);

      const createdOnly = await runExportPush(plan, { authHeader: "Basic x", updateExisting: false });
      assert.equal(createdOnly.created, 1);
    } finally {
      restore();
    }

    const restorePut400 = installHttpsMock((request) => {
      if (request.method === "PUT") return { statusCode: 400, body: "cannot edit" };
      return { statusCode: 201, body: "{}" };
    });
    try {
      const putFailed = await runExportPush(plan, { authHeader: "Basic x", updateExisting: true });
      assert.equal(putFailed.updated, 0);
      assert.ok(putFailed.failures.some((failure) => failure.op === "update"));
    } finally {
      restorePut400();
    }

    const restoreTimeout = installHttpsMock(() => ({ timeout: true }));
    try {
      const timedOut = await runExportPush(plan, { authHeader: "Basic x", updateExisting: true });
      assert.equal(timedOut.failed, 2);
      assert.ok(timedOut.failures.every((failure) => /timed out/.test(failure.message)));
    } finally {
      restoreTimeout();
    }

    const restoreErr = installHttpsMock(() => ({ error: new Error("reset") }));
    try {
      const failed = await runExportPush(plan, { authHeader: "Basic x", updateExisting: true });
      assert.equal(failed.failed, 2);
    } finally {
      restoreErr();
    }

    const stringThrows = await runExportPush(plan, { authHeader: "Basic x", updateExisting: true }, {
      post: async () => {
        throw "create-string";
      },
      put: async () => {
        throw "update-string";
      },
    });
    assert.equal(stringThrows.failed, 2);
    assert.equal(stringThrows.failures[0]?.message, "create-string");
    assert.equal(stringThrows.failures[1]?.message, "update-string");

    const cap: string[] = [];
    const origError = console.error;
    console.error = (message: string) => {
      cap.push(message);
    };
    try {
      const malformed = {
        baseUrl: "https://example.atlassian.net",
        entries: [
          { op: "create", method: "POST", endpoint: "https://example.atlassian.net/rest/api/3/issue" },
          {
            op: "update",
            method: "PUT",
            endpoint: "https://example.atlassian.net/rest/api/3/issue/X-1",
            payload: { fields: undefined },
          },
        ],
      } as unknown as ExportPlan;
      const result = await runExportPush(
        malformed,
        { authHeader: "Basic x", updateExisting: true },
        {
          post: async () => {
            throw "create-string";
          },
          put: async () => {
            throw "update-string";
          },
        },
      );
      assert.equal(result.failed, 2);
      assert.match(result.failures[0]?.ref ?? "", /\/issue$/);
      assert.equal(result.failures[1]?.ref, "https://example.atlassian.net/rest/api/3/issue/X-1");
    } finally {
      console.error = origError;
    }
    assert.ok(cap.some((line) => /Failed to create/.test(line)));
  });

  test("jira-sync importer fetches, notes extras, and requires project or jql", async () => {
    const ext = await getHarness();
    await assert.rejects(
      () =>
        ext.runImporter({
          importer: "jira-sync",
          options: {
            JIRA_BASE_URL: JIRA_ENV.JIRA_BASE_URL,
            JIRA_EMAIL: JIRA_ENV.JIRA_EMAIL,
            JIRA_API_TOKEN: JIRA_ENV.JIRA_API_TOKEN,
          },
          pmRoot: ".",
        }),
      /options.project or options.jql/,
    );

    const extras = fakeIssue("PROJ-1", "Sync me");
    extras.fields.attachment = [{}];
    const restore = installHttpsMock(() => ({
      statusCode: 200,
      body: JSON.stringify({ total: 1, issues: [issueJson(extras)] }),
    }));
    const root = freshTracker();
    try {
      const { result } = await ext.runImporter({
        importer: "jira-sync",
        options: {
          ...JIRA_ENV,
          project: "PROJ",
        },
        pmRoot: root,
      });
      const imported = result as { imported: number; total: number };
      assert.equal(imported.imported, 1);
      assert.equal(imported.total, 1);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }

    const restorePlain = installHttpsMock(() => ({
      statusCode: 200,
      body: JSON.stringify({ total: 1, issues: [issueJson(fakeIssue("PROJ-2", "Plain"))] }),
    }));
    const plainRoot = freshTracker();
    try {
      await withEnv(JIRA_ENV, async () => {
        const { result } = await ext.runImporter({
          importer: "jira-sync",
          options: { project: "PROJ" },
          pmRoot: plainRoot,
        });
        assert.equal((result as { imported: number }).imported, 1);
      });
    } finally {
      restorePlain();
      fs.rmSync(plainRoot, { recursive: true, force: true });
    }
  });

  test("jira importer and sync command accept omitted options as empty objects", async () => {
    const ext = await getHarness();
    await assert.rejects(() => ext.runImporter({ importer: "jira", pmRoot: "." }), /--project|--jql/);
    await assert.rejects(() => ext.runCommand({ command: "jira sync", pmRoot: "." }), /--project|--jql/);
  });

  test("preflight override fail-fast exits USAGE and otherwise returns {}", async () => {
    const ext = await getHarness();
    const origExit = process.exit;
    const exits: number[] = [];
    process.exit = ((code?: number) => {
      exits.push(code ?? 0);
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;
    try {
      const override = ext.assertPreflightOverride();
      await withEnv(
        { JIRA_BASE_URL: undefined, JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined },
        async () => {
          assert.throws(
            () => override.run(preflightContext("jira sync")),
            /exit:2/,
          );
        },
      );
      assert.deepEqual(exits, [EXIT_CODE.USAGE]);

      const ok = override.run(preflightContext("jira sync", { dryRun: true }));
      assert.deepEqual(ok, {});

      const empty = override.run({
        ...preflightContext("jira validate"),
        command: undefined as unknown as string,
        options: undefined as unknown as Record<string, unknown>,
      });
      assert.deepEqual(empty, {});
    } finally {
      process.exit = origExit;
    }
  });

  test("jira validate prints a human summary and returns diagnostics in json mode", async () => {
    const ext = await getHarness();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await withEnv(
        { JIRA_BASE_URL: undefined, JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined },
        async () => {
          const { result } = await ext.runCommand({
            command: "jira validate",
            options: {},
            pmRoot: ".",
            global: { json: false },
          });
          const diag = result as { ready: boolean };
          assert.equal(diag.ready, false);
          assert.ok(errors.some((line) => /NOT READY/.test(line)));
          assert.ok(errors.some((line) => /missing:/.test(line)));
        },
      );
      errors.length = 0;
      await withEnv(JIRA_ENV, async () => {
        const { result } = await ext.runCommand({
          command: "jira validate",
          options: { host: "https://opt.atlassian.net" },
          pmRoot: ".",
          global: { json: true },
        });
        const diag = result as { ready: boolean; hostPreview?: string };
        assert.equal(diag.ready, true);
        assert.equal(diag.hostPreview, "opt.atlassian.net");
        assert.equal(errors.length, 0);

        errors.length = 0;
        await ext.runCommand({
          command: "jira validate",
          options: { host: "https://opt.atlassian.net" },
          pmRoot: ".",
          global: { json: false },
        });
        assert.ok(errors.some((line) => /READY/.test(line) && !/NOT READY/.test(line)));
        assert.ok(errors.some((line) => /host: opt\.atlassian\.net/.test(line)));
      });
    } finally {
      console.error = origError;
    }
  });

  test("export dry-run prints creates, updates, skips, and a remainder line", async () => {
    const ext = await getHarness();
    const items = [];
    for (let i = 0; i < 21; i++) {
      items.push({
        id: `item-${i}`,
        title: `Item ${i}`,
        description: i === 0 ? jiraProvenance("PROJ-1", "https://example.atlassian.net/browse/PROJ-1") : undefined,
      });
    }
    const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ items }))});\n`;
    await withFakePm(script, async () => {
      const errors: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        const { result } = await ext.runExporter({
          exporter: "jira",
          options: { "dry-run": true, project: "PROJ", "update-existing": true },
          pmRoot: "/tmp",
        });
        const dry = result as { dryRun: boolean; plan: { entries: unknown[] } };
        assert.equal(dry.dryRun, true);
        assert.ok(errors.some((line) => /Would issue/.test(line)));
        assert.ok(errors.some((line) => /UPDATE PUT/.test(line)));
        assert.ok(errors.some((line) => /CREATE POST/.test(line)));
        assert.ok(errors.some((line) => /and 1 more/.test(line)));

        errors.length = 0;
        await ext.runExporter({
          exporter: "jira",
          options: { "dry-run": true, project: "PROJ" },
          pmRoot: "/tmp",
        });
        assert.ok(errors.some((line) => /skip — pass --update-existing/.test(line) || /SKIP PUT/.test(line)));
      } finally {
        console.error = origError;
      }
    });
  });

  test("export --push requires project, isolates failures, skips existing, and throws when nothing lands", async () => {
    const ext = await getHarness();
    const items = [
      { id: "new-1", title: "Brand new" },
      {
        id: "old-1",
        title: "Has a key",
        description: jiraProvenance("PROJ-1", "https://example.atlassian.net/browse/PROJ-1"),
      },
    ];
    const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ items }))});\n`;
    await withFakePm(script, async () => {
      await withEnv(JIRA_ENV, async () => {
        await assert.rejects(
          () =>
            ext.runExporter({
              exporter: "jira",
              options: { push: true },
              pmRoot: "/tmp",
            }),
          /--push requires --project/,
        );

        const restore = installHttpsMock((request) => {
          if (request.method === "POST") return { statusCode: 201, body: '{"key":"PROJ-200"}' };
          return { statusCode: 204, body: "" };
        });
        try {
          const { result } = await ext.runExporter({
            exporter: "jira",
            options: { push: true, project: "PROJ" },
            pmRoot: "/tmp",
          });
          const pushed = result as { created: number; skipped: number; failed: number };
          assert.equal(pushed.created, 1);
          assert.equal(pushed.skipped, 1);
          assert.equal(pushed.failed, 0);

          const updated = await ext.runExporter({
            exporter: "jira",
            options: { push: true, project: "PROJ", "update-existing": true },
            pmRoot: "/tmp",
          });
          const upd = updated.result as { created: number; updated: number };
          assert.equal(upd.created, 1);
          assert.equal(upd.updated, 1);
        } finally {
          restore();
        }

        const restoreFail = installHttpsMock(() => ({ statusCode: 400, body: "bad" }));
        try {
          await assert.rejects(
            () =>
              ext.runExporter({
                exporter: "jira",
                options: { push: true, project: "PROJ" },
                pmRoot: "/tmp",
              }),
            /all 1 item\(s\) errored/,
          );
        } finally {
          restoreFail();
        }
      });
    });
  });

  test("export --push with mixed success reports failed count without throwing", async () => {
    const ext = await getHarness();
    const items = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ items }))});\n`;
    let posts = 0;
    const restore = installHttpsMock(() => {
      posts += 1;
      if (posts === 1) return { statusCode: 201, body: "{}" };
      return { statusCode: 400, body: "nope" };
    });
    await withFakePm(script, async () => {
      await withEnv(JIRA_ENV, async () => {
        const { result } = await ext.runExporter({
          exporter: "jira",
          options: { push: true, project: "PROJ" },
          pmRoot: "/tmp",
        });
        const mixed = result as { created: number; failed: number };
        assert.equal(mixed.created, 1);
        assert.equal(mixed.failed, 1);
      });
    });
    restore();
  });

  test("default export uses JIRA_BASE_URL when --host is absent", async () => {
    const ext = await getHarness();
    const script = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ items: [{ id: "a", title: "A" }] }))});\n`;
    await withFakePm(script, async () => {
      await withEnv({ JIRA_BASE_URL: "https://from-env.atlassian.net" }, async () => {
        const { result } = await ext.runExporter({
          exporter: "jira",
          options: {},
          pmRoot: "/tmp",
        });
        const exported = result as { plan: { endpoint: string }[] };
        assert.match(exported.plan[0]?.endpoint ?? "", /from-env\.atlassian\.net/);
      });
    });
  });

  test("readPmItems names ENOBUFS, other spawn errors, non-zero status, and parse envelopes", async () => {
    const ext = await getHarness();
    const root = freshTracker();
    try {
      const created = spawnSync(
        PM_BIN,
        ["--path", root, "create", "task", "Buffer bait", "--priority", "3"],
        { ...PM_SPAWN_OPTS, env: { ...process.env, PM_AUTHOR: "pm-jira-test" } },
      );
      assert.equal(created.status, 0, created.stderr);
      await withEnv({ PM_JSON_MAX_BUFFER: "10" }, async () => {
        await assert.rejects(
          () => ext.runExporter({ exporter: "jira", options: { project: "PROJ" }, pmRoot: root }),
          /PM_JSON_MAX_BUFFER/,
        );
      });
      await withEnv({ PM_JSON_MAX_BUFFER: "64MiB" }, async () => {
        const { result } = await ext.runExporter({
          exporter: "jira",
          options: { project: "PROJ" },
          pmRoot: root,
        });
        const exported = result as { exported: number };
        assert.equal(exported.exported, 1);
      });
      await withEnv({ PM_JSON_MAX_BUFFER: "0" }, async () => {
        const { result } = await ext.runExporter({
          exporter: "jira",
          options: { project: "PROJ" },
          pmRoot: root,
        });
        const exported = result as { exported: number };
        assert.equal(exported.exported, 1);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    await withFakePm("#!/usr/bin/env node\nprocess.exit(1);\n", async () => {
      await assert.rejects(
        () => ext.runExporter({ exporter: "jira", options: { project: "PROJ" }, pmRoot: "/tmp" }),
        /pm list failed/,
      );
    });
    await withFakePm("#!/usr/bin/env node\nprocess.stderr.write('listed badly');\nprocess.exit(2);\n", async () => {
      await assert.rejects(
        () => ext.runExporter({ exporter: "jira", options: { project: "PROJ" }, pmRoot: "/tmp" }),
        /listed badly/,
      );
    });
    await withFakePm("#!/usr/bin/env node\nprocess.stdout.write('not-json');\n", async () => {
      await assert.rejects(
        () => ext.runExporter({ exporter: "jira", options: { project: "PROJ" }, pmRoot: "/tmp" }),
        /Could not parse/,
      );
    });
    await withFakePm("#!/usr/bin/env node\nprocess.stdout.write('[]');\n", async () => {
      const { result } = await ext.runExporter({
        exporter: "jira",
        options: { project: "PROJ" },
        pmRoot: "/tmp",
      });
      assert.equal((result as { exported: number }).exported, 0);
    });
    await withFakePm("#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ results: [{ id: 'r', title: 'R' }] }));\n", async () => {
      const { result } = await ext.runExporter({
        exporter: "jira",
        options: { project: "PROJ" },
        pmRoot: "/tmp",
      });
      assert.equal((result as { exported: number }).exported, 1);
    });
    await withFakePm("#!/usr/bin/env node\nprocess.stdout.write('{}');\n", async () => {
      const { result } = await ext.runExporter({
        exporter: "jira",
        options: { project: "PROJ" },
        pmRoot: "/tmp",
      });
      assert.equal((result as { exported: number }).exported, 0);
    });

    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "no-pm-bin-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      await assert.rejects(
        () => ext.runExporter({ exporter: "jira", options: { project: "PROJ" }, pmRoot: "/tmp" }),
        /pm read failed/,
      );
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  test("onWrite hook no-ops through the registered callback", async () => {
    const ext = await getHarness();
    await ext.runHook({
      kind: "on_write",
      context: { path: ".", scope: "project", op: "create" } as OnWriteHookContext,
    });
    await withEnv({ ...JIRA_ENV, PM_JIRA_PUSH_ON_WRITE: "1" }, async () => {
      await ext.runHook({
        kind: "on_write",
        context: { path: ".", scope: "project", op: "update" } as OnWriteHookContext,
      });
    });
  });

  test("atomic recovered singular item wording and injected issues with env base URL", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const root = freshTracker();
      try {
        await withEnv({ JIRA_BASE_URL: "https://seam.atlassian.net" }, async () => {
          await runImport({ project: "PROJ" }, root, {
            atomic: true,
            issues: [fakeIssue("PROJ-1", "Only")],
            commitItemMutations: async () => commitResult({ results: { a: {} as never }, recovered: true }),
            normalizeItemId: (input, prefix) => `${prefix}${input}`,
            readSettings: async () => ({ id_prefix: "test-" }),
          });
        });
        assert.ok(errors.some((line) => /recovered 1 item\)/.test(line)));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    } finally {
      console.error = origError;
    }
  });

  test("importJiraAtomic can be called directly with injected helpers", async () => {
    const item = issueToItem(fakeIssue("Z-1", "Direct"), "https://example.atlassian.net");
    const result = await importJiraAtomic(
      ".",
      "project = Z",
      [{ issue: fakeIssue("Z-1", "Direct"), item }],
      {
        commitItemMutations: async () => commitResult({ results: { z: {} as never } }),
        normalizeItemId: (input, prefix) => `${prefix}${input}`,
        readSettings: async () => ({ id_prefix: "z-" }),
        atomicAuthor: "tester",
      },
    );
    assert.equal(result.created, 1);
    assert.equal(result.recovered, false);
  });
});
