# Jira create completion previews

`pm jira preview-create --contract create.json --json` compiles a supplied create
contract before export. The same command without `--json` uses the host's compact
TOON renderer. It performs no network requests or tracker writes and needs no
credentials or git repository. The SDK exports `previewJiraCreate(unknown)` and
all `JiraCreate*` input/result types from `pm-jira`.

Start with [the revisioned fixture](examples/create-contract.json). It intentionally
omits the required Team answer. The command returns `kind: incomplete`,
`code: answers_required`, `exit_code: 2`, a `missing` row and two `allowed` rows.
Set `answers.customfield_10001` to `{ "id": "10" }` and rerun for `kind: ready`.
Unknown fields, incompatible types and unadvertised choices produce `invalid`
rows. Required fields never silently accept Jira defaults. Supplied strings and
option IDs are compared exactly; no trimming or value coercion is performed.

```ts
import { previewJiraCreate } from "pm-jira";
import type { JiraCreatePreviewInput } from "pm-jira";

// contract is parsed JSON, or a caller-owned JiraCreatePreviewInput.
const result = previewJiraCreate(contract);
if (result.kind === "refused") console.error(result.code, result.remediation);
else console.log(result.kind, result.counts, result.page.nextOffset);
```

## Preparing metadata

Capture **every page** of Jira's project/type create-field metadata for the
intended principal. Use Jira's
[Get create field metadata for a project and issue type](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-createmeta-projectidorkey-issuetypes-issuetypeid-get).
The v1 contract is an explicit normalized projection, not the raw Jira page:

- `version: 1`, a caller-controlled nonempty `revision`, exact `project` key and
  exact `issueType` name identify the selected contract. Export compares these
  with the actual payload project key and type name. Jira metadata requests use
  an issue type ID; retain its resolved name in the fixture.
- Project and issue type are bound by the contract scope rather than field rows.
- Project each supported field's `fieldId`/`key`, `name`, `required` and schema to
  `id`, `name`, `required`, `type`. Include every supported required custom field.
  `string`, `number`, `boolean`, `option` (an exact `{id}` object), `strings` and
  `options` are supported. Project allowed option objects to `{id}`; simple
  string/number/boolean choices keep their scalar value.
- Preserve `allowedValues` whenever advertised; an empty list permits no answer.
  Absence means no enumerated restriction was supplied. Do not replace a paged
  or autocomplete-only set with a partial list and claim completeness.
- ADF/textarea, dates with semantic validators, users, cascading selects, parent
  objects and other compound schemas need explicit adaptation outside v1. Do not
  omit unsupported required fields to manufacture readiness. The scalar preview
  does not validate the exporter's generated ADF description or server defaults.

The compiler returns both the supplied revision and SHA-256 digest of the exact
validated metadata JSON representation. Capture revisions consistently and
recapture after screen/configuration/principal changes. The compiler cannot
prove freshness, completeness, Jira permissions or server-side validators from
an offline fixture. Readiness covers the supplied contract, not acceptance by
Jira. No mutation journal, retry queue, claim, lease or idempotency key is created.

## Guarding actual exports

```bash
pm jira preview-create --contract create.json --json
pm jira export --project DEMO --create-contract create.json --push --json
```

Export protection is opt-in with `--create-contract`; ordinary exports retain
their historical behavior. The guarded push reads the file on each invocation
and recompiles **every create before any POST or PUT**. Missing or invalid
answers anywhere abort the batch with usage exit 2 and zero writes. Payload
values for declared native fields (such as summary) override the standalone
preview answer, so a valid example summary cannot hide an invalid actual title.
Explicit valid answers add custom fields to each create payload. Existing-issue
updates retain their existing behavior after the full create batch passes.
For mixed issue types, split exports by explicitly selected type/contract.

`runExportPush(plan, { authHeader, updateExisting, createContract })` provides the
same guard to SDK callers. It never mutates the caller's plan or contract. The
standalone preview and guard do not persist or replay ready plans. Rebuild a
plan from current SDK reads for each retry; a supplied old plan remains old
input. Export dry runs do not execute this push guard; use `preview-create` for
an offline checklist. Repeated successful pushes are not remote-idempotent;
this feature does not add remote transaction or synchronization guarantees.

## Input and output bounds

The SDK and file command share one strict schema. Unknown object keys, unsupported
schemas, sparse arrays and invalid numbers are rejected at that boundary with a
typed remedy. The CLI reads regular JSON files up to 1 MiB using a bounded read.
Limits are 256 fields/answers, 128 advertised choices per field, 16 array answers,
512 UTF-16 code units per scalar string, 64 per option/field ID, 128 per display
name and 64 per revision/project/type. Nonempty text may contain tabs/CR/LF;
other control characters are rejected. Numbers must be finite in `[-1e12, 1e12]`.
Array answers are nonempty when matched against a field. All emitted counters
are finite, bounded nonnegative integers.

`budget` is an integer UTF-8 JSON byte budget (two-space indentation plus newline), default 8192, range 4096..65536.
`offset` is an integer diagnostic offset, default 0, range 0..1000000. The JSON
result fits this budget, including its envelope. Counts and readiness always
cover the complete contract. `page.total` counts all binding/diagnostic/choice
rows; `page.nextOffset` is the next offset or null. Multi-value bindings emit
one consecutive `bound` row per element in original order. Repeat the same
contract and answers with that offset to recover every row. Keep the revision,
digest and answers unchanged across continuation pages. An out-of-range offset
returns an empty page without changing readiness. If even one row cannot fit (for example, heavily escaped Unicode), `budget_too_small` refuses with a remedy to raise the budget instead of returning a nonadvancing continuation. Typed refusals fit 1024 bytes.
TOON also uses the host's global output budget and omission/continuation receipts;
check those receipts if an independently smaller host limit clips a result.

## Validation receipt

A read-only copy of the public `unbraind/pm-jira` tracker at
`84d1cde6211d9330ed659c39a756259e58c2f9c8` was extracted from `origin/main` into
a non-git scratch project. Its 225 source files were made read-only; SDK-derived
runtime caches were confined to that scratch project. Certified SDK reads
included all 109 items: 6 open, 1 in progress, 101 closed and 1 canceled.

Against the revisioned synthetic Team contract, all 109 items produced a missing
answer checklist, all 109 became ready with an allowed answer, and all 109
rejected an unadvertised answer. The largest compact JSON result was 967
bytes; the largest pretty JSON result including newline was 1260 bytes under a
4096-byte budget. The all-batch guarded export refused with 0 POSTs
and 0 PUTs. All 225 source-file hashes remained unchanged. This measures real pm
tracker input with synthetic Jira metadata, without contacting a Jira tenant.

`test/create-preview-model.test.ts` uses seed `0x4a495241`, 500 random sequences
and at least 2000 logical operations. A separate real SDK tracker is the reference
model; SDK readback compares native fields and relationships without a hand-coded
whitespace normalizer. The model covers direct imports, the sync command, both
importer adapters, atomic selections, eight fresh imports, older-input replay,
CRLF/whitespace, four random custom status names with SDK roles, native edits,
exports and guarded preview refusals. Independent clock fields are excluded only
from cross-tracker comparison. The initial run preserved state through 40 exact
SDK journal-plan mismatch refusals from older atomic inputs. That existing
limitation is tracked by `pm-jira-atomic-replay-revisions`; its misleading rollback
diagnostic is tracked by `pm-jira-d3tp`. The preview adds no journal or replay path.

## Supplied option values

Every Jira command validates its complete option bag through the shared
`option-boundary.ts` schema before defaults, alias selection, file/tracker reads
or HTTP. A supplied empty string, spaces, tab or CRLF is a typed SDK usage error
(`invalid_option`, exit 2), with a remedy to omit the option or provide a
nonblank documented value. This includes `--create-contract`, secondary aliases,
boolean flags supplied as strings and legacy importer credential options. A valid
primary alias cannot hide a blank secondary alias. Omitted/undefined options retain
their defaults; meaningful strings are trimmed once. CLI bare switches are true.

Known text flags require strings; numeric flags require finite safe integers in
their documented domains; boolean options accept true/false, 0/1 and the explicit
strings true/false/yes/no/0/1. The immutable snapshot accepts at most 256 option
keys, each 1..128 characters, and strings up to 1,048,576 UTF-16 code units. Callers must omit an unused
option rather than use an empty/null/falsy options bag or a blank guard value.

`test/option-boundary.test.ts` reconciles the inventory with actual SDK command
registrations. It covers all eight command surfaces, 60 value-bearing bindings
and eight switch bindings, 94 kebab/camel spellings, and the Cartesian product of
absent/empty/spaces/tab/CRLF/valid values: 564 table cases, including 376 blank
cases. Every blank produces typed usage refusal and zero calls to a recording
TLS Jira server. Fixed SDK and installed non-git CLI cases cover
`--create-contract ' ' --push`; positive GET/POST/PUT controls reach the fake
server. GET, POST and PUT preserve an explicitly configured URL port.
