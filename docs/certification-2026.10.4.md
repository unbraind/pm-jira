# PM CLI/SDK 2026.10.4 certification

Owner: [pm-jira-gdlw](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-gdlw.toon).

The consolidated branch carries Dependabot #118, #121, #122 and #123. Exact development pins are `@unbrained/pm-cli`, `pm-ops` and `pm-changelog` 2026.10.4, `@types/node` 26.6.4, TypeScript 7.0.2 and selfsigned 5.5.0. The existing CLI peer and manifest floors remain unchanged. CodeQL init/analyze use Dependabot's exact SHA `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` (v4). The project-managed pm-github extension and CI restoration now use 2026.10.4; scheduled synchronization remains disabled.

The merge-driver launcher is copied byte-for-byte from `node_modules/pm-ops/templates/prepare-merge-driver.ts`. A real malformed filesystem fixture (`node_modules` is a file) first failed with the prior launcher's ENOTDIR, then passed with the canonical launcher retaining MODULE_NOT_FOUND. All eight launcher tests pass without skips.

## Commands and scope

Heavy commands run under `flock /tmp/claude-1000/heavy-gate.lock`.

- `npm install`: updates the npm lockfile; this repository has no Bun lockfile.
- `npm audit` and `npm audit --omit=dev`: both zero vulnerabilities. The GitHub open security-alert list is empty.
- `npx pm health --strict-exit --require-merge-drivers --json`: exit zero; advisory findings are retained rather than treated as lossless merge evidence.
- `npx pm github sync --repo unbraind/pm-jira --dry-run --json`: zero synced/skipped/planned; no provenance-linked items, no remote writes.
- `npx pm test pm-jira-gdlw --run --progress`: linked `env -u PM_PATH npm run release:check`, with source workspace and tracker context. Unsetting PM_PATH in the gate child lets integration fixtures create their own tracker exactly as CI does.
- `bun install --no-save`: additional CI dependency-graph acceptance.

Coverage thresholds remain 100% lines, branches and functions with `sources: ["."]` and no ignore entries. The inventory currently contains `index.ts` and `sdk-importer.ts`; the existing walker excludes operational scripts, tests and build output. Statements are not measured by this gate. Final observed totals are recorded below and in the owner item.

## Packed real-tracker acceptance

The package is built and packed using `npm pack`, then its tarball and `@unbrained/pm-cli@2026.10.4` are installed into `/tmp/claude-1000/cert-wt/pm-jira-dogfood`. This scratch workspace carries a copy of this repository's actual `.agents/pm`, including the certification owner. Jira credentials and the export-on-write environment variable are removed from the child environment.

After `npx -y @unbrained/pm-cli@2026.10.4 package install <tarball> --project`, each command runs with both `npx -y @unbrained/pm-cli@2026.10.4` and native `bunx --bun @unbrained/pm-cli@2026.10.4`:

```text
jira validate --json
jira sync --project CERT --dry-run --json
jira import --project CERT --dry-run --json
jira export --project CERT --dry-run --json
jira export --project CERT --rich --update-existing --json
```

The acceptance checks complete JSON equality between npm and native Bun, a nonempty export plan containing the certification owner, and `pushed: false`. It exercises the real tracker through the published package, without writing to Jira. Live Jira authentication, tenancy and network reachability are outside this acceptance. The scratch workspace is removed on exit.

## Observed results

The initial full gate passed 194/194 tests, with zero skips and 100% lines/branches/functions across two application source files. Packed acceptance then exposed missing native importer/exporter flag registrations. A failing activation-contract regression was added before wiring their existing PULL_FLAGS and EXPORT_FLAGS through the SDK. Final gate and dogfood receipts follow.

The final full release gate passed **195/195 tests**, with zero skips and **100% lines / branches / functions** across the unchanged two-file application inventory. npm and native Bun exported **all nine real tracker items**, including the certification owner, with identical readiness, import/sync previews, simple export plans and rich export plans. An independent unbounded list confirms the tracker has nine items, with no pagination or omission. Live Jira was not exercised. All scratch workspaces were deleted.
