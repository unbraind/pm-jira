# Pinned Daily Release pilot

This package delegates its release transaction to
`unbraind/pm-ops/.github/workflows/daily-release.yml` at
`7687a35d7522482bd8361d60dbc2589e9afbc81c # v2026.11.14`.
The canonical Git tag API identifies that object directly as a commit; the local
peeled tag agrees. The release was published on 2026-11-14 at 06:06:41Z.

The caller retains the daily preparation schedule and adds canonical hourly
reconciliation, opt-in unpublished-intent retirement, empty workflow permissions
and the shared transaction's job permissions. Root Dependabot configuration
already covers `github-actions`, including this SHA and canonical version comment.

The caller retains `release:update-version` through `prepare-script`, so package-owned version stamping runs before the shared build and release checks.

All package changelog generate/check/notes scripts explicitly include
`--include-empty`. They already carried the option at the migration baseline;
the pilot retains it without duplication and regenerates CHANGELOG.md. The
unreleased persistence work in pm-ops PR #275 is therefore a no-op for these
scripts and is not required by this pilot pin.

## Activation gate

The first scheduled or orchestrator-dispatched run must pass **Verify npm will
accept this workflow's OIDC identity** for this cross-repository reusable call.
Until that live token exchange succeeds, activation is unverified. npm trusted
publishing stays configured for this package's own repository and `release.yml`;
no trusted-publisher setting change is required. The exchange checks identity,
while npm must separately permit the publish action. Neither local YAML checks
nor a previous same-repository exchange prove this cross-repository acceptance.

No merge, release dispatch or publication is performed by the pilot PR.

## Pre-merge prerequisite and validation

The installed pm-ops 2026.11.6 validator rejects the caller's required
`checks: read` permission. The released canonical checker verifies this caller,
but the package's attestation gate remains blocked until a compatible validator
dependency lands. The dependency pin is retained under Dependabot ownership;
permissions and attestation checks are not weakened. Full npm/Bun certification
therefore remains outstanding.

Focused workflow tests pass 6/6. A real empty tracker and dependency-only Git
window using the actual pinned pm-changelog 2026.11.10 and package hooks passes
generation, notes, pre-tag checking and post-tag checking. Both pilots' actionlint,
strict YAML parsing, canonical tag verification and changelog checks pass.

## Fleet rollout receipt

This pilot is part of [pm-ops #272](https://github.com/unbraind/pm-ops/issues/272),
tracked centrally by `ops-release-diagnosis-propagation`. Both pilot PR URLs and
final validation receipts are recorded in the package pilot items. No additional
pm-ops code/tracker PR or push to #275 is part of this continuation.

After pm-lint and pm-jira, the remaining 34 authorized packages are:

pm-ado, pm-beads, pm-brand, pm-brief, pm-case, pm-changelog, pm-context, pm-csv, pm-evidence, pm-gantt-chart, pm-github, pm-glossary, pm-graph, pm-http, pm-hypothesis, pm-jev, pm-linear, pm-memory, pm-presets, pm-reduce, pm-review, pm-rl, pm-rlm, pm-rust, pm-screen, pm-slack, pm-slack-standup, pm-starter, pm-swarm, pm-todos, pm-ts-starter, pm-unit, pm-vcs, pm-web.

pm-cli is excluded. Roll out in small reviewed batches after both pilots have
passed their live preflight. Preserve approval guards, package scripts, outputs,
extra publishing targets and synthetic services. Affected older raw changelog
generators must satisfy pre-tag/post-tag checks or resolve the existing
[pm-changelog #337](https://github.com/unbraind/pm-changelog/issues/337) prerequisite.
Only the orchestrator merges, dispatches and verifies publication.
