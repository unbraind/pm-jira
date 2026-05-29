# Changelog

## 2026.05.29-1 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-jira-xfd9](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-xfd9.toon))

### Other

- description \(ADF\) and priority fetched but never written to pm items ([pm-jira-1aqg](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-1aqg.toon))
- sync failures return {success:false} instead of throwing -\> exit code 0 ([pm-jira-lk24](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-lk24.toon))
- dry-run/max-results flags read kebab keys; --dry-run silently writes ([pm-jira-dhsn](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/issues/pm-jira-dhsn.toon))

## 2026.05.29 - 2026-05-29

### Added

- Production-harden jira sync command ([pm-jira-rjp3](https://github.com/unbraind/pm-jira/blob/main/.agents/pm/features/pm-jira-rjp3.toon))

### Other

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
