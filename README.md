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
