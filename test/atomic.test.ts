import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runImport,
  deriveAtomicTransactionId,
  buildAtomicCreateMutation,
  resolveCommitItemMutations,
  CommandError,
  EXIT_CODE,
} from "../dist/index.js";
import type { JiraIssue } from "../dist/index.js";

// On Windows the runnable pm shim is `pm.cmd`; the extensionless `pm` name is
// not spawnable. Node also refuses to spawn `.cmd`/`.bat` directly since the
// CVE-2024-27980 mitigation (EINVAL), so on win32 we must go through a shell.
const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32" };

/** Resolve the real SDK helpers from the installed @unbrained/pm-cli (>=2026.7.20). */
async function realSdk() {
  const mod = await import("@unbrained/pm-cli/sdk");
  return {
    commitItemMutations: mod.commitItemMutations!,
    readSettings: mod.readSettings!,
    normalizeItemId: mod.normalizeItemId!,
  };
}

/** Build a minimal but well-formed JiraIssue fixture for the atomic tests. */
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
  } as unknown as JiraIssue;
}

/** Create a throwaway pm tracker at a temp path and return its .agents/pm root. */
function freshTracker(): string {
  // pm inits the tracker AT the given path directly (not <dir>/.agents/pm),
  // so the tracker root IS the temp dir. Using <dir>/.agents/pm would point at
  // an uninitialized path and pm would walk up to the nearest real tracker.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-jira-atomic-"));
  const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
  assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
  // Sanity: starts empty.
  const list = spawnSync(PM_BIN, ["--path", root, "list", "--json"], PM_SPAWN_OPTS);
  assert.strictEqual(list.status, 0, `pm list failed: ${list.error?.message ?? list.stderr}`);
  assert.strictEqual(JSON.parse(list.stdout).items.length, 0, "fresh tracker must be empty");
  return root;
}

function itemCount(root: string): number {
  const r = spawnSync(PM_BIN, ["--path", root, "list", "--json"], PM_SPAWN_OPTS);
  assert.strictEqual(r.status, 0, `pm list failed: ${r.error?.message ?? r.stderr}`);
  return JSON.parse(r.stdout).items.length;
}

function validateOk(root: string): boolean {
  const r = spawnSync(PM_BIN, ["--path", root, "validate"], PM_SPAWN_OPTS);
  return r.status === 0;
}

function historyVerifyOk(root: string, id: string): boolean {
  const r = spawnSync(PM_BIN, ["--path", root, "history", id, "--verify"], PM_SPAWN_OPTS);
  return r.status === 0;
}

function firstItemId(root: string): string | undefined {
  const r = spawnSync(PM_BIN, ["--path", root, "list", "--json"], PM_SPAWN_OPTS);
  const items = JSON.parse(r.stdout).items as { id: string }[];
  return items[0]?.id;
}

// ---------------------------------------------------------------------------
// Pure unit tests — stable id + transaction id derivation
// ---------------------------------------------------------------------------

test("deriveAtomicTransactionId is deterministic from jql + issue keys", () => {
  const idA = deriveAtomicTransactionId("project = P", ["P-1", "P-2"]);
  const idB = deriveAtomicTransactionId("project = P", ["P-1", "P-2"]);
  assert.strictEqual(idA, idB, "same content => same id (resumable)");
  assert.ok(idA.startsWith("jira-import-"), "prefixed to avoid cross-importer collisions");
  // Different content => different id (fresh import, never a stale skip).
  const idC = deriveAtomicTransactionId("project = P", ["P-1", "P-3"]);
  assert.notStrictEqual(idA, idC, "different issues => different id");
  // Different JQL with same keys => different id.
  const idD = deriveAtomicTransactionId("project = Q", ["P-1", "P-2"]);
  assert.notStrictEqual(idA, idD, "different jql => different id");
  // Order-INDEPENDENT: Jira gives no stable order without ORDER BY, so a crash
  // + retry can re-fetch the same issues in a different sequence. The tx id
  // must be identical regardless of key order (the crash-recovery contract).
  const idE = deriveAtomicTransactionId("project = P", ["P-2", "P-1"]);
  assert.strictEqual(idA, idE, "reordered same keys => same id (resume, not fresh import)");
});

test("buildAtomicCreateMutation derives stable, unique, prefix-correct, order-independent ids", () => {
  const txId = "jira-import-abcdef123456";
  const normalize = (input: string, prefix: string) => `${prefix}${input}`;
  const item: import("../dist/index.js").IssueToItem = {
    title: "T", status: "open", priority: 3, type: "Task", body: "", tags: [],
    description: "d", jiraKey: "X-1", jiraUrl: "https://x/X-1",
  };
  const m0 = buildAtomicCreateMutation(item, "PROJ-1", txId, "test-", normalize);
  const m1 = buildAtomicCreateMutation(item, "PROJ-2", txId, "test-", normalize);
  assert.strictEqual(m0.op, "create");
  assert.strictEqual(m1.op, "create");
  assert.ok(m0.id.startsWith("test-jira-tx-"), "prefix is applied");
  assert.ok(m1.id.startsWith("test-jira-tx-"));
  assert.notStrictEqual(m0.id, m1.id, "distinct keys => distinct ids");
  // Deterministic AND order-independent: the id depends on the Jira KEY, not the
  // fetch position — the same issue re-fetched at any index reproduces the same
  // id, so a reordered retry resumes instead of duplicating.
  const m0Again = buildAtomicCreateMutation(item, "PROJ-1", txId, "test-", normalize);
  assert.strictEqual(m0.id, m0Again.id, "id is deterministic for (txId, jiraKey), index-free");
  // Structural (not probabilistic) in-batch uniqueness: Jira guarantees unique
  // keys, so a large batch under one transaction id yields all-distinct ids.
  const ids = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    ids.add(buildAtomicCreateMutation(item, `PROJ-${i}`, txId, "test-", normalize).id);
  }
  assert.strictEqual(ids.size, 5000, "5000 distinct keys in one tx yield 5000 unique ids");
});

test("buildAtomicCreateMutation maps IssueToItem fields to create options", () => {
  const item: import("../dist/index.js").IssueToItem = {
    title: "[X-1] Thing",
    status: "open",
    priority: 2,
    type: "Bug",
    body: "the body",
    tags: ["a", "b"],
    deadline: "2026-08-01",
    description: "provenance",
    jiraKey: "X-1",
    jiraUrl: "https://x/X-1",
  };
  const m = buildAtomicCreateMutation(item, "X-1", "jira-import-abc", "pm-", (i, p) => `${p}${i}`);
  assert.strictEqual(m.options.title, "[X-1] Thing");
  assert.strictEqual(m.options.status, "open");
  assert.strictEqual(m.options.type, "Bug");
  assert.strictEqual(m.options.priority, 2);
  assert.strictEqual(m.options.description, "provenance");
  assert.strictEqual(m.options.body, "the body");
  assert.strictEqual(m.options.deadline, "2026-08-01");
  assert.strictEqual(m.options.tags, "a,b");
});

// ---------------------------------------------------------------------------
// Integration: real SDK commitItemMutations against a real temp tracker
// ---------------------------------------------------------------------------

test("atomic happy path: --atomic creates N items in one transaction", async () => {
  const root = freshTracker();
  try {
    const issues = [fakeIssue("PROJ-1", "First"), fakeIssue("PROJ-2", "Second"), fakeIssue("PROJ-3", "Third")];
    const res = (await runImport(
      { project: "PROJ" },
      root,
      { atomic: true, issues },
    )) as { imported: number; atomic?: boolean; transactionId?: string };

    assert.strictEqual(res.imported, 3, "all three issues committed");
    assert.strictEqual(res.atomic, true);
    assert.ok(res.transactionId?.startsWith("jira-import-"));
    assert.strictEqual(itemCount(root), 3, "tracker holds exactly the 3 created items");
    assert.ok(validateOk(root), "pm validate passes on the imported workspace");
    const id = firstItemId(root);
    assert.ok(id, "at least one item exists");
    assert.ok(historyVerifyOk(root, id), "pm history --verify passes on a created item");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic resume: a second run with the same issues is idempotent (recovered=true, no duplicates)", async () => {
  const root = freshTracker();
  try {
    const issues = [fakeIssue("PROJ-10", "Alpha"), fakeIssue("PROJ-11", "Beta")];
    const first = (await runImport({ project: "PROJ" }, root, { atomic: true, issues })) as {
      imported: number;
      transactionId?: string;
    };
    assert.strictEqual(first.imported, 2);
    assert.strictEqual(itemCount(root), 2);

    // Second run with the SAME fetched issues => same transactionId => resume.
    const second = (await runImport({ project: "PROJ" }, root, { atomic: true, issues })) as {
      imported: number;
      transactionId?: string;
    };
    assert.strictEqual(second.transactionId, first.transactionId, "same content => same tx id");
    assert.strictEqual(itemCount(root), 2, "no duplicate items created on resume");
    // The resumed results still enumerate the committed items (resumability
    // reports the recovered count), so imported stays 2 — but the tracker does
    // not grow. The key guarantee: idempotency, not zero count.
    assert.strictEqual(second.imported, 2, "resumed items are reported from the journal");
    assert.ok(validateOk(root), "tracker still validates after resume");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic rollback: a failing mutation leaves ZERO committed items", async () => {
  const root = freshTracker();
  try {
    const sdk = await realSdk();
    // Wrap the real commitItemMutations so the batch contains one mutation
    // whose `type` is rejected by `pm create` (invalid item type). The helper
    // will create the valid ones, fail on the bad one, then compensate (delete)
    // every applied create — leaving the tracker empty.
    const wrappingCommit = async (opts: any) => {
      const settings = await sdk.readSettings(opts.pmRoot);
      const badId = sdk.normalizeItemId("jira-tx-brokenfail", settings.id_prefix);
      const broken = [
        ...opts.mutations,
        { op: "create", id: badId, options: { title: "broken", type: "NoSuchType_XYZ", status: "open", priority: 3 } },
      ];
      return sdk.commitItemMutations({ ...opts, mutations: broken });
    };

    const issues = [fakeIssue("PROJ-20", "Will be rolled back"), fakeIssue("PROJ-21", "Also rolled back")];

    await assert.rejects(
      async () =>
        runImport({ project: "PROJ" }, root, {
          atomic: true,
          issues,
          commitItemMutations: wrappingCommit,
        }),
      (err: unknown) => {
        assert.match(
          (err as Error).message,
          /Atomic Jira import failed and was rolled back/,
          "throws the rolled-back error",
        );
        assert.match((err as Error).message, /compensated \(deleted\)/);
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
        return true;
      },
    );

    // The core rollback guarantee: ZERO committed items from the import.
    assert.strictEqual(itemCount(root), 0, "rollback leaves the tracker empty");
    assert.ok(validateOk(root), "tracker validates after rollback");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic dry-run commits no transaction (no network, no writes)", async () => {
  const root = freshTracker();
  let commitCalled = false;
  try {
    const issues = [fakeIssue("PROJ-30", "Dry run only")];
    const res = (await runImport(
      { project: "PROJ", "dry-run": true },
      root,
      {
        atomic: true,
        issues,
        // If the dry-run path ever reached the transaction, this would be called.
        commitItemMutations: async () => {
          commitCalled = true;
          throw new Error("dry-run must not call commitItemMutations");
        },
      },
    )) as { dryRun: boolean; atomic?: boolean };

    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.atomic, true, "dry-run still reports the requested atomic mode");
    assert.strictEqual(commitCalled, false, "no transaction is committed on a dry-run");
    assert.strictEqual(itemCount(root), 0, "dry-run writes nothing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic --atomic flag is surfaced on the dry-run return", async () => {
  const root = freshTracker();
  try {
    const res = (await runImport(
      { "project-key": "DRY", "dry-run": true, atomic: true },
      root,
      {},
    )) as { dryRun: boolean; atomic?: boolean; project: string };
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.atomic, true);
    assert.strictEqual(res.project, "DRY");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCommitItemMutations: missing export throws the USAGE upgrade guard", async () => {
  // Exercise the REAL guard: an injected importer that returns an SDK module
  // WITHOUT commitItemMutations (an old @unbrained/pm-cli) must produce the
  // human-readable CommandError with EXIT_CODE.USAGE and the upgrade hint.
  await assert.rejects(
    async () => resolveCommitItemMutations(async () => ({}) as never),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      assert.match((err as Error).message, /does not export it as a function/);
      assert.match((err as Error).message, />=2026\.7\.20/);
      return true;
    },
  );
});

test("resolveCommitItemMutations: an import failure throws the USAGE could-not-import guard", async () => {
  await assert.rejects(
    async () =>
      resolveCommitItemMutations(async () => {
        throw new Error("Cannot find module '@unbrained/pm-cli/sdk'");
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      assert.match((err as Error).message, /could not be imported/);
      return true;
    },
  );
});

test("resolveCommitItemMutations: a valid injected export is returned as-is", async () => {
  const fake = (async () => ({})) as never;
  const resolved = await resolveCommitItemMutations(async () => ({ commitItemMutations: fake }) as never);
  assert.strictEqual(resolved, fake, "the exported function is returned unchanged");
});

test("atomic seam: an injected non-function commitItemMutations fails at call time", async () => {
  // Distinct from the resolve guard above: when a caller injects a bad
  // commitItemMutations via the TEST SEAM (bypassing resolveCommitItemMutations),
  // the failure surfaces at call time rather than through the upgrade guard.
  const root = freshTracker();
  try {
    await assert.rejects(
      async () =>
        runImport({ project: "PROJ" }, root, {
          atomic: true,
          issues: [fakeIssue("PROJ-40", "X")],
          commitItemMutations: "not-a-function" as unknown as never,
          readSettings: async () => ({ id_prefix: "test-" }),
          normalizeItemId: (i: string, p: string) => `${p}${i}`,
        }),
      /TypeError|not a function|atomic/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});