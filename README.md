# pm-ext-jira

A [pm-cli](https://github.com/unbraind/pm-cli) extension that syncs Jira issues into pm items using the Jira REST API v3.

## Features

- Sync issues from any Jira project into pm items with full deduplication
- Custom JQL support for fine-grained control over what gets synced
- Automatic mapping of Jira statuses and priorities to pm equivalents
- Labels and fix versions mapped as pm tags
- Dry-run mode to preview changes before writing
- Works as both a `pm jira sync` command and a `jira-sync` importer

## Installation

Place the extension directory (or its built `dist/`) in your pm-cli extensions folder, or reference it in your pm-cli config.

```bash
# Build from source
npm install
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
| `JIRA_API_TOKEN` | API token generated above | `ATATT3x...` |

Set them in your shell or `.env`:

```bash
export JIRA_BASE_URL=https://company.atlassian.net
export JIRA_EMAIL=you@company.com
export JIRA_API_TOKEN=ATATT3xFfGF0...
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

### Flags

| Flag | Alias | Type | Default | Description |
|---|---|---|---|---|
| `--project` | `-p` | string | — | Jira project key (e.g. `PROJ`). Used to build default JQL. |
| `--jql` | `-q` | string | — | Custom JQL query. Overrides `--project` default JQL. |
| `--max-results` | `-n` | number | `500` | Maximum number of issues to sync. |
| `--dry-run` | — | boolean | `false` | Preview what would be synced without writing. |
| `--status` | `-s` | string | — | Filter by mapped pm status (`todo`, `wip`, `done`, `blocked`). |

### Importer: `jira-sync`

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
      "JIRA_API_TOKEN": "ATATT3x...",
      "project": "PROJ"
    }
  }
}
```

## Status Mapping

| Jira Status | pm Status |
|---|---|
| To Do, Open, Backlog, (any other) | `todo` |
| In Progress, In Review, In Development, Code Review | `wip` |
| Done, Resolved, Closed, Complete, Completed | `done` |
| Blocked | `blocked` |

## Priority Mapping

| Jira Priority | pm Priority |
|---|---|
| Highest, Critical | `1` (highest) |
| High | `2` |
| Medium, (any other) | `3` |
| Low, Lowest | `4` (lowest) |

## Item Structure

Each synced item uses `${PROJECT}-${NUMBER}` as the idSuffix for deduplication (e.g. `PROJ-123`). Running sync again updates existing items rather than creating duplicates.

Items include:

- **title**: `[PROJ-123] Issue summary`
- **body**: Issue description (converted from Atlassian Document Format to plain text)
- **status**: Mapped from Jira status (see table above)
- **priority**: Mapped from Jira priority (see table above)
- **tags**: Jira labels + fix version names
- **meta.jira_key**: Original Jira issue key (e.g. `PROJ-123`)
- **meta.jira_project**: Jira project key (e.g. `PROJ`)
- **meta.jira_assignee**: Assignee display name (if set)
- **meta.jira_duedate**: Due date in `YYYY-MM-DD` format (if set)

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
