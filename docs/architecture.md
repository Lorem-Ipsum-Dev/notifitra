# Notifitra — Architecture & Technical Decisions

**Status:** Ratified — Phase 1 (Architecture & Technical Decisions) complete.
**Owner:** Lorem-Ipsum-Dev
**Last updated:** 2026-08-14

This document commits Notifitra's technical decisions (§1 of `docs/NOTIFITRA_IMPLEMENTATION_PLAN.md`) as the working record. Decisions below are **chosen → why → alternatives rejected**; each was reached by following the README's prescribed stack rather than redesigning it. Revisit only via a dated entry — do not silently change.

---

## 1. Architecture overview

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

**Flow:** a request hits the API → validated against the API key's scopes → template rendered with supplied data → job enqueued in Redis via BullMQ → a worker dispatches it through the relevant provider adapter → the outcome (success, retry, or permanent failure) is recorded in Postgres.

**Key separation:** API and workers are separate processes. The API stays responsive under backlog; workers scale independently. This is the intended amount of service separation — do not split further by channel without a concrete scaling reason (§9).

---

## 2. Stack decisions

### 2.1 Language & runtime
- **Chosen:** TypeScript on Node.js **20.x LTS**, pinned via `.nvmrc` and `engines` in root `package.json`.
- **Why:** README-prescribed; one language across API/workers/dashboard; strong typing for a system whose job is validating and routing structured payloads.
- **Rejected:** Go, Python/FastAPI, Elixir — all add a second language for the dashboard; Python's typing story is weaker for strict request/response contracts.
- **Revisit:** only at millions-of-notifications/day scale (CPU-bound templating) — not indicated.

### 2.2 API framework
- **Chosen:** Hono.
- **Why:** README-prescribed; lightweight, first-class TS, portable to edge runtimes if ever needed.
- **Rejected:** Express (heavier, less type-safe), NestJS (DI machinery overkill), Fastify (reasonable but no edge portability edge).
- **Revisit:** if the project grows multiple bounded contexts needing heavy structure — not expected.

### 2.3 Database
- **Chosen:** PostgreSQL (Neon or Supabase free tier locally/remotely).
- **Why:** README-prescribed; the domain (`api_keys`, `templates`, `notifications`, `delivery_attempts`) is naturally relational; JSONB fits arbitrary `payload`/`data`; strong free-tier hosts.
- **Rejected:** SQLite (no concurrent multi-instance writes), MongoDB (loses relational FKs + transactional attempt-logging), MySQL (viable; Postgres JSONB + free-tier hosts win).
- **Revisit:** only if genuinely schema-less storage at scale appears — not indicated.

### 2.4 Queue
- **Chosen:** BullMQ on Redis (Upstash free tier).
- **Why:** README-prescribed; retries/backoff/DLQ out of the box — exactly the promised reliability features.
- **Rejected:** RabbitMQ/SQS (infra cost at this scale), in-process polling (no durability), pg-boss (valid simpler alternative — flagged as an acceptable over-engineering avoidance swap; **we follow BullMQ per README**).
- **Revisit:** if shedding Redis entirely becomes desirable, swap to pg-boss — a clean, low-risk substitution.

### 2.5 Templating
- **Chosen:** Handlebars, logic-less, **no custom helpers/partials enabled**.
- **Why:** README-prescribed; cannot execute arbitrary code, which matters since templates may come from less-trusted callers.
- **Rejected:** EJS (embedded JS = code-execution risk), Liquid/Mustache (reasonable but Handlebars specified + larger TS ecosystem).
- **Constraint (security):** the Handlebars runtime must be locked down (restricted helper set, no `require` reachable). Enforced test-first in `feat/templates-crud`.

### 2.6 Repository layout
- **Chosen:** Monorepo with pnpm workspaces.
- **Why:** API and worker share job payloads and the `NotificationAdapter` interface; the dashboard shares API contracts. A shared-type change surfaces compile errors everywhere inconsistent — the safety net a contract-driven system wants.
- **Rejected:** separate repos per service (requires publishing a shared types package for a solo project — pure overhead).
- **Revisit:** if the dashboard is ever spun out with its own release cadence.

### 2.7 API style
- **Chosen:** REST, with OpenAPI spec served at `/docs` (typed clients for free).
- **Why:** Small, resource-shaped surface (`notifications`, `templates`, `keys`); no over-fetching problem.
- **Rejected:** GraphQL — earns its complexity only with nested multi-type queries, which this API lacks.
- **Revisit:** only if a future dashboard needs deep nested client-driven queries.

### 2.8 Containerization & hosting
- **Chosen:** Docker Compose for local dev (Postgres + Redis); plain Docker image for PaaS (Render/Fly); `docker-compose.prod.yml` for VPS self-host.
- **Why:** Local/prod parity for stateful deps without native installs; README-prescribed providers.
- **Rejected:** Kubernetes (over-engineering at this scale), Nix (niche, raises contributor bar), native installs (break portability).
- **Hosting target (per charter):** managed free-tier PaaS — Render/Fly (API+worker), Upstash (Redis), Neon/Supabase (Postgres), Cloudflare Pages/Vercel (dashboard). VPS self-host documented but not the target.

### 2.9 CI/CD
- **Chosen:** GitHub Actions.
- **Why:** Free, integrated with the GitHub-hosted repo, no second platform.
- **Rejected:** CircleCI, GitLab CI, Buildkite — second account, zero benefit.
- **CI stage order:** lint → typecheck → unit → integration (fail fast on cheap checks first).

### 2.10 Testing
- **Chosen:** Vitest.
- **Why:** Fast, native ESM/TS, Jest-compatible API, Vite-aligned for the dashboard.
- **Rejected:** Jest (heavier TS/ESM config), `node:test` (smaller assertion/mocking ecosystem).
- **Method:** TDD for backend business logic, middleware, adapters, worker code (test commit precedes implementation commit). Dashboard UI and scaffolding/infra use test-alongside. See §1 of the implementation plan for the exact split.

### 2.11 Migration / ORM tool
- **Chosen:** **Drizzle ORM** (per the plan's recommendation).
- **Why:** Lightweight, SQL-first, strong TS inference, minimal runtime overhead — fits Hono's minimalism.
- **Rejected:** Prisma (better DX but heavier runtime + generated-client build step + separate schema DSL).
- **Constraint:** settled now; do not revisit mid-project. Swapping later is possible but deliberate.

### 2.12 Frontend state
- **Chosen:** React + TanStack Query for server state; built-in `useState`/`useReducer` for local state.
- **Why:** The dashboard is CRUD over REST — server-state caching/invalidation is the actual hard problem; there is no complex client-only state graph.
- **Rejected:** Redux, Zustand, MobX — all solve a problem this app doesn't have.
- **Revisit:** if a live-updating log viewer with heavy local filtering grows.

---

## 3. Monorepo layout

```
notifitra/
├─ apps/
│  ├─ api/          # Hono REST API (Phase 2 scaffold)
│  ├─ worker/       # BullMQ consumer (Phase 2 scaffold)
│  └─ dashboard/    # Vite + React admin UI (Phase 2 scaffold)
├─ packages/
│  └─ shared/       # shared types, Zod/valibot schemas, NotificationAdapter interface,
│                   #   test-utils (factories, provider mocks)
├─ docker-compose.yml        # local Postgres + Redis
├─ docker-compose.prod.yml   # self-host VPS deployment
├─ pnpm-workspace.yaml
├─ tsconfig.base.json        # shared TS config
├─ .nvmrc                   # Node 20.x pin
└─ package.json             # root: engines + workspace scripts (dev, test, lint, db:migrate, ...)
```

`packages/shared` is the contract surface: changing a shared type surfaces compile errors in every consumer — that is the point.

---

## 4. Package manager & tooling policy

- **Package manager:** pnpm, with `packageManager` field set in root `package.json` and committed `pnpm-lock.yaml`.
- **Lockfile:** committed; no `--no-frozen-lockfile` installs in CI.
- **Node:** 20.x LTS pinned via `.nvmrc` and `engines` (both files created in `chore/repo-scaffold`).
- **Formatting/linting:** Prettier + ESLint with a shared root config applied to all workspaces (created in `chore/repo-scaffold`).

---

## 5. Standing constraints

- Architecture decisions change only via a dated entry in this document, never silently.
- Revisit §2.4 (pg-boss) or §2.3 only if infra surface area or scale genuinely changes.
- Drizzle (§2.11) is settled — the Phase 3 branch implements it, it does not re-litigate it.
- Any conflict between this document and the implementation plan: the plan's phase checklists govern execution; this document governs the technical record.
