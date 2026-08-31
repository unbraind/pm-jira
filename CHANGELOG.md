# Changelog

## 2026.8.31 - 2026-08-31

### Fixed

- Pin pm-changelog 2026.8.30 before the next release ([pm-jira-5whg](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-5whg.toon))

## 2026.8.29 - 2026-08-29

### Other

- Pilot pm-github issue sync for pm-jira ([pm-jira-jszx](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-jszx.toon))

## 2026.8.28 - 2026-08-28

### Fixed

- A failed provenance publish silently falls back to an unattested one ([pm-jira-j2zv](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-j2zv.toon))
- changelog scripts read the pm workspace with default budgets instead of canonical complete reads ([pm-jira-frtv](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-frtv.toon))

### Security

- The identity gate deadlocks the one remediation its own failure message prescribes ([pm-jira-c3rp](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-c3rp.toon))

### Other

- Drop inert pm manifest key and guard the closed manifest vocabulary ([pm-jira-qd15](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-qd15.toon))

## 2026.8.16 - 2026-08-16

### Fixed

- The pm CLI compatibility floor was declared only in peerDependencies, which only npm enforces, and not in manifest.json pm_min_version, which is the field the CLI enforces ([pm-jira-2wbj](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-2wbj.toon))
- Scope preflight override to pm-jira's owned commands ([pm-jira-5mxw](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-5mxw.toon))

### Deprecated

- The deprecated jira-sync importer alias loses its credential gate when the preflight override is scoped ([pm-jira-2m0s](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-2m0s.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- Propagate the docstring gate entry guard fix ([pm-jira-tmj3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-tmj3.toon))
- The mandatory docstring gate could skip its own scan and still exit zero ([pm-jira-5vse](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-5vse.toon))

### Other

- Adopt the canonical pm-ops docstring gate ([pm-jira-j6sr](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-j6sr.toon))

## 2026.8.7 - 2026-08-07

### Other

- Gate CI on strict tracked pm project health ([pm-jira-zyst](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-zyst.toon))

## 2026.8.4 - 2026-08-04

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-jira-w72d](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-w72d.toon))

## 2026.7.31 - 2026-07-31

### Fixed

- Release commits discard the rebuilt dist, so the git-install path serves the previous version ([pm-jira-1zhr](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-1zhr.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-jira-yp5b](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-yp5b.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-jira-fzdq](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-fzdq.toon))

## 2026.7.28 - 2026-07-28

### Other

- Adopt pm-cli 2026.7.28 and migrate activation tests to the real SDK harness ([pm-jira-ptod](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-ptod.toon))
- Eliminate the last source any with real SDK handler context types ([pm-jira-edv0](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-edv0.toon))
- Adopt pm-cli 2026.7.27 ([pm-jira-qmt4](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-qmt4.toon))

## 2026.7.27 - 2026-07-27

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([pm-jira-1k78](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-1k78.toon))

### Other

- Exclude generated dist output from DeepScan static analysis ([pm-jira-s11o](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-s11o.toon))

## 2026.7.26 - 2026-07-26

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-jira-e4q3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-e4q3.toon))

## 2026.7.25 - 2026-07-25

### Fixed

- pm item reads are capped at Node's 1 MiB spawnSync default, so a mature tracker fails with no diagnosis ([pm-jira-x4nd](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-x4nd.toon))

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-jira-jwh2](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-jwh2.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-jira-xa9c](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-xa9c.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-jira-pzau](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-pzau.toon))

## 2026.7.20-1 - 2026-07-20

### Added

- adopt commitItemMutations for atomic import ([pm-jira-c5vc](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-c5vc.toon))

## 2026.7.13-1 - 2026-07-13

### Fixed

- Route jira export dry-run preview to stderr + return payloads so stdout stays valid JSON ([pm-jira-rhyu](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-rhyu.toon))

## 2026.7.11 - 2026-07-11

### Added

- Publish/review loop for pm-jira feat/agent-enhancement-pass ([pm-jira-326a](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-326a.toon))
- Full pm ecosystem production pass for pm-jira ([pm-jira-1soq](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-1soq.toon))

### Fixed

- Export --push aborts the whole batch on the first failed item ([pm-jira-58ev](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-58ev.toon))

### Other

- Ecosystem release readiness pass 2026-07-06 ([pm-jira-8r0w](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-8r0w.toon))
- Adversarial review: clean pass, no defects found ([pm-jira-pz02](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-pz02.toon))
- Full-cycle hardening wave: pm-jira ([pm-jira-122e](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-122e.toon))
- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-jira-h1vn](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-h1vn.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-jira-lts0](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-lts0.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-jira-1qmd](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-1qmd.toon))
- Regenerate CHANGELOG after pm close item ([pm-jira-0ygy](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-0ygy.toon))

## 2026.6.13 - 2026-06-13

### Other

- Daily Release publish step runs prepublishOnly post-tag: align npm publish with --ignore-scripts ([pm-jira-elhd](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-elhd.toon))

## 2026.6.8 - 2026-06-08

### Added

- Import Jira components and sprint context tags ([pm-jira-6r7i](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-6r7i.toon))

### Other

- Harden release readiness checks ([pm-jira-tsju](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-tsju.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-jira-5y0r](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/chores/pm-jira-5y0r.toon))

## 2026.6.4-1 - 2026-06-04

### Added

- preflight: fail-fast Jira credential validation gate ([pm-jira-t867](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-t867.toon))

## 2026.6.4 - 2026-06-04

### Other

- Export --update-existing PUT + import progress and attachment/comment transparency ([pm-jira-yhm3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-yhm3.toon))

## 2026.6.3 - 2026-06-03

### Added

- pm-jira: deepen filters/dry-run/field-mapping/validate/hooks (enhancement brief 2026-06-03) ([pm-jira-i7fd](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-i7fd.toon))
- pm-jira: domain-max SDK enhancement (idempotent import, preflight, rate-limit backoff) ([pm-jira-4804](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-4804.toon))
- export-on-write hook (opt-in) + add 'hooks' capability ([pm-jira-65ao](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-65ao.toon))

### Changed

- Idempotent import: match on Jira key, update instead of duplicate; persist jira_key/jira_url ([pm-jira-3b0b](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-3b0b.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-jira-fc13](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-fc13.toon))
- preflight capability: pm jira preflight command + registerPreflight guard ([pm-jira-vfb3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-vfb3.toon))
- Robustness: 429/503 rate-limit backoff + Retry-After on GET/POST ([pm-jira-2up8](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-2up8.toon))
- manifest capabilities correctness + README + tests + functional verification ([pm-jira-lu1f](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-lu1f.toon))
- Filters: --assignee augments default JQL ([pm-jira-ia8o](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-ia8o.toon))
- Decision: what needs live Jira creds (not exercisable here) ([pm-jira-49oh](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-49oh.toon))
- Decision: hook policy (best-effort, opt-in, no auto-push) ([pm-jira-h5wu](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-h5wu.toon))
- Decision: field-mapping model ([pm-jira-7y1y](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-7y1y.toon))
- Manifest capability correctness + README ([pm-jira-wsn0](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-wsn0.toon))
- pm jira validate diagnostics (--json, no secret leak) ([pm-jira-4dfb](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-4dfb.toon))
- Field-mapping depth + --map override (both directions) ([pm-jira-7bmf](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-7bmf.toon))
- --dry-run on import AND export (no-network), with strace proof ([pm-jira-4r5q](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-4r5q.toon))
- JQL builder + convenience filters (--assignee/--issue-type/--label/--updated-since) ([pm-jira-ko1c](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-ko1c.toon))

## 2026.6.2 - 2026-06-02

### Added

- Adopt full SDK surface: jira import/export + schema fields + flags ([pm-jira-27sk](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-27sk.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- jira sync threw plain Error (no exitCode) → runtime double-invocation ([pm-jira-6cr5](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-6cr5.toon))

## 2026.5.29-1 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-jira-xfd9](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-xfd9.toon))

### Fixed

- description (ADF) and priority fetched but never written to pm items ([pm-jira-1aqg](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-1aqg.toon))
- sync failures return {success:false} instead of throwing -\> exit code 0 ([pm-jira-lk24](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-lk24.toon))
- dry-run/max-results flags read kebab keys; --dry-run silently writes ([pm-jira-dhsn](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-dhsn.toon))

## 2026.5.29 - 2026-05-29

### Added

- Production-harden jira sync command ([pm-jira-rjp3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-rjp3.toon))

### Fixed

- --dry-run silently wrote items instead of previewing ([pm-jira-w6m3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-w6m3.toon))
- --max-results ignored (always 500) ([pm-jira-y758](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-y758.toon))
- Failures exited 0 (missing creds / no project / fetch error) ([pm-jira-rb98](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-rb98.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-jira-zm0z](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-zm0z.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-jira-iycb](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-iycb.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-jira-469v](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-469v.toon))

### Other

- Release readiness hardening for pm-jira ([pm-jira-5d71](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-5d71.toon))
