# pm-jira

A [pm-cli](https://github.com/unbraind/pm-cli) extension that syncs Jira issues into pm items using the Jira REST API v3.

## Features

- Pull issues from any Jira project into pm items via `pm jira import` or `pm jira sync`
- Export pm items back out as Jira create payloads via `pm jira export` (preview, or `--push` to create issues)
- Custom JQL support for fine-grained control over what gets pulled
- Automatic mapping of Jira statuses and priorities to pm equivalents, with a `--status-map` override
- Labels and fix versions mapped as pm tags
- Jira provenance (key + browse URL) persisted in the item description and declared as `jira_key` / `jira_url` schema fields
- Dry-run mode to preview changes before writing
- Works as a `pm jira sync`/`pm jira import` command, a `pm jira export` exporter, and a config-driven `jira-sync` importer

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
```

### Pull flags (`pm jira sync` / `pm jira import`)

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project` | string | — | Jira project key (e.g. `PROJ`). Used to build default JQL. |
| `--jql` | string | — | Custom JQL query. Overrides `--project` default JQL. |
| `--host` | string | `$JIRA_BASE_URL` | Jira base URL override. |
| `--max-results` | number | `500` | Maximum number of issues to pull. |
| `--status` | string | — | Filter by mapped pm status (`open`, `in_progress`, `closed`, `blocked`). |
| `--status-map` | string | — | Override mapping, e.g. `"In Review=in_progress,QA=blocked"`. |
| `--dry-run` | boolean | `false` | Preview what would be created without writing. |

### Exporter: `pm jira export`

Render pm items as Jira create payloads. Prints JSON by default; with `--push`
(and credentials + `--project`) it POSTs each payload to Jira's create-issue API.

```bash
# Preview the Jira create payloads for all pm items (no network, no creds needed)
pm jira export --project PROJ

# Actually create the issues in Jira (requires creds + --project)
pm jira export --push --project PROJ
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project` | string | — | Target Jira project key for created issues (required for `--push`). |
| `--host` | string | `$JIRA_BASE_URL` | Jira base URL override. |
| `--push` | boolean | `false` | POST payloads to Jira (requires credentials + `--project`). |

Items whose description carries a `Jira <KEY>: <url>` provenance marker (added on
import) can be matched back to their upstream issue.

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

## Requirements

- Node.js 18+ (uses native `https` module and `Buffer`)
- pm-cli `>=2026.5.0`
- TypeScript 5.x (dev dependency)

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
