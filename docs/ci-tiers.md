# Fleet CI v2

Required `test (22)` and `test (26)` remain GitHub-hosted Ubuntu checks. PRs
and manual dispatch run quick CI; superseded PR runs cancel. Every PR job has
a 30-minute timeout. Tracker/docs-only PRs still report both required checks.

| Check | Code PR 22 | Code PR 26 | Docs/tracker PR (both) | Deep 22/26 |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | yes | yes |
| Pinned project pm-github installation / registry restoration | yes | yes | yes | yes |
| Strict tracker health / merge drivers | yes | yes | yes | yes |
| Fresh build / committed dist comparison | yes | yes | — | yes |
| SDK adoption differential against base build | — | yes | — | yes |
| Typecheck / docstring gate | build/test typecheck | npm gate + existing docstring step | — | full npm + Bun gates |
| Build and test suite | quick | quick coverage | docs/identity suites | full npm + Bun |
| Coverage, unchanged 100% lines/branches/functions | — | quick | — | full npm + Bun |
| Production dependency audit | — | npm gate | — | npm + Bun |
| Pack dry-run / prepack build / packaged file list | — | npm gate | yes | npm + Bun |
| Changelog consistency / release date verifier | — | npm gate | yes | npm + Bun |
| Publish-attestation verifier | — | npm gate | yes | npm + Bun |
| Commit identity audit | suite | suite | yes | suite |
| JQL guide / packaged ADF example command tests | suite | suite | yes | suite |
| Bun graph installation / bunx CLI smoke | — | yes | — | install + full Bun gate |
| CodeQL | separate workflow, relevant paths | same | path-filtered | main/relevant paths + weekly |

The cheap path includes `identity-audit`, `jql-selection` and
`adf-evidence-command` tests, pack dry-run, and both release verifiers. The
attestation auditor recognizes shell shebangs independent of filename. There
is no standalone lint, duplication, privacy or secret script in this package;
commit identity auditing still runs on documentation/tracker changes. Release
workflows, pm-github workflows and verifier scripts are unchanged.

The SDK differential consumes an immutable snapshot of the baseline tracker,
not proposed docs/tracker data; its inputs are code and that baseline. It stays
on code PR Node 26 and both deep legs. Installing the project's pinned extension
remains necessary for the existing strict health contract.

Deep triggers on main push, nightly 02:19 UTC (release is 03:23 and hourly :41),
and dispatch. Its checks are `deep (22)` and `deep (26)`, with a 120-minute
limit and per-ref cancellation. It retains Node 22/26 × full npm/Bun gates,
`PM_TEST_DEPTH=full`, and `PM_TEST_TIME_SCALE=3`. The runner expression selects
`self-hosted,pm-local` unless `PM_LOCAL_DEEP=off`; hosted fallback restores npm
cache and installs Bun. Local jobs use persistent npm cache and image-provided
Bun instead, and every deep job logs the Bun version. CodeQL keeps Monday
05:13 UTC, PR cancellation and a 30-minute timeout. It is not required and
ignores tracker data, Markdown, docs and package-lock changes on PR/main push.

Depth defaults to full. Quick takes the first deterministic tenth of each
500/512/1000-case repetitive property corpus, rounded up with a floor of 25
and capped by the original count. Seed order and per-case assertions stay the
same. Generated success/refusal totals and diagnostics follow actual case
counts. Structural 5,000-key uniqueness and 10,000-item complete-read fixtures
are product-boundary contracts and remain intact. Coverage thresholds and
source scope are unchanged; this gate measures lines, branches and functions,
not an independent statement dimension (the existing coverage-scope issue is
outside this rollout).

Only the worker test's harness timeout scales; product transport/lock budgets
remain unchanged. Scale validation happens before its children spawn, rejects
nonfinite/nonpositive values and rounds milliseconds up to integers.

The existing `scripts/packed-adf-acceptance.ts` proves npm/Bun global and local,
npx and bunx installation, but is a manual acceptance script and was never in
the original CI gate. PR CI therefore explicitly retains `bun install --no-save`
and adds `bunx --no-install pm --version`; it does not claim full packed install
certification. No previous CI check is removed from all tiers.

Baseline [main run 43638869967](https://github.com/unbraind/pm-jira/actions/runs/43638869967):
creation-to-completion 9m13s on Node 22 and 8m08s on Node 26. Full npm gates
were 1m10s/1m39s and Bun repetitions 1m08s/1m36s. The slowest reference-model
property took about 34s. Full depth is deferred to deep CI after merge. Local
quick proof and the PR CI snapshot are recorded in the tracker and PR; no CI
wait is part of this rollout.
