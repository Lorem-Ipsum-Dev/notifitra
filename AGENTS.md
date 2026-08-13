# AGENTS.md

## Repo state: planning phase — no code yet

The repo contains only docs: `README.md` (aspirational target state — the full product is described but nothing is implemented), `LICENSE`, and the plan docs in `docs/`. There is no `package.json`, source code, or CI. Do not run or assume the commands the README documents (`pnpm dev`, `pnpm db:migrate`, `pnpm test`, ...) exist — they are planned, not present.

## Sources of truth

- `docs/NOTIFITRA_IMPLEMENTATION_PLAN.md` — master plan: adopted decisions (§0.4), architecture decisions (§1), phase checklists (§2), workflow (§3), testing strategy (§5), anti-scope-creep list (§9).
- `docs/NOTIFITRA_BRANCH_PLAN.md` — how to sequence work as git branches, with a dependency graph and merge prerequisites.

Read both before starting any work. The plan docs are the executable spec and win over the README where they conflict.

## Current status & next steps

Per the branch plan, no `feat/*` branch may open yet. Next steps are the foundational branches in order: `docs/project-charter` → `docs/architecture` → `chore/repo-scaffold`. `docs/decisions.md` (resolving §0.4 TBDs) and `docs/architecture.md` don't exist yet and must precede any scaffold.

## Workflow rules (from plan §3, enforced)

- Trunk-based: short-lived branches off `main`, merged via PR; `main` stays deployable.
- Branch prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `test/`; Conventional Commits.
- **TDD is required** for backend business logic, middleware, provider adapters, and worker code: commit the failing test BEFORE the implementation in the same branch/PR; reviewers verify commit ordering. NOT applied to dashboard UI, scaffolding, or CI/infra work (test-alongside instead).
- `chore/test-harness` is a hard gate — no `feat/*` branch before it merges. Follow the branch dependency graph.

## Adopted decisions — don't silently re-litigate (plan §0.4)

Single-tenant per deployment; optional `Idempotency-Key` header with 24h dedup; template versioning is latest-by-default unless `templateVersion` passed; webhook retries on 5xx/timeout but NOT 4xx; 90-day log retention (configurable); no batch / multi-recipient sends in v1; push targets via explicit `ntfyTopic`; single-region free-tier only.

## Deliberately out of scope (plan §9)

No Kubernetes, GraphQL, Redux/Zustand, microservices beyond API/worker, event bus beyond BullMQ, SMS adapter, multi-tenancy, batch sends, DLQ auto-replay UI, or Slack/Discord adapters in v1 — scope creep against the plan.

## Planned stack (target, not yet built)

TS + Hono API, BullMQ/Redis workers, Postgres, Handlebars, React dashboard in a pnpm workspace monorepo: `apps/api`, `apps/worker`, `apps/dashboard`, `packages/shared` (shared types + `NotificationAdapter` interface). Vitest; Drizzle ORM recommended (decision still open); notification IDs are ULIDs (`ntf_...`); integration tests use a dedicated `notifitra_test` DB with factory functions and mocked provider HTTP calls.
