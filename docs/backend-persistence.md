# Jira persistence adoption: filesystem slice

Refs #164. This package consumes the PM SDK; Jira is not an authoritative PM
backend. The dependency pins and minimum supported SDK remain unchanged.

At main `e6ce396`, PR #165 (`84d1cde`) already replaced ordinary create shell-outs
with `PmClient.create`. The remaining defect was tracker identity: `readPmItems`
resolved a relative root after awaiting the SDK, and subsequent settings and
writes independently used the original path. An embedded caller changing cwd
could redirect a running operation to another tracker.

`bindJiraPersistence(root)` now pins an absolute filesystem root synchronously,
without reading the tracker. `runImport`, `importJiraAtomic` and `readPmItems`
accept either a path or this reusable immutable binding. The legacy `jira-sync`
importer binds before fetching. All tracker IO uses the binding; pure provider
mapping and SDK normalization remain separate from persistence.

```ts
import { bindJiraPersistence, readPmItems, runImport } from "pm-jira";

const target = bindJiraPersistence(".agents/pm");
const before = await readPmItems(target);
const result = await runImport({ project: "DEMO" }, target, { atomic: true });
```

The example performs a live Jira read and requires the existing credential gates.
Dry runs return before binding or reading the tracker. No shell-out, temporary
tracker database emulation, Git requirement, or provider request is added.

## Persistence inventory

| Dependency / callers | Bound operation | Contract owner / limits |
| --- | --- | --- |
| Export planning and import deduplication (`readPmItems`, `existingJiraUrls`) | `readComplete` → SDK `listAllComplete`, with bodies and `noExtensions` | SDK certifies whole-corpus reads; package validates Jira-consumed field types. Terminal items remain included. A certificate is not snapshot isolation across a later write. |
| Ordinary imports (`runImport`, legacy `jira-sync`) | `create` → `PmClient.create` | SDK validates fields and appends history. Existing per-item partial-success behavior and extension loading are retained. |
| Prefix for atomic IDs and recovery matching | `readSettings` → SDK `readSettings` | Same pinned tracker as reads/writes. The existing direct atomic helper's default-prefix fallback remains; the normal importer reads settings before committing. |
| Identity normalization | SDK `normalizeItemId`; Jira keys/URLs and transaction IDs remain package-specific | Pure normalization has no separate backend IO. Key-only replay identity limitations remain tracked separately. |
| Atomic creates and recovery | `commit` → resolved SDK `commitItemMutations` | Same pinned root owns journal, writer lock, mutation validation, durable history and compensation. The package adds no lock or recovery algorithm. Existing injection seams remain for compatibility. |
| History, journal and lock storage | Transitive SDK persistence | No direct package filesystem writes to tracker data. History verification in tests uses the public SDK. |
| Create-contract, ADF and JQL evidence input | Bounded regular-file readers in the command modules | Explicit user input/artifact transport, not a tracker persistence backend. |
| Export/update/transition calls and push-on-write hook | Jira HTTPS; hook uses host-supplied item | Provider IO remains separate. Jira search is eventually consistent, and does not certify a database snapshot. |

The binding declares only `backend: filesystem`,
`completeRead: certified-corpus`, and `batchWrite: recoverable-compensation`.
These are scope descriptions, not generic adapter capabilities. Ordinary imports
have no cross-process uniqueness guarantee for overlapping Jira identities;
complete reads and later writes do not form one compare-and-set transaction.
The process test proves two independent atomic batches preserve writes and valid
history on one non-Git tracker, even after each worker changes cwd.

## Recovery reporting

Empty direct atomic batches and invalid transaction identities (including blank
authors) refuse before tracker access, without journal recovery advice. The
SDK validates transaction identity; successful calls retain the existing item-ID
derivation and the SDK-owned author/journal normalization for replay compatibility.
Ordinary imports with no selected issues continue to succeed without a transaction.

`WorkspaceTransactionInterruptedError` reports retained work and instructs retry
with the same input. Other errors report that rollback is unconfirmed and retain
the transaction ID and underlying error for journal inspection. A thrown error
cannot establish successful compensation: plan mismatch, lock refusal and failed
compensation are also possible. SDK compensation semantics remain unchanged.
The existing `pm-jira-d3tp` item owns this diagnostic correction.

## Remaining roadmap and acceptance

The installed SDK `2026.11.4` exposes `PmClientOptions` with only `pmRoot`, `cwd`,
`author` and `noExtensions`. `CommitItemMutationsOptions.pmRoot` and
`CommitWorkspaceTransactionOptions.pmRoot` are required. The public declarations
contain no native persistence backend selector. Bound client transaction methods
exist; the missing capability is a native non-filesystem context, not transactions.
Read-only upstream search confirmed [#1587](https://github.com/unbraind/pm-cli/issues/1587),
[#1588](https://github.com/unbraind/pm-cli/issues/1588),
[#1589](https://github.com/unbraind/pm-cli/issues/1589) and
[#1399](https://github.com/unbraind/pm-cli/issues/1399) remain open.

- **pm-jira-native-backend-context (Feature):** adopt the shared native context
  when the upstream contract exists; route settings, identity, certified reads,
  writes, history and transactions through it without a tracker directory or
  subprocess bridge. Preserve current filesystem callers and credential/dry-run
  gates. Declare unsupported CAS/history/transaction capabilities and refuse
  before writes or emit an explicitly weaker receipt. Review compatibility
  separately before changing the dependency floor.
- **pm-jira-native-backend-conformance (Feature):** run identical synthetic
  import/export/reconcile scenarios against filesystem and a real native
  non-filesystem backend without a tracker directory. Verify custom fields,
  bodies, statuses and references; incomplete-read refusal; deterministic replay;
  interruption/resume; concurrent writers and local edits; capability refusal;
  CLI/SDK parity. Use real OS processes and no SDK mocks. Link migration-fidelity
  evidence and state exactly which surfaces pass.
- **pm-jira-atomic-replay-revisions (existing Issue):** retain the existing
  recovery-identity/ownership work. Changed input for a reused key-only journal
  still refuses; this slice corrects its diagnostic, without changing its plan.

Issue #164 remains open until the native context and conformance acceptance is met.
The filesystem tests do not certify native database support or whole-package
migration fidelity.
