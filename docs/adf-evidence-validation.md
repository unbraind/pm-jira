# ADF evidence validation

The feature is offline, read-only and accepts explicit caller-observed source
snapshots. It does not attest live Jira access or freshness.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Table cell and code block round-trip with stable coordinates | `test/adf-evidence.test.ts`: exact cell/code/list replay, CRLF, numeric source order above nine, detached attribute arrays and original-to-replay coordinate mapping. |
| Unsupported nodes counted | Same test verifies the full source partition, exclusion of unsupported subtrees and media/cards, omitted marks and absence of unselected attributes/text. |
| Changed source revision refuses approved capture | Same test checks revision, identity and same-revision description edits, plus 500 seeded capture/replay/approval sequences. |
| Native state and relationships preserved | `test/adf-evidence-command.test.ts` uses the real installed CLI without git; `test/create-preview-model.test.ts` adds capture/replay to 500 SDK-reference-model import/export/sync sequences, including older-input replays and custom status registries. |
| Producer/validator agreement and hostile values | Source/packet corpora exercise sparse arrays, invalid coordinates, oversized/deep/cyclic input, Infinity/NaN, corrupt packets and valid checksums with malformed schemas; all producers share replay's node-field schema. |
| Nullable editor defaults remain readable | A further 500 seeded selection sequences cover both cell kinds, omitted/null/explicit attributes, selected/unselected/context cells and nullable code language. Malformed attributes refuse in both source and re-signed packets. The native SDK model and installed JSON/TOON tests exercise these defaults too. |

The revision guard and original-coordinate behavior were independently disabled
in disposable non-git copies. The exact table/code regression failed for each
mutation. The fixed implementation was never altered during this check and its
focused tests passed again afterward.

Re-review found that unresized table cells (`colwidth: null`) prevented even an
unrelated code capture. The general rule is compatibility of recognized editor
defaults across source readers and packet producers/validators. A package-wide
search found one shared attribute validator; legacy plain-text flattening ignores
attributes. Published Atlassian `adf-schema` 57.7.26 also uses nullable defaults
for cell background and code language, so all three are preserved. Numeric
span, heading and list-start defaults still reject null. The new must-allow
property failed before the fix. In disposable non-git copies, reverting only
`validAttrs`, or separately rejecting null width, background or language, each
fails that property with `invalid_input` (exit 1); the must-refuse corpus passes.
Fixed tests pass again, with no existing tests removed or weakened.
The native model passed 500 sequences (2000 native operations and 2000 evidence
operations), including 40 safely refused older atomic replays. The linked runner's
default 120-second limit expired on the shared host; its bounded retry passed
with `pm test pm-jira-adf-block-evidence --run --only-index 4 --timeout 900 --progress`.
The project compatibility floor refuses storing newer timeout metadata, so the
runtime override was used without changing pins or migrating the item format.

## Public tracker measurement

The public pm-jira tracker at main revision
`eaeaf48fc6f52321ecc4fea4501aaa97c9ed69c1` was copied to a non-git scratch
project. Copied tracker files were read-only. `listAllComplete` with bodies read
all 112 items, then `scripts/validate-adf-public-tracker.ts` projected exact SDK
native title and body-or-description strings into explicit ADF table/code
wrappers. This validates real public content; it does not imply that the native
tracker contains Jira ADF or that live Jira was queried.

| Measurement | Result |
| --- | ---: |
| Items read / captured / round-tripped | 112 / 112 / 112 |
| Changed-revision refusals | 112 |
| Source nodes / retained nodes | 1680 / 560 |
| Native body bytes | 14825 |
| Emitted bytes / maximum packet bytes | 216832 / 4140 |
| Budget refusals / Jira calls / native state changes | 0 / 0 / 0 |

Native state was read back through the SDK after validation and its complete
fingerprint matched the initial read. The script accepts operator paths, prints
aggregate measurements only, and invokes no git subprocess.
This repeated measurement includes null column width/background on the selected
cell and unselected header, and null code language, with exact replay checks.

## Reproduction

```sh
npm run typecheck
npm run build
npm run build:test
npm run docstring
node --test --test-concurrency=2 test/adf-evidence.test.ts test/adf-evidence-command.test.ts
node scripts/packed-adf-acceptance.ts
```

The packed acceptance script captures one npm pack artifact, checks its required
files and SHA-256 before/after use, and exercises npm global, Bun global, npx,
bunx, npm local and Bun local hosts (2026.10.28). Each mode verifies preview,
approved capture, exact packet equality and TOON, for both table/code selections
and code-only selections beside an unselected default-valued table. TOON rows
are restored using SDK `decodePmTableRows` and their host encoding receipts;
explicit nulls and omitted fields remain distinct. Static SDK consumers load
the packed entrypoint and replay each packet; raw extracted consumers first
install the declared peer SDK through npm. The artifact remains untracked.

Full unchanged-threshold npm and Bun release gates run in CI on Node 22 and 26.
The native model test covers all four import/sync entrypoints with both atomic
choices and export paths; replay-revision limitations in the existing atomic
importer remain tracked by `pm-jira-atomic-replay-revisions`.

No new target writes, journal, recovery plan, claim or lease exists in this
feature. Callers must refresh source snapshots before approval. A source change
after their last observation remains outside this offline observation boundary.
