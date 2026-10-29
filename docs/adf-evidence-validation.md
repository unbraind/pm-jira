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

The revision guard and original-coordinate behavior were independently disabled
in disposable non-git copies. The exact table/code regression failed for each
mutation. The fixed implementation was never altered during this check and its
focused tests passed again afterward.

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
| Emitted bytes / maximum packet bytes | 200704 / 3996 |
| Budget refusals / Jira calls / native state changes | 0 / 0 / 0 |

Native state was read back through the SDK after validation and its complete
fingerprint matched the initial read. The script accepts operator paths, prints
aggregate measurements only, and invokes no git subprocess.

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
approved capture, exact packet equality and TOON. The artifact remains untracked.

Full unchanged-threshold npm and Bun release gates run in CI on Node 22 and 26.
The native model test covers all four import/sync entrypoints with both atomic
choices and export paths; replay-revision limitations in the existing atomic
importer remain tracked by `pm-jira-atomic-replay-revisions`.

No new target writes, journal, recovery plan, claim or lease exists in this
feature. Callers must refresh source snapshots before approval. A source change
after their last observation remains outside this offline observation boundary.
