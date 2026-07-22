# pm-jira

A [pm-cli](https://github.com/unbraind/pm-cli) extension that syncs Jira issues into pm items using the Jira REST API v3.

## Features

- Pull issues from any Jira project into pm items via `pm jira import` or `pm jira sync`
- Export pm items back out as Jira create payloads via `pm jira export` (preview, or `--push` to create issues)
- **Convenience JQL filters** — `--project`, `--status`, `--assignee`, `--issue-type`, `--label`, `--updated-since` compose into a single JQL query (or pass full `--jql` to override)
- **Rich field mapping** — Jira status (by name, with a `statusCategory` fallback for custom workflows), priority, issue type → pm type, labels/fix-versions/components/sprints → tags, assignee → tag; configurable with `--status-map` and a general `--map jiraField=pmField`
- **`--dry-run` everywhere** — both import and export print the exact request / mutations they *would* make and perform **no network call** (the offline-testable, creds-free path)
- **`pm jira validate`** — report Jira credential/base-URL readiness without leaking any secret (hostname-only preview); `--json` aware
- **Fail-fast preflight credential gate** — a network-mutating `pm jira sync` / `pm jira import` (and `pm jira export --push`) aborts immediately with a clear, actionable message **before any pm-store read or Jira call** if `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` are missing. `--dry-run` and `pm jira validate` are exempt (offline). See [Preflight gate](#preflight-gate).
- Optional, opt-in **export-on-write hook** (`PM_JIRA_PUSH_ON_WRITE`) — best-effort, never breaks your pm command, no-op without credentials
- Jira provenance (key + browse URL) persisted in the item description and declared as `jira_key` / `jira_url` schema fields; on export, items that already carry a Jira key become an `update` (PUT) instead of a duplicate create
- Works as a `pm jira sync`/`pm jira import` command, a `pm jira export` exporter, and a config-driven `jira-sync` importer

> **Which features need live Jira credentials?** Everything except the actual network round-trip is usable and testable offline. Building JQL, previewing requests/mutations with `--dry-run`, field mapping in both directions, and `pm jira validate` all work with **no creds and no network**. You only need `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` for: a real import fetch, `pm jira export --push` (creating/updating issues), and live reachability.

## Installation

Install with pm from GitHub:

```bash
pm install github.com/unbraind/pm-jira
```

Or build locally from source:

```bash
npm ci
npm run build
```

## Jira API Setup

You need a Jira API token to authenticate. To create one:

1. Go to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a label (e.g. `pm-cli-sync`) and copy the token

## Required Environment Variables

| Variable | Description | Example |
|---|---|---|
| `JIRA_BASE_URL` | Your Jira instance base URL | `https://company.atlassian.net` |
| `JIRA_EMAIL` | Email address for your Jira account | `you@company.com` |
| `JIRA_API_TOKEN` | API token generated above | `<jira-api-token>` |

Set them in your shell or `.env`:

```bash
export JIRA_BASE_URL=https://company.atlassian.net
export JIRA_EMAIL=you@company.com
export JIRA_API_TOKEN=<jira-api-token>
```

## Usage

### Command: `pm jira sync`

```bash
# Sync all open issues from a project (default JQL: statusCategory != Done)
pm jira sync --project PROJ

# Sync up to 200 issues
pm jira sync --project PROJ --max-results 200

# Use custom JQL
pm jira sync --jql "project = PROJ AND assignee = currentUser() ORDER BY updated DESC"

# Preview without writing (dry run)
pm jira sync --project PROJ --dry-run

# Only sync issues that map to the "wip" pm status
pm jira sync --project PROJ --status wip

# Combine flags
pm jira sync --project PROJ --max-results 100 --status todo --dry-run
```

### Command / Importer: `pm jira import`

`pm jira import` is the native importer pipeline equivalent of `pm jira sync` — it
pulls issues via JQL and creates pm items. Both share the same flags and logic.

```bash
# Pull all open issues from a project
pm jira import --project PROJ

# Use a custom Jira host (instead of JIRA_BASE_URL) + custom JQL
pm jira import --host https://company.atlassian.net --jql "project = PROJ AND assignee = currentUser()"

# Override status mapping
pm jira import --project PROJ --status-map "QA=blocked,Done=closed"

# All-or-nothing atomic import (pm-cli >= 2026.7.20): one crash-recoverable
# transaction; rolls back (deletes) every create on failure; resumes on re-run.
pm jira import --project PROJ --atomic
```

### Pull flags (`pm jira sync` / `pm jira import`)

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project` | string | — | Jira project key (e.g. `PROJ`). Composed into JQL. Alias: `--project-key`. |
| `--jql` | string | — | Custom JQL query. Used verbatim; overrides all convenience filters below. |
| `--status` | string | — | Filter by pm status (`open`/`in_progress`/`closed`/`blocked`, mapped to a `statusCategory` clause) or a raw Jira status name. Also filters imported items client-side. |
| `--assignee` | string | — | Filter by assignee (accountId, name, or a function like `currentUser()`). |
| `--issue-type` | string | — | Filter by Jira issue type (e.g. `Bug`). |
| `--label` | string | — | Filter by Jira label. |
| `--updated-since` | string | — | Filter by updated date, relative (`-7d`) or absolute (`2026-01-01`). |
| `--status-map` | string | — | Override status mapping, e.g. `"In Review=in_progress,QA=blocked"`. |
| `--map` | string | — | Override field mapping, e.g. `"issuetype=Task,assignee=skip"`. Alias: `--field-map`. |
| `--host` | string | `$JIRA_BASE_URL` | Jira base URL override. |
| `--max-results` | number | `500` | Maximum number of issues to pull. |
| `--dry-run` | boolean | `false` | Print the JQL + exact GET request that would run; **no network call**. |
| `--atomic` | boolean | `false` | Import all creates in ONE all-or-nothing, crash-recoverable, workspace-writer-locked transaction via the official `commitItemMutations` SDK helper (pm-cli >= 2026.7.20). On failure every applied create is compensated (deleted) so the tracker keeps zero committed items from the import; an interrupted run resumes on re-invocation. A `--dry-run` + `--atomic` invocation previews like a normal dry-run and commits no transaction. |

When no `--jql` is given, the convenience filters are AND-combined; if you don't
filter on status, a `statusCategory != Done` clause is appended so an unscoped
pull stays focused on active work (the historical default).

#### `--map` field overrides

`--map` accepts a comma list of `jiraField=pmTarget` pairs. Recognized Jira-side
keys: `status`, `statuscategory`, `priority`, `issuetype` (alias `type`),
`labels`, `fixversions`, `components`, `sprint`/`sprints`/`customfield_10020`,
`assignee`, `duedate`. Imported tags include `component:<name>` from Jira
components and `sprint:<name>` from Jira's common Sprint custom field
(`customfield_10020`) when present; set noisy context fields to `skip` or
`ignore` to suppress them. Examples:

```bash
# Pin every imported item's type, and skip the assignee tag
pm jira import --project PROJ --map "issuetype=Task,assignee=skip"

# Keep labels but suppress sprint/component context tags
pm jira import --project PROJ --map "components=ignore,sprint=ignore"

# Force a pm status regardless of the Jira workflow state
pm jira import --project PROJ --map "status=in_progress"
```

#### Progress + transparency notes (STDERR)

For large paginated imports the importer prints `Fetched N/total...` progress to
**STDERR** after each page, so a multi-page pull surfaces feedback instead of
looking hung. This is additive and never touches the stdout / `--json` output.

If any fetched issue carries **attachments or comments**, the importer logs a
one-line note to STDERR that those are **not imported** (pm-jira imports
title / body / status / priority / labels / due-date only). This prevents a
silent expectation that attachment or comment data came across.

### Exporter: `pm jira export`

Render pm items as Jira create payloads. Prints JSON by default; with `--push`
(and credentials + `--project`) it POSTs each payload to Jira's create-issue API.

```bash
# Preview the Jira create payloads for all pm items (no network, no creds needed)
pm jira export --project PROJ

# Print the exact mutations that WOULD run (create vs update), no network/creds
pm jira export --project PROJ --dry-run

# Derive Jira issuetype + priority from each pm item's type/priority
pm jira export --project PROJ --rich --dry-run

# Actually create the issues in Jira (requires creds + --project)
pm jira export --push --project PROJ

# Also PUT changed fields back to issues that already carry a Jira key
pm jira export --push --project PROJ --update-existing

# Preview exactly what --update-existing would do (no network)
pm jira export --project PROJ --update-existing --dry-run
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project` | string | — | Target Jira project key for created issues (required for `--push`). Alias: `--project-key`. |
| `--map` | string | — | Override field mapping, e.g. `"issuetype=Story"`. Alias: `--field-map`. |
| `--rich` | boolean | `false` | Derive Jira `issuetype` + `priority` from the pm item type/priority. |
| `--update-existing` | boolean | `false` | PUT changed fields to issues that already carry a Jira key. Without it, those items are skipped (no duplicate, no mutation). |
| `--dry-run` | boolean | `false` | Print the Jira POST/PUT mutations that would run; **no network call**. |
| `--host` | string | `$JIRA_BASE_URL` | Jira base URL override. |
| `--push` | boolean | `false` | POST payloads to Jira (requires credentials + `--project`). |

Items whose description carries a `Jira <KEY>: <url>` provenance marker (added on
import) are matched back to their upstream issue and become an `update` (PUT):

- **By default** (`--push` alone) those items are **skipped** so a re-export
  never duplicates or unexpectedly mutates an existing Jira issue — only items
  without a key are created. `--dry-run` shows them as `SKIP`.
- **With `--update-existing`** each matched item is PUT to Jira's edit-issue
  endpoint (`/rest/api/3/issue/<KEY>`) with its changed fields (the immutable
  `project` field is stripped, as Jira's edit API rejects it). `--dry-run` shows
  them as `UPDATE PUT ...` so you can review the exact mutations offline first.

### Command: `pm jira validate`

Report whether pm-jira has the credentials/base URL it needs — **without making
a network call and without leaking any secret value** (it prints a hostname-only
preview, never the token or email):

```bash
pm jira validate            # human-readable readiness summary
pm jira validate --json     # structured object: { ready, baseUrlPresent, ... }
pm jira validate --host https://company.atlassian.net
```

### Preflight gate

pm-jira registers a **preflight credential gate** (pm-cli `preflight` capability /
`registerPreflight`). Before a network-mutating command runs, it checks that the
required credentials are present and, if not, **aborts immediately with a clear,
actionable error and a non-zero exit code — before any pm-store read or Jira REST
call**. This turns a deep, late failure into a fast, obvious one.

It fires **only** for these invocations:

| Invocation | Gated? |
| --- | --- |
| `pm jira sync` (no `--dry-run`) | yes — pulls over the network |
| `pm jira import` (no `--dry-run`) | yes — pulls over the network |
| `pm jira export --push` (no `--dry-run`) | yes — POSTs/PUTs to Jira |
| `pm jira sync\|import --dry-run` | no — offline preview, no creds needed |
| `pm jira export` (no `--push`) | no — prints payloads offline |
| `pm jira validate` | no — diagnostics, must run without creds |
| any other / non-pm-jira command | no |

Example (no credentials set):

```text
$ pm jira sync --project PROJ
pm-jira preflight: cannot run "pm jira sync" — missing Jira credentials:
JIRA_BASE_URL (or --host), JIRA_EMAIL, JIRA_API_TOKEN. Set JIRA_BASE_URL
(or pass --host), JIRA_EMAIL, and JIRA_API_TOKEN before a mutating command.
Create a token at https://id.atlassian.com/manage-profile/security/api-tokens .
Run "pm jira validate" to diagnose, or add --dry-run to preview offline.
# exit code 2
```

The message names only the *missing variable names* — never the token or email
value. When credentials are present the gate is a silent pass-through.

### Export-on-write hook (opt-in)

Setting `PM_JIRA_PUSH_ON_WRITE=1` activates a best-effort `onWrite` hook. It is a
strict no-op unless both the env flag is truthy **and** Jira credentials are
present, and it can never fail your `pm` command (the pm hook runtime swallows
any error). It intentionally does **not** auto-POST on every write; use the
explicit, reviewable `pm jira export --push` to mirror items upstream.

### Importer: `jira-sync` (config-driven)

Use the `jira-sync` importer in your pm-cli config for automated syncing:

```json
{
  "importers": {
    "jira-sync": {
      "project": "PROJ",
      "maxResults": 300
    }
  }
}
```

Credentials are read from environment variables or from the importer config:

```json
{
  "importers": {
    "jira-sync": {
      "JIRA_BASE_URL": "https://company.atlassian.net",
      "JIRA_EMAIL": "you@company.com",
      "JIRA_API_TOKEN": "<jira-api-token>",
      "project": "PROJ"
    }
  }
}
```

## Status Mapping

The default mapping (override per-status with `--status-map`):

| Jira Status | pm Status |
|---|---|
| To Do, Open, Backlog, (any other) | `open` |
| In Progress, In Review, In Development, Code Review | `in_progress` |
| Done, Resolved, Closed, Complete, Completed | `closed` |
| Blocked | `blocked` |

When the Jira status *name* is unrecognized (custom workflows), pm-jira falls
back to the issue's `statusCategory` bucket: `new` → `open`, `indeterminate` →
`in_progress`, `done` → `closed`.

### Issue type mapping

| Jira Issue Type | pm Type |
|---|---|
| Bug, Defect | `Bug` |
| Story, Epic | `Feature` |
| Task, Sub-task | `Task` |
| (any other) | `Issue` |

Override with `--map issuetype=<pmType>` (import) or `--map issuetype=<jiraType>`
(export, with `--rich`).

## Priority Mapping

| Jira Priority | pm Priority |
|---|---|
| Highest, Critical | `1` (highest) |
| High | `2` |
| Medium, (any other) | `3` |
| Low, Lowest | `4` (lowest) |

## Item Structure

Each imported item includes:

- **title**: `[PROJ-123] Issue summary`
- **body**: Issue description (converted from Atlassian Document Format to plain text)
- **description**: A provenance marker `Jira PROJ-123: https://…/browse/PROJ-123` so the
  Jira key + URL survive round-trips and power `pm jira export`. The extension also
  declares `jira_key` and `jira_url` as optional item schema fields (capability `schema`).
- **status**: Mapped from Jira status (see table above)
- **priority**: Mapped from Jira priority (see table above)
- **tags**: Jira labels + fix version names
- **deadline**: Jira due date (`YYYY-MM-DD`), if set

> Note: pm's `create` has no generic custom-field setter for a standalone extension, so
> provenance is stored in the description marker rather than as structured metadata.

## JQL Examples

```
# All open issues in a project, by priority
project = PROJ AND statusCategory != Done ORDER BY priority ASC

# Only issues assigned to you
project = PROJ AND assignee = currentUser()

# Issues updated in the last 7 days
project = PROJ AND updated >= -7d ORDER BY updated DESC

# Issues in a specific sprint
project = PROJ AND sprint in openSprints()

# Issues with a specific label
project = PROJ AND labels = "backend"

# Issues by type
project = PROJ AND issuetype = Bug AND statusCategory != Done
```

## Development

```bash
# Install dev dependencies
npm install

# Build TypeScript
npm run build

# Watch mode
npm run dev
```

### Multi-agent merge safety

This repo tracks its own project management in `.agents/pm/` and ships a committed
`.gitattributes` that maps those tracker artifacts to pm-cli's field-aware Git merge
drivers, so concurrent-branch tracker edits merge cleanly instead of hard-conflicting.

The driver **definitions** live in per-clone Git config, so each clone must wire them
once. `npm install` / `npm ci` does this automatically via the `prepare` script
(a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs `pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so production / `--omit=dev` installs are not broken; being Node-based it behaves identically on POSIX shells and Windows `cmd.exe`); to (re)run it manually:

```bash
npm run merge:install    # or: pm merge install
```

After merging a branch that touched `.agents/pm/`, run `pm history-repair --all` to
reconcile history verification.

## Requirements

- Node.js `>=22.18.0` (uses native `https` module and `Buffer`)
- pm-cli `>=2026.7.5`
- TypeScript 6.x (dev dependency)

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
