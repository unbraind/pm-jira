# Changelog

## Unreleased

### Other

- Export --update-existing PUT + import progress and attachment/comment transparency ([pm-jira-yhm3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-yhm3.toon))

## 2026.06.03 - 2026-06-03

### Added

- pm-jira: deepen filters/dry-run/field-mapping/validate/hooks \(enhancement brief 2026-06-03\) ([pm-jira-i7fd](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-i7fd.toon))
- pm-jira: domain-max SDK enhancement \(idempotent import, preflight, rate-limit backoff\) ([pm-jira-4804](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-4804.toon))
- export-on-write hook \(opt-in\) + add 'hooks' capability ([pm-jira-65ao](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-65ao.toon))

### Changed

- Idempotent import: match on Jira key, update instead of duplicate; persist jira\_key/jira\_url ([pm-jira-3b0b](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-3b0b.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-jira-fc13](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-fc13.toon))
- preflight capability: pm jira preflight command + registerPreflight guard ([pm-jira-vfb3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-vfb3.toon))
- Robustness: 429/503 rate-limit backoff + Retry-After on GET/POST ([pm-jira-2up8](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-2up8.toon))
- manifest capabilities correctness + README + tests + functional verification ([pm-jira-lu1f](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-lu1f.toon))
- Filters: --assignee augments default JQL ([pm-jira-ia8o](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-ia8o.toon))
- Decision: what needs live Jira creds \(not exercisable here\) ([pm-jira-49oh](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-49oh.toon))
- Decision: hook policy \(best-effort, opt-in, no auto-push\) ([pm-jira-h5wu](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-h5wu.toon))
- Decision: field-mapping model ([pm-jira-7y1y](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-7y1y.toon))
- Manifest capability correctness + README ([pm-jira-wsn0](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-wsn0.toon))
- pm jira validate diagnostics \(--json, no secret leak\) ([pm-jira-4dfb](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-4dfb.toon))
- Field-mapping depth + --map override \(both directions\) ([pm-jira-7bmf](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-7bmf.toon))
- --dry-run on import AND export \(no-network\), with strace proof ([pm-jira-4r5q](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-4r5q.toon))
- JQL builder + convenience filters \(--assignee/--issue-type/--label/--updated-since\) ([pm-jira-ko1c](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-ko1c.toon))

## 2026.06.02 - 2026-06-02

### Added

- Adopt full SDK surface: jira import/export + schema fields + flags ([pm-jira-27sk](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-27sk.toon))

## 2026.06.01 - 2026-06-01

### Fixed

- jira sync threw plain Error \(no exitCode\) → runtime double-invocation ([pm-jira-6cr5](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-6cr5.toon))

## 2026.05.29-1 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-jira-xfd9](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-xfd9.toon))

### Fixed

- description \(ADF\) and priority fetched but never written to pm items ([pm-jira-1aqg](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-1aqg.toon))
- sync failures return {success:false} instead of throwing -\> exit code 0 ([pm-jira-lk24](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-lk24.toon))
- dry-run/max-results flags read kebab keys; --dry-run silently writes ([pm-jira-dhsn](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-dhsn.toon))

## 2026.05.29 - 2026-05-29

### Added

- Production-harden jira sync command ([pm-jira-rjp3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-rjp3.toon))

### Fixed

- --dry-run silently wrote items instead of previewing ([pm-jira-w6m3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-w6m3.toon))
- --max-results ignored \(always 500\) ([pm-jira-y758](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-y758.toon))
- Failures exited 0 \(missing creds / no project / fetch error\) ([pm-jira-rb98](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-rb98.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-jira-zm0z](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-zm0z.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-jira-iycb](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-iycb.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-jira-469v](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-469v.toon))

### Other

- Release readiness hardening for pm-jira ([pm-jira-5d71](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/tasks/pm-jira-5d71.toon))
