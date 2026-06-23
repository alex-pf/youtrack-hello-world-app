# Hello World — YouTrack Dashboard Widget

A simple "Hello World" dashboard widget for YouTrack.

## Prerequisites

- Node.js 20+
- npm
- YouTrack 2024.3+

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The built app is output to the `dist/` directory.

## Upload to YouTrack

### Via CLI

```bash
npm run upload -- --host https://your-youtrack.example.com --token YOUR_PERMANENT_TOKEN
```

Or set environment variables:

```bash
export YOUTRACK_HOST=https://your-youtrack.example.com
export YOUTRACK_API_TOKEN=YOUR_PERMANENT_TOKEN
npm run upload
```

### Via ZIP

```bash
npm run pack
```

Then upload `hello-world-app.zip` via YouTrack Administration → Apps → Add app → Upload ZIP file.

## CI/CD

The GitHub Actions workflow (`.github/workflows/deploy.yml`) automatically builds and deploys the app on push to `main`.

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `YOUTRACK_STAGING_HOST` | URL of your staging YouTrack instance |
| `YOUTRACK_STAGING_TOKEN` | Permanent token for staging |
| `YOUTRACK_PRODUCTION_HOST` | URL of your production YouTrack instance |
| `YOUTRACK_PRODUCTION_TOKEN` | Permanent token for production |

### Environments

- **Staging** — deploys automatically on push to `main`
- **Production** — deploys after staging succeeds (can be gated with environment protection rules)
---------------
## Issues Progress Widget

### Overview
The **Issues Progress & Lead Time Tracker** widget displays a horizontal Gantt-style chart showing how long each issue has spent in each workflow status. It helps teams identify bottlenecks and track lead time compliance.

### Features
- **Gantt chart**: Each issue is a horizontal bar divided into colored segments representing time spent in each status
- **Lead Time zones**: Optional background color zones (green/yellow/red) based on configurable LT 50% and LT 80% thresholds per issue type
- **Estimate Date history**: Optional vertical tick marks showing when the estimated date was changed, with tooltips showing the full change log
- **Clickable issue IDs**: Each issue ID on the Y-axis links directly to the issue in YouTrack
- **Auto-refresh**: Configurable refresh interval (15 min to 2 hours)
- **Adaptive layout**: Vertical scroll for many issues; horizontal scroll when widget is narrow

### Configuration
| Setting | Description |
|---|---|
| **Query Filter** | YouTrack search query to select issues (e.g., `project: MyProject State: {In Progress}`) |
| **Project Selector** | Select one or more projects to load available statuses and issue types |
| **Status Sorter** | Choose which statuses to display and set their order (left to right in the chart) |
| **Lead Time Settings** | Enable LT thresholds and set LT 50% / LT 80% values (in days) per issue type |
| **Show Estimate Date** | Toggle display of estimate date change history as tick marks on the bars |
| **Refresh Rate** | How often the widget auto-refreshes data (0 = manual only) |

### How it works
1. The widget fetches all issues matching the query
2. For each issue, it loads the full activity history (`/api/issues/{id}/activities`)
3. State change events are parsed to calculate time spent in each status
4. Estimate date change events are parsed and deduplicated (one tick per day)
5. The D3.js chart renders the data as a horizontal Gantt chart

### Performance notes
- Activity history is loaded sequentially with 100ms delays between requests to avoid rate limits
- For large issue sets (100+), initial load may take 10–30 seconds
- Use specific queries to limit the issue set for better performance