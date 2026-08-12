# Notifitra

**A self-hostable, unified notification API.** One endpoint to send email, SMS, push, and webhook notifications — with templating, automatic retries, and full delivery logs built in.

```
POST /v1/notifications
{
  "channel": "email",
  "to": "user@example.com",
  "template": "welcome",
  "data": { "name": "Alex" }
}
```

No more rebuilding the same "send this, retry on failure, log what happened" plumbing on every project.

---

## Table of Contents

- [Why Notifitra](#why-notifitra)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Local Setup](#local-setup)
  - [Environment Variables](#environment-variables)
- [Usage](#usage)
  - [Sending a Notification](#sending-a-notification)
  - [Templates](#templates)
  - [API Keys & Scopes](#api-keys--scopes)
- [API Reference](#api-reference)
- [Providers](#providers)
- [Database Schema](#database-schema)
- [Deployment](#deployment)
- [Testing](#testing)
- [Security](#security)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why Notifitra

Every project ends up needing to send notifications somewhere — a signup email, a webhook alert, a push notification when something changes. Most of the time, that logic gets rebuilt (badly) inline: no retries, no delivery visibility, provider-specific code scattered across the codebase.

Notifitra is a small, self-hostable service that sits between your app and the actual notification providers. You send it one request in a consistent shape; it handles templating, queuing, retries with backoff, and keeps a full delivery log — regardless of which channel or provider is behind it.

It's designed to run comfortably on free-tier infrastructure for personal projects and small apps, and to be genuinely reusable across everything else you build.

## Features

- **Unified API** — one request shape (`POST /v1/notifications`) across email, webhook, and push channels
- **Pluggable provider adapters** — swap providers (SMTP, Resend, ntfy, custom webhooks) without touching calling code
- **Templating** — Handlebars-style templates with variables, versioned per template
- **Reliable delivery** — automatic retries with exponential backoff, dead-letter queue for permanent failures
- **Full observability** — every send and every delivery attempt is logged and queryable
- **Scoped API keys** — per-key channel permissions and rate limits
- **Self-hostable** — runs anywhere Docker runs; no vendor lock-in

## Architecture

```
                    ┌─────────────┐
  Client apps  ───► │   REST API   │  validate + template + enqueue
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Redis queue │  (BullMQ)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Workers    │  dispatch to provider adapters
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
          ┌───────┐   ┌─────────┐  ┌─────────┐
          │ Email │   │ Webhook │  │  Push   │
          │adapter│   │ adapter │  │ adapter │
          └───────┘   └─────────┘  └─────────┘
                           │
                    ┌──────▼──────┐
                    │  PostgreSQL  │  keys, templates, logs, attempts
                    └─────────────┘
```

**Flow:** a request hits the API → gets validated against the API key's scopes → the template is rendered with the supplied data → the job is enqueued in Redis via BullMQ → a worker picks it up and dispatches it through the relevant provider adapter → the outcome (success, retry, or permanent failure) is recorded in Postgres.

Workers and the API are separate processes so the API stays responsive even under a backlog, and workers can be scaled independently.

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (Node.js) |
| API framework | [Hono](https://hono.dev) |
| Queue | [BullMQ](https://docs.bullmq.io) on Redis |
| Database | PostgreSQL |
| Templating | Handlebars |
| Email provider | Resend (free tier) or plain SMTP |
| Push provider | [ntfy](https://ntfy.sh) (free, open-source) |
| Admin dashboard | React + TypeScript |
| Testing | Vitest |

All dependencies are open-source. See [Providers](#providers) for how to swap any of them.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for local Postgres + Redis, or use hosted free tiers)
- pnpm (recommended) or npm

### Local Setup

```bash
# Clone the repo
git clone https://github.com/Lorem-Ipsum-Dev/notifitra.git
cd notifitra

# Install dependencies
pnpm install

# Start Postgres + Redis locally
docker compose up -d

# Copy environment template and fill in values
cp .env.example .env

# Run database migrations
pnpm db:migrate

# Start the API and worker in dev mode
pnpm dev
```

The API will be available at `http://localhost:3000`. The admin dashboard runs at `http://localhost:5173`.

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Yes |
| `REDIS_URL` | Redis connection string | Yes |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP credentials (if using SMTP email adapter) | Only for email |
| `RESEND_API_KEY` | Resend API key (if using Resend email adapter) | Only for email |
| `NTFY_BASE_URL` | Base URL of your ntfy instance/topic | Only for push |
| `API_KEY_SECRET` | Secret used to hash/verify API keys | Yes |
| `PORT` | Port the API listens on (default `3000`) | No |

See `.env.example` for the full list with sample values.

## Usage

### Sending a Notification

```bash
curl -X POST http://localhost:3000/v1/notifications \
  -H "Authorization: Bearer rk_live_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "email",
    "to": "user@example.com",
    "template": "welcome",
    "data": { "name": "Alex" }
  }'
```

Response:

```json
{
  "id": "ntf_01HZY...",
  "status": "queued"
}
```

You can check delivery status at any time:

```bash
curl http://localhost:3000/v1/notifications/ntf_01HZY... \
  -H "Authorization: Bearer rk_live_xxxxxxxxxxxx"
```

### Templates

Templates are created via the admin dashboard or the API, and support Handlebars-style variables:

```json
{
  "name": "welcome",
  "channel": "email",
  "subject": "Welcome, {{name}}!",
  "body": "Hi {{name}}, thanks for signing up."
}
```

Template bodies are logic-less by design (no arbitrary code execution) — this keeps them safe to accept from less-trusted sources and avoids a class of injection risk entirely.

### API Keys & Scopes

Each API key is scoped to specific channels and carries its own rate limit:

```json
{
  "name": "prod-backend",
  "scopes": ["email", "webhook"],
  "rateLimitPerMinute": 60
}
```

Keys are shown once at creation time and stored hashed — Notifitra never stores or displays a plaintext key after creation.

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/notifications` | Send a notification |
| `GET` | `/v1/notifications/:id` | Get delivery status and attempt history |
| `GET` | `/v1/notifications` | List sent notifications (paginated, filterable by channel/status) |
| `POST` | `/v1/templates` | Create a template |
| `GET` | `/v1/templates` | List templates |
| `PUT` | `/v1/templates/:id` | Update a template |
| `POST` | `/v1/keys` | Create an API key |
| `DELETE` | `/v1/keys/:id` | Revoke an API key |

Full request/response schemas are documented in [`docs/api.md`](docs/api.md) and served as an interactive OpenAPI spec at `/docs` when running locally.

## Providers

Notifitra ships with three provider adapters out of the box:

| Channel | Default provider | Notes |
|---|---|---|
| Email | Resend (free tier) or SMTP | Swap via `EMAIL_PROVIDER` env var |
| Push | ntfy (self-hostable, free) | Point `NTFY_BASE_URL` at any ntfy instance |
| Webhook | Direct HTTP relay | Target URLs must be allow-listed per key to prevent SSRF |

SMS is intentionally not included by default — there's no generous free-tier SMS provider, so shipping one would force a paid dependency into an otherwise $0 stack. The adapter interface is documented in [`docs/providers.md`](docs/providers.md) if you want to bring your own.

Adding a new provider means implementing the `NotificationAdapter` interface:

```typescript
interface NotificationAdapter {
  send(payload: RenderedNotification): Promise<DeliveryResult>;
}
```

## Database Schema

```
api_keys          (id, name, key_hash, scopes, rate_limit_per_minute, created_at)
templates         (id, name, channel, subject, body, version, created_at)
notifications     (id, api_key_id, channel, template_id, payload, status, created_at)
delivery_attempts (id, notification_id, attempt_no, status, error, attempted_at)
```

See [`docs/schema.md`](docs/schema.md) for the full DDL and an ER diagram.

## Deployment

Notifitra is designed to run for personal-scale usage:

- **API + workers** — deploy the Docker image to Render's free web service tier (or Fly.io)
- **Redis** — [Upstash](https://upstash.com) free tier
- **Postgres** — [Neon](https://neon.tech) or [Supabase](https://supabase.com) free tier
- **Admin dashboard** — static build deployed to Cloudflare Pages or Vercel

A full one-command deployment via `docker-compose.prod.yml` is provided for self-hosting on your own VPS or homelab. See [`docs/deployment.md`](docs/deployment.md) for step-by-step guides for each platform.

## Testing

```bash
# Run the full test suite
pnpm test

# Run with coverage
pnpm test:coverage

# Run only integration tests (requires local Postgres + Redis)
pnpm test:integration
```

CI runs the full suite on every pull request via GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Security

- API keys are hashed (never stored or logged in plaintext)
- Webhook destinations must be explicitly allow-listed per key to prevent server-side request forgery (SSRF)
- Templates are logic-less (Handlebars, no arbitrary code execution)
- All inputs are validated against a schema before templating or enqueueing
- Rate limiting is enforced per API key to prevent abuse

If you discover a security issue, please open a private security advisory rather than a public issue — see [`SECURITY.md`](SECURITY.md).

## Roadmap

- [ ] In-app notification channel (for apps that want a notification inbox, not just external delivery)
- [ ] Delivery analytics dashboard (send volume, failure rates over time)
- [ ] Slack and Discord provider adapters
- [ ] Bring-your-own SMS provider adapter guide

See open [issues](https://github.com/Lorem-Ipsum-Dev/notifitra/issues) for more detail and to suggest features.

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a pull request.

```bash
# Run linting and type checks before submitting
pnpm lint
pnpm typecheck
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for full guidelines.

## License

[MIT](LICENSE)
