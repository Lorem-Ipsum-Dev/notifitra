# Notifitra — Complete Implementation Plan

**A self-hostable, unified notification API — from zero to production.**

This document is the single source of truth for building Notifitra. Work through it top to bottom, checking boxes as you go. Every phase states its objective, tasks, deliverables, definition of done, dependencies, risks, and how to verify the work.

---

## 0. Project Understanding

### 0.1 What Notifitra is (from the README)

A self-hostable service that sits between client apps and notification providers (email, push, webhook — SMS explicitly deferred). One request shape (`POST /v1/notifications`) triggers templating → queuing (BullMQ/Redis) → dispatch via a provider adapter → logging of the outcome in PostgreSQL. Scoped, hashed API keys gate access. Designed to run on free-tier infrastructure.

### 0.2 Functional requirements (derived from README)

- Send a notification via `POST /v1/notifications` (channel, recipient, template, data).
- Query notification status and delivery-attempt history (`GET /v1/notifications/:id`).
- List/filter/paginate notifications (`GET /v1/notifications`).
- CRUD for templates (Handlebars-style, versioned, logic-less).
- Create/revoke scoped API keys with per-key rate limits.
- Pluggable adapters for email (Resend/SMTP), push (ntfy), webhook (direct HTTP relay, allow-listed targets).
- Automatic retries with exponential backoff; dead-letter queue for permanent failures.
- Full observability: every send and every attempt logged and queryable.
- Admin dashboard (React) for templates, keys, logs.
- OpenAPI docs served at `/docs`.

### 0.3 Non-functional requirements (derived + implied)

- Self-hostable via Docker, runnable on free-tier infra (Render/Fly.io + Upstash + Neon/Supabase + Cloudflare Pages/Vercel).
- API and workers are separate, independently scalable processes.
- Security: hashed keys, SSRF-safe webhook allow-listing, logic-less templates, input validation, per-key rate limiting.
- Low operational cost — no paid dependency required to run the core stack.
- TypeScript throughout; Vitest for testing; CI on every PR.

### 0.4 Ambiguous or missing requirements — Adopted Decisions

These were originally ambiguous/underspecified in the README. Rather than leaving them open, **all recommended defaults below have been adopted** as the decisions this plan builds on. Each is still recorded explicitly (not silently assumed) so it can be revisited deliberately if it turns out to be wrong — this table is a living record, not a one-time note.

| # | Question | **Adopted decision** |
|---|---|---|
| 1 | Auth model for the **admin dashboard** itself (README only covers API-key auth for the notification API) | Simple single-tenant login (email+password or magic link) behind a `.env`-configured admin account for v1; multi-user RBAC deferred |
| 2 | Multi-tenancy — is this single-org self-hosted, or does one deployment serve multiple customers? | **Single-tenant per deployment** (matches "self-hostable for personal projects/small apps" framing). Revisit only if multi-tenant SaaS becomes the actual goal |
| 3 | Push notification target model — ntfy is topic-based, not per-device-token. How does a "push to user X" map to an ntfy topic? | Notification payload carries an explicit `ntfyTopic` (or a topic derived from a stored per-recipient mapping) |
| 4 | Idempotency — can the same `POST /v1/notifications` be safely retried by the caller without double-sending? | Optional `Idempotency-Key` header, with a dedup window in Postgres (24h) |
| 5 | Multi-recipient sends (batch) — README shows only single `to` | Out of scope for v1; tracked as a roadmap item |
| 6 | Template versioning semantics — does sending reference "latest" or a pinned version? | Latest published version by default, unless `templateVersion` is explicitly passed |
| 7 | Webhook retry semantics on non-2xx vs timeout vs 4xx | Retry on 5xx/timeout/network error; do **not** retry on 4xx (treated as permanent failure) |
| 8 | Data retention for delivery logs / PII in `payload` | Retain 90 days, configurable; document what PII the `data` field may legally contain |
| 9 | Dead-letter queue — is there a UI/API to inspect and manually replay it? | v1: queryable via API + dashboard view; manual "replay" button deferred as a fast-follow, not launch-blocking |
| 10 | Multi-region / high availability | Explicitly out of scope — single-region free-tier deployment per README's stated goals |

### 0.5 Technical risks & blockers

| Risk | Impact | Mitigation |
|---|---|---|
| Free-tier services (Upstash, Neon/Supabase, Render/Fly) have connection, cold-start, or throughput limits | Queue backlogs, cold-start latency, dropped connections | Load-test against free-tier limits early (Phase 9); use connection pooling (PgBouncer/Neon pooler); document limits in `docs/deployment.md` |
| Render/Fly free web services sleep on inactivity | Delayed first response, missed worker ticks | Confirm acceptable for target use case; consider a lightweight external cron ping if not |
| BullMQ requires a persistent Redis connection; Upstash free tier has connection-count caps | Worker instability under load | Keep worker pool small and singleton in v1; monitor connection count |
| SSRF via webhook adapter if allow-listing is implemented incorrectly | Security incident | Strict allow-list validation at key-creation time AND at send time; block private/link-local IP ranges even if a hostname resolves there (DNS rebinding) |
| Handlebars template injection if "logic-less" isn't actually enforced (helpers, partials) | Server-side template injection / RCE-adjacent risk | Explicitly disable custom helpers/partials; compile with a locked-down Handlebars environment; sandbox or use a stricter engine if needed |
| Resend/SMTP/ntfy provider outages | Delivery failures | Retry + DLQ already covers this; alert on DLQ growth |
| Secrets sprawl across `.env`, Render/Fly, Vercel/Cloudflare | Leaked credentials | Centralize secret documentation, use each platform's secret manager, never commit `.env` |
| Rate limiting implemented naively (in-memory) won't work across multiple API instances | Bypassable rate limits | Use Redis-backed rate limiting (you already have Redis) |

### 0.6 Guiding principle

This plan **does not redesign** the project. It follows the README's architecture (Hono + BullMQ + Redis + Postgres + Handlebars + React admin) as given. Any deviation is called out explicitly with a reason.

---

## 1. Architectural & Technical Decisions

> Format: chosen solution → why → alternatives considered → why not → trade-offs → when to reconsider.

### Decision: TypeScript (Node.js) as the language

**Chosen solution:** TypeScript on Node.js 20+

**Why?** Already specified in the README; single language across API, workers, and admin dashboard reduces context switching for a small team; strong ecosystem for Hono/BullMQ/Prisma-style tooling; static typing catches schema/payload mismatches before runtime, which matters for a system whose whole job is validating and routing structured payloads.

**Alternatives considered:** Go, Python (FastAPI), Elixir (Phoenix).

**Why not the alternatives?** Go/Elixir would give better raw concurrency for a queue-heavy system, but at the cost of a second language for the React dashboard and a smaller pool of pluggable-adapter examples to draw from. Python is fine but weaker typing story for a project whose core value proposition is "reliable, well-typed request/response contracts."

**Trade-offs:** Node's single-threaded event loop is fine here because the heavy lifting (provider calls) is I/O-bound, not CPU-bound.

**When would we reconsider?** If notification volume grows into the "millions/day, CPU-bound templating" territory — unlikely for the stated free-tier/personal-project audience.

### Decision: Hono as the API framework

**Chosen solution:** Hono

**Why?** Specified in README; extremely lightweight, fast, first-class TypeScript support, runs on Node but is also portable to edge runtimes if you ever want to split the API onto Cloudflare Workers.

**Alternatives considered:** Express, Fastify, NestJS.

**Why not the alternatives?** Express is heavier and less type-safe by default. NestJS brings a lot of structure/DI machinery this project doesn't need at its current scale — over-engineering for a single-service API. Fastify is a reasonable alternative but Hono's portability and minimal footprint fit the "runs comfortably on free-tier infra" goal better.

**Trade-offs:** Smaller plugin ecosystem than Express; you'll write a bit more glue code (e.g., validation middleware) yourself.

**When would we reconsider?** If the project needs heavy DI/module structure as it grows multiple bounded contexts — not expected here.

### Decision: PostgreSQL as the database

**Chosen solution:** PostgreSQL (via Neon or Supabase free tier)

**Why?** Specified in README; relational structure fits the domain exactly (`api_keys`, `templates`, `notifications`, `delivery_attempts` are naturally relational with foreign keys); strong free-tier hosted options; mature migration tooling.

**Alternatives considered:** MySQL, SQLite, MongoDB.

**Why not the alternatives?** SQLite doesn't support the concurrent-write, hosted-multi-instance model needed once workers and API scale independently. MongoDB's document model adds nothing here — the data is inherently relational (foreign keys, joins for delivery history) and you'd lose transactional guarantees around attempt-logging. MySQL is a viable alternative but Postgres's JSONB support (useful for storing arbitrary `payload`/`data`) and the strength of the free-tier hosts (Neon, Supabase) tip the decision.

**Trade-offs:** Slightly heavier than SQLite for pure local dev, but Docker Compose neutralizes that.

**When would we reconsider?** Only if a future feature needs genuinely schema-less storage at scale — not indicated here.

### Decision: Redis + BullMQ for queueing

**Chosen solution:** BullMQ on Redis (Upstash free tier)

**Why?** Specified in README; BullMQ is the de facto standard for Node job queues, gives retries/backoff/DLQ out of the box (exactly the reliability features the README promises), and Upstash's serverless Redis fits the free-tier requirement.

**Alternatives considered:** RabbitMQ, AWS SQS, in-process cron/interval polling, pg-boss (Postgres-backed queue).

**Why not the alternatives?** RabbitMQ/SQS add infra/cost complexity disproportionate to the stated scale. In-process polling has no durability across restarts and no free horizontal scaling story. **pg-boss is a legitimate simpler alternative** (one less moving part — no Redis at all, queue lives in Postgres) and is worth a second look if you want to reduce infrastructure surface area; it's flagged here as a valid "avoid over-engineering" substitution, but the plan below follows the README's Redis/BullMQ choice since it was explicitly specified.

**Trade-offs:** Adds a second infra dependency (Redis) beyond Postgres. Upstash free tier has request/connection caps to watch (see Risks).

**When would we reconsider?** If you want to shed the Redis dependency entirely for a truly minimal single-Postgres stack, swap to pg-boss — this is a clean, low-risk substitution if it comes up later.

### Decision: Handlebars for templating

**Chosen solution:** Handlebars, logic-less, no custom helpers/partials enabled

**Why?** Specified in README; explicitly chosen because it can't execute arbitrary code, which matters since templates may be created by less-trusted callers.

**Alternatives considered:** EJS, Liquid, Mustache, string interpolation.

**Why not the alternatives?** EJS allows embedded JS — direct code-execution risk, unacceptable for a multi-tenant-ish template store. Liquid is a reasonable, equally "logic-less" alternative but Handlebars is already specified and has a larger TS ecosystem. Mustache is stricter still (no conditionals at all) — Handlebars' constrained conditionals/loops are the right amount of power without opening code execution.

**Trade-offs:** Must actively lock down the Handlebars runtime (disable `require`-based helpers, restrict to a safe built-in helper set) or the "no code execution" guarantee is just a README claim, not a fact.

**When would we reconsider?** Not expected to change.

### Decision: Single repo (monorepo) vs separate repos

**Chosen solution:** Monorepo (pnpm workspaces) with `apps/api`, `apps/worker`, `apps/dashboard`, `packages/shared` (types, adapter interfaces, validation schemas)

**Why?** API and worker share types (job payloads, `NotificationAdapter` interface) and the dashboard shares API contracts — a monorepo lets you change a shared type once and get compile errors everywhere it's inconsistent, which is exactly the safety net you want in a system built around a strict request/response contract.

**Alternatives considered:** Separate repos per service.

**Why not the alternatives?** Separate repos would require publishing/versioning a shared types package for a 2–3 person project — pure overhead at this scale.

**Trade-offs:** Slightly more complex CI matrix (need to build/test each workspace); mitigated with pnpm workspace filters in CI.

**When would we reconsider?** If the dashboard is ever spun out to a fully separate team/release cadence.

### Decision: REST over GraphQL

**Chosen solution:** REST (as specified in README's API reference table)

**Why?** The API surface is small and resource-shaped (`notifications`, `templates`, `keys`) — REST maps directly onto it with no over-fetching problem to solve. OpenAPI spec generation (already planned at `/docs`) gives typed clients for free.

**Alternatives considered:** GraphQL.

**Why not GraphQL?** GraphQL earns its complexity when clients need flexible, nested queries across many resource types — not the case for a handful of flat, well-known endpoints. Would be pure over-engineering here.

**Trade-offs:** None significant at this scale.

**When would we reconsider?** If a future dashboard needs deeply nested, client-driven queries across many linked entities.

### Decision: Docker + docker-compose for local & deployment

**Chosen solution:** Docker for local dev (Postgres+Redis via compose) and a `docker-compose.prod.yml` for self-hosted VPS/homelab deployment, plus a plain Docker image for PaaS deployment (Render/Fly).

**Why?** Specified in README; guarantees local/prod parity for the two stateful dependencies without requiring every contributor to install Postgres/Redis natively.

**Alternatives considered:** Kubernetes, Nix, native local installs.

**Why not the alternatives?** Kubernetes is explicitly over-engineering for this scale (see §11) — no multi-node orchestration need exists. Nix is a valid but niche choice that raises the contributor bar unnecessarily. Native installs break "runs anywhere Docker runs" portability.

**Trade-offs:** Docker Desktop resource usage on contributor machines; acceptable.

**When would we reconsider?** If the project needs to run at a scale requiring actual orchestration — not indicated.

### Decision: Hosting — Render/Fly.io (API+workers), Upstash (Redis), Neon/Supabase (Postgres), Cloudflare Pages/Vercel (dashboard)

**Chosen solution:** As specified in README.

**Why?** Each choice has a genuinely usable free tier, and splitting stateless compute (Render/Fly) from managed stateful services (Upstash, Neon/Supabase) is the standard, low-maintenance pattern for this scale — you don't manage backups/HA for Postgres/Redis yourself.

**Alternatives considered:** Single VPS running everything; AWS (RDS/ElastiCache/ECS); Heroku.

**Why not the alternatives?** A single VPS is actually offered as the self-hosting path (`docker-compose.prod.yml`) for those who want it — it's not excluded, just not the default recommendation, because it adds ops burden (patching, backups, TLS renewal) the managed free tiers handle for you. AWS is disproportionately complex/costly for this scale. Heroku no longer has a meaningful free tier.

**Trade-offs:** Cold starts on free-tier PaaS; connection limits on free-tier DB/Redis (tracked in Risks).

**When would we reconsider?** If usage outgrows free tiers, or if the user explicitly wants single-VPS self-hosting — both paths are already documented, so this is a config choice, not a redesign.

### Decision: GitHub Actions for CI/CD

**Chosen solution:** GitHub Actions (specified in README)

**Why?** Free for public/small private repos, tightly integrated with the GitHub-hosted repo, no separate CI account to manage.

**Alternatives considered:** CircleCI, GitLab CI, Buildkite.

**Why not the alternatives?** All add a second platform/account for zero benefit given the repo already lives on GitHub.

**Trade-offs:** None significant.

**When would we reconsider?** If the repo ever migrates off GitHub.

### Decision: Vitest for testing

**Chosen solution:** Vitest (specified in README)

**Why?** Fast, native ESM/TS support, Jest-compatible API (low learning curve), works well with Vite-based dashboard.

**Alternatives considered:** Jest, node:test.

**Why not the alternatives?** Jest's TS/ESM setup is more configuration-heavy. `node:test` is viable but has a smaller assertion/mocking ecosystem.

**Trade-offs:** None significant.

**When would we reconsider?** Not expected to change.

### Decision: Test-Driven Development (TDD) as the default implementation method

**Chosen solution:** Red-green-refactor for all backend business logic, adapters, and worker code. A failing test is written and committed *before* the implementation that makes it pass, in every feature branch.

**Why?** Notifitra's core value proposition is reliability (retries, delivery logs, no silent drops) and its two highest-severity risks (webhook SSRF, Handlebars template injection) are exactly the kind of logic where defining the boundary as a test *first* — "this IP must be rejected," "this helper must not be reachable" — prevents the boundary from being an afterthought bolted on once code already works for the happy path. TDD also gives every branch a self-contained, checkable definition of done: the test commit predates the implementation commit.

**Alternatives considered:** Test-after (write feature, then backfill tests before merge); test-optional with a coverage gate only.

**Why not the alternatives?** Test-after tends to produce tests that mirror the implementation's actual behavior rather than its intended contract — bugs and missed edge cases (like an unblocked private IP range) get "tested" as correct because the test was written by looking at what the code already does. A coverage-percentage gate alone doesn't guarantee the *right* things were tested, only that lines were executed.

**Trade-offs:** Slower initial velocity per endpoint (test scaffolding before any visible progress); requires the test harness (test DB, provider mocks, factories) to exist before Phase 5 starts rather than being assembled in a dedicated testing phase at the end. Not applied dogmatically to UI/dashboard work or to pure scaffolding (Phase 2 repo setup) where there's no meaningful behavior to specify first.

**Where TDD applies vs. doesn't:**
- **Applies:** all Phase 4 middleware (auth, rate limiting, validation), all Phase 5 endpoints and business logic, all provider adapters, worker retry/backoff/DLQ logic, SSRF/Handlebars-sandbox enforcement.
- **Doesn't apply strictly:** Phase 2 scaffolding, Phase 6/7 dashboard UI (tested primarily via manual QA and a thin E2E happy-path per §5), Phase 11 CI/CD config, Phase 12–14 infra/deployment work. These are validated by manual verification and the existing Definition of Done criteria instead.

**When would we reconsider?** If TDD's overhead is found to slow delivery without a corresponding drop in defects after a few phases, relax it to test-alongside (tests in the same PR, order unenforced) for lower-risk endpoints while keeping strict TDD for SSRF/template-sandbox code specifically.

### Decision: No state-management library for the dashboard beyond React Query + built-in state

**Chosen solution:** React + TanStack Query for server state, built-in `useState`/`useReducer` for local UI state.

**Why?** The dashboard is CRUD over a REST API — server-state caching/invalidation (React Query) is the actual hard problem; there's no complex client-only state graph that would justify Redux/Zustand.

**Alternatives considered:** Redux, Zustand, MobX.

**Why not the alternatives?** All solve a problem (complex shared client state) this app doesn't have. Adding Redux here is a textbook case of the over-engineering this plan explicitly avoids (see §11).

**Trade-offs:** If the dashboard later grows genuinely complex client-only state (e.g., a live-updating log viewer with lots of local filters), revisit.

**When would we reconsider?** If real-time log streaming/local state complexity grows significantly.

---

## 2. Complete Implementation Roadmap (Phase-by-Phase Checklists)

Each phase below follows: **Objective → Tasks → Deliverables → Definition of Done → Dependencies → Risks → Verification.**

### Phase 0 — Project Validation

**Objective:** Confirm the requirements before writing code; ratify the adopted decisions in §0.4.

**Tasks**
- [ ] Review every row in the Adopted Decisions table (§0.4) and confirm each still fits your actual use case; flag and override any that don't
- [ ] Confirm target deployment path: managed free-tier (Render/Fly + Upstash + Neon/Supabase) vs single-VPS self-hosted vs both
- [ ] Confirm expected notification volume (rough order of magnitude) to sanity-check free-tier limits
- [ ] Confirm which channels are needed for v1 launch (email + webhook + push, per README) vs later
- [ ] Identify who the admin dashboard's users are (just you, or a small team) — informs auth decision

**Deliverables:** A short "Project Charter" note (can be a `docs/decisions.md` entry) recording confirmation of §0.4's adopted decisions (or any overrides).

**Definition of Done:** §0.4's adopted decisions are ratified (or explicitly overridden) with nothing left ambiguous; charter committed to repo.

**Dependencies:** None — this is the starting phase.

**Risks:** Skipping this phase causes rework later (e.g., building push against the wrong ntfy topic model). Mitigate by not proceeding to Phase 3 (DB design) until push/idempotency/template-versioning decisions are locked.

**Verification:** Charter reviewed and signed off by whoever owns the project decision.

---

### Phase 1 — Architecture & Technical Decisions

**Objective:** Lock the technical decisions in §1 as committed record, not just discussion.

**Tasks**
- [ ] Commit §1's decisions into `docs/architecture.md` (copy from this plan)
- [ ] Draw/commit the architecture diagram (README already has one — reuse it) into `docs/architecture.md`
- [ ] Decide monorepo layout: `apps/api`, `apps/worker`, `apps/dashboard`, `packages/shared`
- [ ] Decide package manager (pnpm, per README) and lockfile policy
- [ ] Decide Node version pin (20.x LTS) via `.nvmrc` / `engines` field

**Deliverables:** `docs/architecture.md`, repo layout plan.

**Definition of Done:** Architecture doc committed; no unresolved "which tool" questions remain for the core stack.

**Dependencies:** Phase 0 complete.

**Risks:** Analysis paralysis on tool choice — timebox this phase; the README already prescribes most of the stack.

**Verification:** Peer review of `docs/architecture.md`.

---

### Phase 2 — Repository & Development Environment Setup

**Objective:** Get a working, empty-but-runnable monorepo skeleton with local Postgres+Redis.

**Tasks**
- [ ] `git init`, create GitHub repo (`Lorem-Ipsum-Dev/notifitra` per README)
- [ ] Set up pnpm workspaces (`pnpm-workspace.yaml`) with `apps/*`, `packages/*`
- [ ] Scaffold `apps/api` (Hono + TS)
- [ ] Scaffold `apps/worker` (BullMQ consumer + TS)
- [ ] Scaffold `apps/dashboard` (Vite + React + TS)
- [ ] Scaffold `packages/shared` (shared types, Zod/valibot schemas, `NotificationAdapter` interface)
- [ ] Add root `tsconfig.base.json`, ESLint, Prettier configs shared across workspaces
- [ ] Write `docker-compose.yml` for local Postgres + Redis
- [ ] Write `.env.example` (all vars from README's table)
- [ ] Write root `README.md` dev quickstart matching the "Local Setup" section already in the project README
- [ ] Set up `pnpm dev` to run API + worker concurrently (e.g., via `turbo` or `concurrently`)
- [ ] Verify `pnpm install && docker compose up -d && pnpm dev` works end-to-end with placeholder "hello world" routes

**Deliverables:** Runnable skeleton repo; `http://localhost:3000` returns a health check; `http://localhost:5173` shows a placeholder dashboard.

**Definition of Done:** A new contributor can clone, follow the README, and have all three apps running locally within ~10 minutes.

**Dependencies:** Phase 1.

**Risks:** Workspace/tooling misconfiguration (path aliases, TS project references) causing friction later — invest time here to get it right once.

**Verification:** Fresh clone on a clean machine (or CI) reproduces the "10 minute setup" claim.

---

### Phase 3 — Database Design

**Objective:** Finalize and migrate the schema from README's outline into a full DDL.

**Tasks**
- [ ] Choose migration tool (Prisma, Drizzle, or Kysely+node-pg-migrate) — **Decision Required**, see §1 addendum below
- [ ] Define `api_keys` table: id, name, key_hash, scopes (array/jsonb), rate_limit_per_minute, created_at, revoked_at
- [ ] Define `templates` table: id, name, channel, subject, body, version, created_at, is_active
- [ ] Define `notifications` table: id (ULID, matches README's `ntf_01HZY...` format), api_key_id (FK), channel, template_id (FK), payload (jsonb), status, idempotency_key (nullable, unique), created_at
- [ ] Define `delivery_attempts` table: id, notification_id (FK), attempt_no, status, error, attempted_at
- [ ] Define indexes: `notifications(status, created_at)`, `notifications(api_key_id, created_at)`, `notifications(idempotency_key)` unique, `delivery_attempts(notification_id)`
- [ ] Define constraints: FKs with `ON DELETE RESTRICT` (never silently lose delivery history), `CHECK` on `channel` enum, `CHECK` on `status` enum
- [ ] Write ER diagram → `docs/schema.md`
- [ ] Write and run initial migration
- [ ] Write a seed script (`pnpm db:seed`) for local dev sample data
- [ ] Review schema against the adopted decisions from Phase 0 (idempotency key, template versioning)

**Deliverables:** `docs/schema.md` with full DDL + ER diagram; migration files; seed script.

**Definition of Done:** `pnpm db:migrate` runs cleanly on a fresh database; seed data loads; schema reviewed against every README/roadmap field.

**Dependencies:** Phase 2; Phase 0 decisions on idempotency (#4) and template versioning (#6).

**Risks:** Under-indexing causes slow `GET /v1/notifications` list queries once volume grows — add indexes now, not retroactively. Using auto-increment IDs instead of ULIDs would break the README's documented ID format (`ntf_01HZY...`) — use a ULID/UUIDv7 library.

**Verification:** `EXPLAIN ANALYZE` on the notification-list query with seed data confirms index usage; migration is reversible (down migration tested).

> **Decision: Migration/ORM tool.** Recommend **Drizzle ORM** — lightweight, SQL-first, strong TS inference, minimal runtime overhead, good fit for Hono's minimalism philosophy. **Alternative: Prisma** — better DX/tooling (Prisma Studio) but heavier runtime and a separate schema DSL to learn. **Why not Prisma as default:** adds a generated-client build step and a bit more magic than this project's "keep it simple" ethos wants; either is acceptable — pick one before Phase 3 starts and don't revisit mid-project.

---

### Phase 4 — Backend Foundation

**Objective:** Stand up the API skeleton with cross-cutting concerns before building feature endpoints — **and stand up the TDD test harness itself**, since every subsequent phase depends on it existing first.

**Tasks — test harness (do this first, before any middleware)**
- [ ] Set up dedicated `notifitra_test` Postgres database + transactional rollback (or fresh-migrate) strategy between test runs
- [ ] Set up factory functions for API keys, templates, notifications (`packages/shared/test-utils`)
- [ ] Set up provider-mocking helpers (mock HTTP layer for Resend/ntfy/webhook targets) so adapter tests never hit real providers
- [ ] Wire `pnpm test` / `pnpm test:integration` scripts and confirm they run against the test DB, not dev/prod

**Tasks — middleware (TDD: write the failing test for each item below before implementing it)**
- [ ] Config/env loading with validation (fail fast on missing required vars from README's env table) — test: app refuses to boot with a missing required var
- [ ] Structured logging (pino, JSON output) with request-id correlation
- [ ] Global error-handling middleware (consistent error JSON shape) — test: a thrown error produces the documented error shape, not a stack trace leak
- [ ] Request validation middleware (Zod schemas from `packages/shared`) — test: invalid body returns 400 with field-level errors
- [ ] API-key authentication middleware: parse `Authorization: Bearer rk_live_...`, hash-compare against `key_hash`, attach scopes to request context — test: missing/invalid/valid key cases, written first
- [ ] Scope-check middleware (per-endpoint required scope) — test: wrong-scope key returns 403, written first
- [ ] Redis-backed rate-limiting middleware, keyed by API key, using each key's `rateLimitPerMinute` — test: Nth request over the limit returns 429, written first
- [ ] Health-check endpoint (`GET /health`) checking DB + Redis connectivity
- [ ] Wire OpenAPI spec generation (e.g., `@hono/zod-openapi`) and serve at `/docs`
- [ ] BullMQ queue connection setup (shared config between API-producer and worker-consumer)

**Deliverables:** A running API with auth, validation, rate limiting, logging, and `/docs` — but no business endpoints yet. A working, reusable test harness (test DB, factories, provider mocks) that every later phase builds on.

**Definition of Done:** For every middleware item above, a test exists whose commit predates the implementation's commit and is now green. Hitting any protected route without a key returns 401; with a valid key but wrong scope returns 403; with a valid key exceeding rate limit returns 429; `/docs` renders the (still-mostly-empty) OpenAPI spec.

**Dependencies:** Phase 3 (needs `api_keys` table).

**Risks:** Building feature endpoints before this foundation — and its test harness — is solid means retrofitting auth/validation/tests everywhere later; do this phase fully, harness included, before Phase 5. Skipping the harness-first step is the single most common way a "we do TDD" plan quietly reverts to test-after.

**Verification:** Integration tests hitting `/health` and a dummy protected route cover the 401/403/429 cases; git log confirms test commits precede implementation commits for each middleware item.

---

### Phase 5 — Core Backend Features (Business Logic)

**Objective:** Implement the actual API surface from README's API Reference table. **Every item below is built red-green-refactor: write the failing test that specifies the behavior, confirm it fails for the right reason, implement, confirm green, refactor.**

**Tasks** *(each bullet's sub-point is the test to write first)*
- [ ] `POST /v1/notifications` — tests first: valid payload enqueues + returns `{id, status:"queued"}`; missing scope returns 403; unknown template returns 404; malformed `data` returns 400 → then implement: validate payload → check scope for `channel` → render template with Handlebars (locked-down env) → enqueue BullMQ job → insert `notifications` row → return response
- [ ] Idempotency-key handling — test first: two requests with the same `Idempotency-Key` within the window produce one notification, not two → then implement dedup on unique `idempotency_key`
- [ ] `GET /v1/notifications/:id` — test first: returns notification + joined `delivery_attempts`; 404 for unknown/foreign-key id → then implement
- [ ] `GET /v1/notifications` — test first: pagination and channel/status filters return the expected subset → then implement
- [ ] `POST/GET/PUT /v1/templates` — test first: an unparsable Handlebars body is rejected at save time (not send time) → then implement CRUD + validation
- [ ] `POST /v1/keys` — test first: response includes plaintext key exactly once; a subsequent `GET` never exposes it → then implement (generate `rk_live_...`, hash before storing)
- [ ] `DELETE /v1/keys/:id` — test first: revoked key fails auth on next request but its row/history is retained (soft-delete) → then implement
- [ ] Provider adapters behind the `NotificationAdapter` interface — for each, write the adapter's contract test against a mocked provider HTTP call *before* writing the adapter:
  - [ ] Email adapter (Resend + SMTP fallback, switchable via `EMAIL_PROVIDER`)
  - [ ] Push adapter (ntfy) — resolve target-topic model from Phase 0 decision #3
  - [ ] Webhook adapter — **write the SSRF test suite first**: assert rejection of `169.254.169.254`, loopback, link-local, and DNS-rebinding-style hostnames, *then* implement the allow-list/IP-blocking logic to make those tests pass
- [ ] Worker — test first: a job that fails N times lands in the DLQ with N logged `delivery_attempts` rows and a terminal `notifications.status` → then implement consume → dispatch → backoff/retry → DLQ → status update
- [ ] DLQ inspection endpoint(s) — test first: DLQ entries are queryable with their failure reason → then implement

**Deliverables:** Fully functional API + worker matching every row in README's API Reference table, with a test suite that was written ahead of (and now fully covers) that implementation.

**Definition of Done:** For every bullet above, the test commit predates the implementation commit and both are green. A `curl` matching the README's "Sending a Notification" example works end-to-end against a real (or sandbox) provider and produces a queryable delivery log.

**Dependencies:** Phase 4 (including its test harness — this phase cannot start TDD without it).

**Risks:** SSRF in webhook adapter (see §0.5) — the dedicated allow-list/IP-blocking test suite is written *before* the adapter code in this phase precisely to prevent this. Handlebars template-injection risk — the "unparsable/unsafe template rejected at save time" test must exist before the validation logic, not be reverse-engineered from it afterward.

**Verification:** Manual `curl` walkthrough of every endpoint in README's API Reference; git history shows red-before-green for each item; a dedicated SSRF test (attempt to allow-list `169.254.169.254` / `localhost` and confirm rejection) reviewed by a second person.

---

### Phase 6 — Frontend Foundation (Admin Dashboard)

**Objective:** Stand up the dashboard shell with auth and API client before building feature screens.

**Tasks**
- [ ] Scaffold routing (React Router or TanStack Router)
- [ ] Implement admin auth per Phase 0 decision #1 (simple login)
- [ ] Set up TanStack Query + a typed API client generated from the OpenAPI spec (`/docs`) so dashboard and API can't silently drift
- [ ] Build layout shell: nav (Notifications, Templates, Keys, Dead-letter), header, auth-guarded routes
- [ ] Set up styling approach (see §1 addendum below)

**Deliverables:** Logged-in shell with empty feature pages wired to real (but unpopulated) API calls.

**Definition of Done:** Dashboard authenticates, navigates between sections, and a network tab shows real typed API calls (not mocked).

**Dependencies:** Phase 5 (needs a real API to call against).

**Risks:** Building UI against a hand-guessed API shape instead of the generated OpenAPI client — always generate from `/docs`, don't hand-write duplicate types.

**Verification:** Manual click-through; typecheck passes with the generated client.

> **Decision: Styling.** Recommend **Tailwind CSS** — fast to build small admin UIs, no separate CSS-file sprawl, pairs well with the "avoid over-engineering" principle (no CSS-in-JS runtime, no design-system build step for an internal tool). Alternative: CSS Modules. Not recommended: styled-components/Emotion (runtime cost, unnecessary for an internal dashboard).

---

### Phase 7 — Core Frontend Features

**Objective:** Build the actual dashboard screens.

**Tasks**
- [ ] Notifications list: paginated table, filter by channel/status, click-through to detail view with attempt history
- [ ] Template editor: create/edit with live Handlebars preview against sample `data`, version history view
- [ ] API key management: create (show plaintext once, with a copy button and a clear "you won't see this again" warning), list (masked), revoke
- [ ] Dead-letter queue view: list permanently-failed notifications, show failure reason, (optional v1.1) manual replay button
- [ ] Basic delivery analytics widget (send volume / failure rate) — README lists this as roadmap, so **stub or defer**, don't gold-plate v1

**Deliverables:** A usable admin dashboard covering every core resource.

**Definition of Done:** You can fully operate Notifitra (create a key, create a template, watch a send succeed/fail/retry, inspect the DLQ) without touching `curl` or the database directly.

**Dependencies:** Phase 6.

**Risks:** Scope creep into the "Roadmap" items (analytics dashboard, Slack/Discord adapters) — explicitly defer these past v1 per §0.4/README's own roadmap section.

**Verification:** Manual end-to-end walkthrough of the full user journey; screenshots/recording for the team.

---

### Phase 8 — Integration

**Objective:** Verify API, worker, and dashboard work together as a system, not just in isolation.

**Tasks**
- [ ] Run full stack locally via `docker compose up` + `pnpm dev`, exercise every user journey
- [ ] Verify worker horizontal scaling: run 2 worker instances locally, confirm no duplicate delivery (BullMQ job locking)
- [ ] Verify API restart doesn't lose in-flight queued jobs (Redis persistence check)
- [ ] Verify template-change doesn't retroactively alter already-rendered/queued notifications (payload should freeze rendered content at enqueue time, or store template version reference)
- [ ] Cross-check OpenAPI spec accuracy against actual dashboard usage

**Deliverables:** A signed-off "integration verified" checklist.

**Definition of Done:** No cross-service bugs found in a full manual regression pass.

**Dependencies:** Phases 5, 6, 7 complete.

**Risks:** Race conditions around concurrent worker instances — this is the highest-value thing to catch before production.

**Verification:** Documented manual test session + any integration tests added as regression coverage.

---

### Phase 9 — Test Suite Hardening

**Objective:** Under TDD, unit and integration coverage for backend logic already exists by the end of Phase 5 — it was written *before* that code, not after. This phase is no longer where testing "starts"; it's where the suite is closed out with the things TDD-per-endpoint doesn't naturally produce: cross-cutting E2E coverage, load testing, and dashboard QA.

**Tasks**
- [ ] Coverage review: confirm every Phase 4/5 item has a test that was committed ahead of its implementation (spot-check git history, not just a coverage percentage)
- [ ] Fill any gaps: a small number of integration-level interactions (e.g., two endpoints combined) may not have been naturally covered by per-endpoint TDD — add tests for those now
- [ ] E2E test: the full `curl` journey from README (create key → create template → send → poll status → see delivery log) scripted and run in CI
- [ ] Load/soak test against free-tier-equivalent limits (simulate Upstash/Neon connection caps) to validate Phase 0's volume assumptions
- [ ] Manual QA pass on the dashboard (see §7 checklist) — dashboard UI is the one area not built strictly TDD (see §1's TDD decision), so this is its primary verification

**Deliverables:** CI-enforced test suite (already largely in place from Phases 4–5); a scripted E2E test; a load-test report against free-tier limits; a completed manual QA pass.

**Definition of Done:** Meets the quality gates defined in §5/§7. Git-history spot-check confirms TDD's red-before-green pattern was actually followed, not just tests added after.

**Dependencies:** Phase 8.

**Risks:** Treating this phase as "where testing happens" defeats the purpose of doing TDD in Phases 4–5 in the first place — if a real testing effort is deferred to here, the plan has silently reverted to test-after. Skipping load-testing against actual free-tier limits and discovering connection caps in production is a separate risk — do the load test before Phase 13, not after.

**Verification:** CI green on every PR; load-test report reviewed; git log audit confirming test-before-implementation ordering on a sample of Phase 5 commits.

---

### Phase 10 — Security Hardening

**Objective:** Close every item in the Security Checklist (§6) before production.

**Tasks:** See §6 in full — summarized here:
- [ ] Confirm API keys are hashed (bcrypt/argon2, not reversible encryption) and never logged
- [ ] Confirm webhook SSRF protections are airtight (allow-list + IP-range blocking + DNS-rebinding protection)
- [ ] Confirm Handlebars sandbox has no helper/partial escape hatch
- [ ] Confirm all inputs are schema-validated before touching the DB or templating engine
- [ ] Add secure HTTP headers (helmet-equivalent for Hono)
- [ ] Confirm CORS policy is explicit (dashboard origin only, not `*`)
- [ ] Confirm rate limiting is Redis-backed (works across multiple API instances)
- [ ] Run `pnpm audit` / Dependabot / Snyk for dependency vulnerabilities
- [ ] Confirm no secrets in logs, error messages, or git history
- [ ] Confirm DB user has least-privilege grants (not superuser) in production

**Deliverables:** Completed §6 checklist, signed off.

**Definition of Done:** Every "Must-have before production" item in §6 is checked.

**Dependencies:** Phase 9.

**Risks:** See §0.5 (SSRF, template injection) — these are the two highest-severity risks in this project and deserve dedicated review time, not just a checklist pass.

**Verification:** A second person (not the implementer) reviews the SSRF and template-sandbox code paths specifically.

---

### Phase 11 — CI/CD

**Objective:** Automate lint/typecheck/test/build on every PR, and deploy on merge.

**Tasks**
- [ ] `.github/workflows/ci.yml`: lint → typecheck → unit tests → integration tests (with Postgres/Redis service containers) on every PR
- [ ] Separate workflow (or job) to build and push Docker images for `api`/`worker` on merge to `main`
- [ ] Dashboard build/deploy workflow (Cloudflare Pages/Vercel — likely handled by their native Git integration rather than a custom Action)
- [ ] Branch protection: require CI green + at least one review before merge to `main`
- [ ] Add a `staging` deploy trigger (auto-deploy on merge to `main` or a `staging` branch — decide per your release workflow in §5)

**Deliverables:** Working CI pipeline; automated staging deploy.

**Definition of Done:** A PR cannot merge without passing lint/typecheck/tests; merging to `main` auto-deploys to staging.

**Dependencies:** Phase 9 (needs tests to run), Phase 3 repo structure.

**Risks:** Flaky integration tests due to service-container startup timing — add health-check waits in the workflow.

**Verification:** Open a deliberately-broken PR and confirm CI blocks it; confirm a good merge reaches staging.

---

### Phase 12 — Staging Environment

**Objective:** Validate the full system on real (free-tier) infrastructure before production traffic.

**Tasks**
- [ ] Provision staging Postgres (Neon/Supabase free tier, separate project from prod)
- [ ] Provision staging Redis (Upstash free tier, separate database from prod)
- [ ] Deploy API+worker Docker image to Render/Fly staging service
- [ ] Deploy dashboard to Cloudflare Pages/Vercel staging environment
- [ ] Configure staging environment variables/secrets (separate from prod secrets, never reused)
- [ ] Run the full manual QA journey against staging
- [ ] Run smoke tests against staging post-deploy (`GET /health`, create-key, send-notification round trip)

**Deliverables:** A working staging deployment reachable at a staging URL.

**Definition of Done:** Staging smoke tests pass; staging mirrors intended production topology.

**Dependencies:** Phase 11.

**Risks:** Staging/prod config drift — use the same IaC/deploy scripts for both, differing only by environment variables.

**Verification:** Smoke-test script output attached to the deploy record.

---

### Phase 13 — Production Deployment

**Objective:** Ship to production safely.

**Tasks — Pre-production checklist**
- [ ] All Phase 10 security items checked
- [ ] All Phase 9 tests green
- [ ] Staging smoke tests passed (Phase 12)
- [ ] Production Postgres provisioned (Neon/Supabase), migrations run
- [ ] Production Redis provisioned (Upstash)
- [ ] Production secrets set on Render/Fly + Vercel/Cloudflare (never copy-pasted from staging — regenerate)
- [ ] Domain + HTTPS configured (custom domain on Render/Fly + Cloudflare Pages/Vercel, or Cloudflare in front for both)
- [ ] Database backup schedule confirmed (Neon/Supabase automated backups enabled; note retention period)
- [ ] Rollback plan documented (see below)
- [ ] Monitoring/error-tracking wired (see Phase 14)

**Tasks — Deployment**
- [ ] Tag a release (`vX.Y.Z`) per versioning strategy (§5)
- [ ] Deploy API+worker image to production
- [ ] Run production migrations (`pnpm db:migrate`) — **before** flipping traffic if the migration is backward-compatible, otherwise per §5's migration workflow
- [ ] Deploy dashboard to production
- [ ] Verify `/health` and `/docs` on production URL

**Tasks — Post-deployment checklist**
- [ ] Run production smoke tests (same script as staging, against prod)
- [ ] Manually send one real test notification end-to-end
- [ ] Verify logs are flowing into the logging destination
- [ ] Verify error tracking captures a deliberately-triggered test error, then remove the test trigger
- [ ] Announce/document the production URL and access instructions

**Rollback strategy**
- [ ] Keep the previous Docker image tag deployable with one click/command on Render/Fly
- [ ] Database migrations must be written to be backward-compatible with the previous app version for at least one release (expand/contract pattern) so a code rollback never requires a DB rollback
- [ ] Document the exact rollback command sequence in `docs/deployment.md`

**Deliverables:** Live production system; rollback runbook.

**Definition of Done:** Production smoke tests pass; a real notification was sent and logged in production; rollback procedure is documented and untested-but-ready (or ideally dry-run tested against staging).

**Dependencies:** Phase 12.

**Risks:** Irreversible migrations shipped alongside app code — always use expand/contract migrations to keep rollback safe.

**Verification:** Post-deployment checklist fully ticked; rollback dry-run performed at least once against staging.

---

### Phase 14 — Post-Production: Monitoring, Maintenance, Future Improvements

**Objective:** Keep the system healthy after launch.

**Tasks**
- [ ] Set up uptime monitoring (e.g., a free tier of Better Uptime / UptimeRobot) against `/health`
- [ ] Set up error tracking (e.g., Sentry free tier) for API, worker, and dashboard
- [ ] Set up DLQ-growth alerting (e.g., a scheduled check that alerts if DLQ size exceeds a threshold)
- [ ] Document backup/recovery test: periodically restore a backup to a scratch DB and confirm it's usable
- [ ] Establish a maintenance cadence: dependency updates (Dependabot PRs reviewed weekly/monthly), Postgres/Redis version checks
- [ ] Revisit README's own Roadmap items and prioritize: in-app notification channel, delivery analytics dashboard, Slack/Discord adapters, BYO-SMS guide
- [ ] Revisit the deferred items in the adopted-decisions table (§0.4) (multi-recipient batch sends, DLQ manual replay UI, multi-tenancy) and schedule them if needed

**Deliverables:** Monitoring dashboards; a documented maintenance cadence; an updated roadmap doc.

**Definition of Done:** Alerts are configured and have been test-fired at least once; maintenance cadence is written down somewhere the team will actually see it.

**Dependencies:** Phase 13.

**Risks:** Alert fatigue from noisy thresholds — tune thresholds after the first week of real traffic data.

**Verification:** Trigger a test alert end-to-end (e.g., temporarily lower the DLQ threshold) and confirm it fires and is received.

---

## 3. Development Workflow

- **Git workflow:** trunk-based with short-lived feature branches off `main`. `main` is always deployable (auto-deploys to staging).
- **Branch naming:** `feat/<short-desc>`, `fix/<short-desc>`, `chore/<short-desc>`, `docs/<short-desc>` — e.g. `feat/webhook-ssrf-guard`.
- **Commit conventions:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`) — enables auto-changelog generation later if wanted.
- **Pull requests:** every change via PR, even solo — keeps CI gating and history clean. PR description links the relevant checklist item from this plan.
- **Code reviews:** at least one approval before merge (even self-review via a checklist if solo); reviewer explicitly checks security-sensitive diffs (auth, SSRF, template rendering) more closely.
- **Issue/task organization:** use GitHub Issues mapped 1:1 to checklist items in this plan; label by phase (`phase:5-backend-core`) and type (`bug`, `feature`, `security`).
- **Feature development workflow:** branch → implement → tests → PR → CI green → review → merge → auto-deploy to staging → manual staging check for anything risky → included in next release tag.
- **Bug-fixing workflow:** reproduce with a failing test first, then fix, so the regression can't silently return.
- **Database migration workflow:** expand/contract pattern — additive migration ships first (new nullable column), code deploys reading/writing both old+new, backfill, then a later contract migration removes the old column. Never ship a breaking migration in the same release as the code that requires it.
- **Testing workflow (TDD):** for backend business logic, adapters, and worker code, the test is written and committed *before* the implementation, in the same PR — red, then green, then refactor. This is enforced in review, not just described: a reviewer checks that the test commit predates the implementation commit. Dashboard UI and infra/config work (Phases 2, 6–7 UI, 11–14) follow "tests alongside" rather than strict TDD — see §1's TDD decision for the full scope split.
- **Release workflow:** tag `vX.Y.Z` on `main` after staging verification → triggers production deploy job (manual approval gate recommended even with CI/CD, given this handles real notification delivery).
- **Versioning strategy:** SemVer. Breaking API contract changes (endpoint shape, required-field changes) bump major; new endpoints/optional fields bump minor; fixes bump patch.
- **Environment management:** three environments — `local`, `staging`, `production` — each with fully separate DB/Redis/secrets, never shared or copied directly (staging seeded independently, never a prod data dump, to avoid PII leakage).

---

## 4. Security Checklist

### Must-have before production

- [ ] API keys hashed with a proper KDF (argon2id or bcrypt), never stored/logged in plaintext (README already requires this)
- [ ] Plaintext key shown exactly once at creation, never retrievable again
- [ ] All request bodies validated against a schema before any DB write or template render
- [ ] SQL injection: use parameterized queries via the ORM/query builder exclusively — no raw string interpolation into SQL
- [ ] XSS: dashboard escapes all user-supplied content (template bodies, error messages) by default; template **preview** renders in a sandboxed context (e.g., an iframe with no script execution) since template bodies may include HTML for email
- [ ] CSRF: if dashboard auth uses cookies, add CSRF tokens on state-changing requests; if it uses bearer tokens in localStorage/memory, CSRF risk is lower but confirm the auth model choice from Phase 0 explicitly
- [ ] CORS: explicit allow-list of the dashboard's origin(s) only, credentials handled deliberately
- [ ] Rate limiting: Redis-backed, per-API-key, enforced on every write endpoint at minimum
- [ ] Webhook SSRF: allow-list validated at both key-creation and send time; block RFC1918/loopback/link-local ranges (including `169.254.169.254` cloud metadata endpoint) even after DNS resolution
- [ ] Handlebars: no custom helpers, no partials, no `require`-based extensions reachable from user-supplied templates
- [ ] Secrets management: all secrets via environment variables / platform secret stores, never committed; `.env` in `.gitignore`
- [ ] Dependency vulnerabilities: `pnpm audit` / Dependabot enabled and reviewed before each release
- [ ] Secure HTTP headers: HSTS, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, sensible CSP for the dashboard
- [ ] HTTPS enforced everywhere in production (PaaS/CDN defaults typically handle this — confirm, don't assume)
- [ ] Database permissions: production DB user has only the grants the app needs (no superuser/DDL rights at runtime beyond the migration step)
- [ ] Logging sensitive information: confirm `payload`/`data` fields aren't logged in full if they may contain PII; log references (notification ID) instead of raw payloads in app logs
- [ ] Personal data protection: document what PII may pass through `data`/`payload`, retention period (§0.4 #8), and how to honor a deletion request if ever needed

### Nice-to-have later

- [ ] Multi-user RBAC for the dashboard (beyond single admin account)
- [ ] Audit log of admin actions (who created/revoked which key, who edited which template)
- [ ] Automated dependency-vulnerability blocking in CI (not just a report)
- [ ] Web Application Firewall in front of the API (Cloudflare) if abuse becomes a real problem
- [ ] Formal SOC2-style access reviews (only relevant if this ever becomes a multi-tenant SaaS)

---

## 5. Testing Strategy

**Method:** TDD (red-green-refactor) for backend business logic, middleware, adapters, and worker code — see §1's TDD decision for exact scope and rationale. This section describes *what* gets tested; §1 and the Phase 4/5/9 tasks describe the *order* in which it gets written.

**Unit test:** validation schemas, Handlebars rendering (including that helpers/partials are correctly disabled), rate-limiter logic, key hashing/verification, SSRF IP-range-blocking logic, retry/backoff calculation.

**Integration test:** each API endpoint against a real local Postgres+Redis; each provider adapter against a mocked provider HTTP endpoint (never call real Resend/ntfy in CI); worker job-processing against a real BullMQ+Redis instance.

**End-to-end test:** the full README "Sending a Notification" journey scripted against a fully running local stack (docker-compose services + API + worker), run in CI as `pnpm test:integration` or a dedicated `test:e2e` script.

**Manual test:** dashboard UX flows (key creation copy-once warning, template live preview, DLQ inspection) — these are hard to meaningfully automate for a small admin tool and are better covered by a documented manual QA checklist run before each release.

**What NOT to test unnecessarily:** don't unit-test framework internals (Hono routing itself, BullMQ's own retry math); don't write E2E browser tests for every dashboard button — reserve E2E/browser automation (if added at all) for the single critical path (login → create key → send → see log), not exhaustive UI coverage, to avoid low-value maintenance burden.

**Test organization:** colocate unit tests next to source (`foo.ts` / `foo.test.ts`); integration tests under `apps/api/test/integration/`; shared test fixtures/factories in `packages/shared/test-utils`.

**Test naming:** `describe('POST /v1/notifications')` → `it('rejects a payload missing required fields')` — behavior-described, not implementation-described.

**Test data/fixtures:** factory functions (not fixture JSON files) for generating valid API keys/templates/notifications in tests, so schema changes only require updating one factory.

**Mocking strategy:** mock at the provider-adapter boundary (HTTP calls to Resend/ntfy/webhook targets) — never mock your own DB/queue in integration tests, since that's exactly what you're trying to verify works.

**Test database strategy:** a dedicated `notifitra_test` Postgres database, migrated fresh (or transactionally rolled back) between test runs; CI spins up Postgres+Redis as service containers. This is set up in Phase 4, not Phase 9, since TDD needs it from the first middleware test onward.

**CI test execution:** lint → typecheck → unit → integration, on every PR, in that order (fail fast on cheap checks first).

**Quality gates before merging a PR:** all four CI stages green; no new `pnpm audit` high/critical vulnerabilities introduced; reviewer approval **including confirmation that test commits precede implementation commits for backend logic** (a quick git-log glance, not a heavyweight process).

**Quality gates before production deployment:** full Phase 9 suite green including load test; Phase 10 security checklist fully checked; staging smoke tests passed within the last release cycle.

---

## 6. Deployment Strategy

### Local
- Docker Compose for Postgres + Redis (`docker-compose.yml`)
- `.env` from `.env.example`, filled with local dev values
- `pnpm db:migrate` then `pnpm db:seed` for sample data
- `pnpm dev` runs API + worker; dashboard via its own Vite dev server

### Staging
- Infra: Render/Fly (API+worker), Upstash (Redis), Neon/Supabase (Postgres), Cloudflare Pages/Vercel (dashboard) — all separate projects/instances from production
- Deployment: auto-deploy on merge to `main` (see §5 release workflow)
- Database: migrated automatically as part of the deploy step, seeded with synthetic (non-PII) sample data only
- Secrets: platform-native secret stores, distinct values from production
- Testing: full manual QA journey + automated smoke test script post-deploy

### Production
- Infra: same providers as staging, separate projects, production tier where the free tier's limits are actually insufficient (revisit after Phase 9's load test)
- Domain: custom domain pointed at the API and dashboard
- HTTPS: enforced via platform defaults or Cloudflare in front
- Environment variables: regenerated (not copied from staging) — especially `API_KEY_SECRET`
- Database: automated backups enabled (confirm retention period with the provider), migrations run as an explicit, logged deploy step
- Migrations: expand/contract pattern (see §3)
- Storage: N/A for v1 (no file uploads in scope per README)
- Monitoring/Logging/Backups: see Phase 14
- Rollback: previous image redeployable in one step; migrations backward-compatible for at least one release

### Pre-production checklist
See Phase 13's "Pre-production checklist" — reproduced there in full.

### Post-deployment checklist
See Phase 13's "Post-deployment checklist" — reproduced there in full.

---

## 7. Production Readiness Checklist

```md
## 🚀 Production Readiness — Notifitra

### Code
- [ ] All Phase 5 core endpoints implemented and match README's API Reference
- [ ] All three provider adapters (email, push, webhook) implemented and tested
- [ ] No TODO/FIXME markers on security-relevant code paths
- [ ] Linting and typechecking pass with zero errors

### Security
- [ ] Every "Must-have before production" item in §4 checked
- [ ] SSRF protection specifically re-reviewed by a second person
- [ ] Handlebars sandbox specifically re-reviewed by a second person
- [ ] `pnpm audit` clean of high/critical issues

### Database
- [ ] Schema matches `docs/schema.md`, all migrations applied cleanly
- [ ] Indexes verified against real query patterns (EXPLAIN ANALYZE)
- [ ] Automated backups enabled and retention period documented
- [ ] A backup restore has been test-run at least once

### Testing
- [ ] Unit, integration, and E2E suites green in CI
- [ ] Load test completed against free-tier-equivalent limits
- [ ] Manual QA checklist completed on staging

### Infrastructure
- [ ] Staging and production fully separate (DB, Redis, secrets, domains)
- [ ] Worker horizontal-scaling verified safe (no duplicate delivery)
- [ ] Health check (`/health`) verifies DB + Redis connectivity

### Monitoring
- [ ] Uptime monitoring configured and test-fired
- [ ] Error tracking configured and test-fired
- [ ] DLQ-growth alerting configured and test-fired

### Documentation
- [ ] `docs/api.md`, `docs/providers.md`, `docs/schema.md`, `docs/deployment.md` all up to date
- [ ] `SECURITY.md` and `CONTRIBUTING.md` present and accurate
- [ ] Rollback runbook documented

### Deployment
- [ ] CI/CD pipeline green, branch protection enabled
- [ ] Production secrets regenerated (not copied from staging)
- [ ] Domain + HTTPS verified on both API and dashboard

### Rollback
- [ ] Previous production image redeployable in one command/click
- [ ] All shipped migrations are backward-compatible (expand/contract)
- [ ] Rollback dry-run performed against staging at least once
```

When every box above is checked: **Notifitra is production-ready.**

---

## 8. Recommended Implementation Sequence

```text
Phase 0  — Project validation           | Complexity: Low    | Deps: none                | Critical path: yes
Phase 1  — Architecture & decisions     | Complexity: Low    | Deps: 0                   | Critical path: yes
Phase 2  — Repo & dev environment       | Complexity: Medium | Deps: 1                   | Critical path: yes
Phase 3  — Database design              | Complexity: Medium | Deps: 2, decisions #4/#6  | Critical path: yes
Phase 4  — Backend foundation           | Complexity: Medium | Deps: 3                   | Critical path: yes
Phase 5  — Core backend features        | Complexity: High   | Deps: 4                   | Critical path: yes
Phase 6  — Frontend foundation          | Complexity: Low    | Deps: 5 (needs real API)  | Parallelizable: dashboard scaffolding can start alongside late Phase 5
Phase 7  — Core frontend features       | Complexity: Medium | Deps: 6                   | Parallelizable: dashboard UI work overlaps naturally with Phase 5's TDD backend work, since backend tests/implementation land together per endpoint
Phase 8  — Integration                  | Complexity: Medium | Deps: 5, 6, 7             | Critical path: yes
Phase 9  — Test suite hardening         | Complexity: Medium | Deps: 8                   | Critical path: yes (lighter than before — most unit/integration coverage already exists from TDD in Phases 4-5)
Phase 10 — Security hardening           | Complexity: High   | Deps: 9                   | Critical path: yes
Phase 11 — CI/CD                        | Complexity: Low    | Deps: 9 (tests must exist)| Parallelizable: can be built incrementally from Phase 2 onward
Phase 12 — Staging                      | Complexity: Medium | Deps: 10, 11              | Critical path: yes
Phase 13 — Production deployment        | Complexity: Medium | Deps: 12                  | Critical path: yes
Phase 14 — Post-production              | Complexity: Low    | Deps: 13                  | Ongoing, not a one-time gate
```

**Notes on parallelization:**
- CI/CD (Phase 11) doesn't need to wait until the end — start with lint/typecheck in CI as early as Phase 2, and add test stages incrementally as they're written.
- Dashboard scaffolding (start of Phase 6) can begin once Phase 5's OpenAPI spec is stable enough to generate a client from, even before every endpoint is finished.
- Security hardening (Phase 10) is listed as its own phase for emphasis, but SSRF/template-sandbox protections should actually be built *inside* Phase 5, not bolted on after — Phase 10 is the audit/verification pass, not the first time these are considered.

**Critical path:** Phase 0 → 1 → 2 → 3 → 4 → 5 → 8 → 9 → 10 → 12 → 13. Frontend (6/7) and CI/CD (11) can flex around this spine but must both complete before Phase 12.

---

## 9. Avoiding Over-Engineering — Explicit Calls

- **No Kubernetes.** Render/Fly Docker deploys are sufficient at this scale; revisit only if you outgrow PaaS autoscaling entirely.
- **No microservices split beyond API/worker.** API and worker are already separate processes per the README's own architecture — that's the right amount of separation; don't further split by channel (e.g., a separate email-service) without a concrete scaling reason.
- **No GraphQL.** REST fits the resource-shaped API exactly (§1).
- **No Redux/Zustand/MobX for the dashboard.** TanStack Query + built-in React state is sufficient for a CRUD admin tool (§1).
- **No custom event-driven architecture beyond BullMQ.** BullMQ's job queue already gives you async processing; don't add a separate event bus/pub-sub layer without a real second consumer that needs it.
- **No paid SaaS dependency required to run the core stack** — every default choice (Upstash, Neon/Supabase, Render/Fly, Resend free tier, ntfy) has a genuine free tier, matching the README's own stated goal.
- **Consider pg-boss over BullMQ/Redis** if you want to shed a whole infra dependency — flagged as a valid simplification in §1, not mandatory, but worth a second look if Redis free-tier limits become a real constraint.
- **Defer, don't build:** multi-tenancy, multi-recipient batch sends, DLQ auto-replay UI, delivery analytics dashboard, Slack/Discord adapters, SMS adapter — all explicitly out of v1 scope per README's own roadmap and §0.4's adopted decisions. Building these now is scope creep against the stated goals.

---

## 10. Master Roadmap

```text
START
  ↓
Requirements (Phase 0)
  ↓
Architecture (Phase 1)
  ↓
Setup (Phase 2)
  ↓
Database (Phase 3)
  ↓
Backend (Phases 4-5)
  ↓
Frontend (Phases 6-7)
  ↓
Integration (Phase 8)
  ↓
Testing (Phase 9)
  ↓
Security (Phase 10)
  ↓
CI/CD (Phase 11)
  ↓
Staging (Phase 12)
  ↓
Production (Phase 13)
  ↓
Monitoring & Maintenance (Phase 14)
```

### Single Master Checklist (execution order)

- [ ] Ratify the adopted decisions (§0.4), overriding any that don't fit
- [ ] Commit architecture decisions (§1) to `docs/architecture.md`
- [ ] Scaffold monorepo, Docker Compose, `.env.example`
- [ ] Design and migrate database schema; write seed script
- [ ] Build backend foundation: config, logging, error handling, auth, scopes, rate limiting, `/health`, `/docs`
- [ ] Implement `POST /v1/notifications` with idempotency, template rendering, enqueue
- [ ] Implement `GET /v1/notifications/:id` and `GET /v1/notifications`
- [ ] Implement template CRUD with Handlebars validation on save
- [ ] Implement API key create/revoke with hashing
- [ ] Implement email, push, and webhook provider adapters (webhook with SSRF hardening)
- [ ] Implement worker: consume, dispatch, retry/backoff, DLQ, attempt logging
- [ ] Scaffold dashboard shell with auth and generated API client
- [ ] Build dashboard: notifications list/detail, template editor with preview, key management, DLQ view
- [ ] Full integration pass across API + worker + dashboard
- [ ] (Ongoing since Phase 4, under TDD) unit and integration tests written before each piece of backend logic; audit and fill any gaps, write E2E suite (Phase 9)
- [ ] Run load test against free-tier-equivalent limits
- [ ] Complete full security checklist (§4), with a second-person review of SSRF and template sandboxing
- [ ] Stand up CI (lint, typecheck, tests) and CD (image build/push, staging auto-deploy)
- [ ] Deploy to staging; run smoke tests
- [ ] Complete pre-production checklist (§ Phase 13)
- [ ] Deploy to production; run smoke tests; send one real end-to-end notification
- [ ] Complete post-deployment checklist (§ Phase 13)
- [ ] Configure uptime monitoring, error tracking, DLQ alerting; test-fire each
- [ ] Document maintenance cadence and revisit deferred roadmap items

---

*End of plan. This document should be updated as decisions are made — treat the adopted-decisions table (§0.4) and the Decision blocks (§1) as living records, not one-time notes.*
