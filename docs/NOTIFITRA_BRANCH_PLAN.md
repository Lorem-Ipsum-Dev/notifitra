# Notifitra — Implementation Plan by Git Branch

Trunk-based workflow: every branch is short-lived, branches off `main`, and merges back via PR once CI is green and reviewed (per §3 of the main implementation plan). Branch names follow `feat/`, `fix/`, `chore/`, `docs/`, `test/` conventions.

Each branch below lists which plan phase it covers, its scope, and its merge prerequisite.

---

## Foundational branches

### `docs/project-charter`
- **Covers:** Phase 0 — Project Validation
- **Scope:** Resolve the TBD/Decision-Required table, write `docs/decisions.md`.
- **Merge prerequisite:** All open questions answered and signed off.

### `docs/architecture`
- **Covers:** Phase 1 — Architecture & Technical Decisions
- **Scope:** Commit `docs/architecture.md` (stack decisions, diagram), repo layout plan, package manager/Node version pin.
- **Merge prerequisite:** Peer review of the doc.
- **Depends on:** `docs/project-charter`

### `chore/repo-scaffold`
- **Covers:** Phase 2 — Repository & Development Environment Setup
- **Scope:** pnpm workspaces, `apps/api`, `apps/worker`, `apps/dashboard`, `packages/shared`, root tsconfig/ESLint/Prettier, `docker-compose.yml`, `.env.example`, root README quickstart, `pnpm dev` wiring.
- **Merge prerequisite:** Fresh clone + `pnpm install && docker compose up -d && pnpm dev` works end-to-end.
- **Depends on:** `docs/architecture`

---

## Database branch

### `feat/database-schema`
- **Covers:** Phase 3 — Database Design
- **Scope:** Choose ORM/migration tool, `api_keys`/`templates`/`notifications`/`delivery_attempts` tables, indexes, constraints, `docs/schema.md` + ER diagram, initial migration, seed script.
- **Merge prerequisite:** `pnpm db:migrate` runs clean; `EXPLAIN ANALYZE` confirms index usage on seed data.
- **Depends on:** `chore/repo-scaffold`

---

## Backend branches

> **TDD note:** starting with `chore/test-harness`, every branch in this section builds red-green-refactor: the failing test for a piece of behavior is committed before the implementation that satisfies it, in the same branch/PR. "Merge prerequisite" lines below assume this — a green test suite alone isn't sufficient if the tests were written after the fact.

### `chore/test-harness`
- **Covers:** Phase 4 — test-harness portion (new, TDD-driven addition to the plan)
- **Scope:** Dedicated `notifitra_test` Postgres DB + rollback strategy, factory functions for keys/templates/notifications, provider-mocking helpers (Resend/ntfy/webhook HTTP mocks), `pnpm test`/`pnpm test:integration` scripts wired to the test DB.
- **Merge prerequisite:** Harness is exercised by at least one throwaway example test to confirm it actually works end-to-end (test DB resets, factories produce valid rows, a mocked provider call is intercepted).
- **Depends on:** `feat/database-schema`
- **Note:** This branch must exist and merge **before** any other `feat/*` branch — TDD can't start without it. It's the one addition the TDD switch makes to the branch list itself.

### `feat/api-foundation`
- **Covers:** Phase 4 — Backend Foundation (middleware)
- **Scope:** Config/env validation, structured logging, global error handling, request validation middleware, API-key auth middleware, scope-check middleware, Redis-backed rate limiting, `/health`, OpenAPI wiring at `/docs`, BullMQ connection setup.
- **Merge prerequisite:** For each middleware item, its test commit predates its implementation commit; 401/403/429 integration tests pass against a dummy protected route.
- **Depends on:** `chore/test-harness`

### `feat/notifications-endpoint`
- **Covers:** Phase 5 (part 1) — `POST /v1/notifications`, `GET /v1/notifications/:id`, `GET /v1/notifications`, idempotency-key handling
- **Merge prerequisite:** Failing tests for each endpoint case (success, 403, 404, 400, idempotent-dedup) were committed before their implementations and are now green; endpoints match README's API Reference.
- **Depends on:** `feat/api-foundation`

### `feat/templates-crud`
- **Covers:** Phase 5 (part 2) — `POST/GET/PUT /v1/templates`, Handlebars syntax validation on save
- **Merge prerequisite:** The "invalid template rejected at save time" test was written and confirmed failing before the validation logic existed; now green.
- **Depends on:** `feat/api-foundation`
- **Parallelizable with:** `feat/notifications-endpoint`, `feat/api-keys`

### `feat/api-keys`
- **Covers:** Phase 5 (part 3) — `POST /v1/keys`, `DELETE /v1/keys/:id`, hashing, soft-delete/revoke
- **Merge prerequisite:** Tests for "plaintext shown once," "revoked key fails auth," and "history retained after revoke" were written first; now green.
- **Depends on:** `feat/api-foundation`
- **Parallelizable with:** `feat/notifications-endpoint`, `feat/templates-crud`

### `feat/email-adapter`
- **Covers:** Phase 5 (part 4a) — Email adapter (Resend + SMTP, switchable via `EMAIL_PROVIDER`)
- **Merge prerequisite:** Adapter's contract test (against mocked provider HTTP calls) was written before the adapter implementing `NotificationAdapter`; now green.
- **Depends on:** `feat/notifications-endpoint`

### `feat/push-adapter`
- **Covers:** Phase 5 (part 4b) — ntfy push adapter, resolves the topic-model decision from Phase 0
- **Merge prerequisite:** Adapter's contract test (against mocked ntfy endpoint) was written first; now green.
- **Depends on:** `feat/notifications-endpoint`, `docs/project-charter` (topic-model decision)
- **Parallelizable with:** `feat/email-adapter`, `feat/webhook-adapter`

### `feat/webhook-adapter`
- **Covers:** Phase 5 (part 4c) — Webhook adapter with per-key allow-listing and SSRF hardening
- **Merge prerequisite:** The SSRF test suite (blocks `169.254.169.254`, loopback, link-local, DNS-rebinding cases) was written and confirmed failing **before** the allow-list/IP-blocking code existed — this is the branch where TDD ordering matters most. Reviewed by a second person specifically for this ordering, not just for the final green result.
- **Depends on:** `feat/notifications-endpoint`
- **Parallelizable with:** `feat/email-adapter`, `feat/push-adapter`

### `feat/worker-dispatch`
- **Covers:** Phase 5 (part 5) — Worker: consume job, call adapter, retry/backoff, DLQ on exhaustion, write `delivery_attempts`, update notification status, DLQ inspection endpoint
- **Merge prerequisite:** The "N failures → DLQ with N logged attempts and terminal status" test was written before the retry/backoff/DLQ implementation; now green. Manual `curl` walkthrough of README's "Sending a Notification" example works end-to-end.
- **Depends on:** `feat/email-adapter`, `feat/push-adapter`, `feat/webhook-adapter`

---

## Frontend branches

### `feat/dashboard-shell`
- **Covers:** Phase 6 — Frontend Foundation
- **Scope:** Routing, admin auth, TanStack Query + generated OpenAPI client, layout/nav, Tailwind setup.
- **Merge prerequisite:** Authenticated shell makes real (typed) API calls against a running backend.
- **Depends on:** `feat/notifications-endpoint` (needs a stable-enough `/docs` spec); can start once that branch's spec stabilizes, ahead of full Phase 5 completion.

### `feat/dashboard-notifications-view`
- **Covers:** Phase 7 (part 1) — Notifications list, filters, detail view with attempt history
- **Merge prerequisite:** End-to-end click-through against live API.
- **Depends on:** `feat/dashboard-shell`, `feat/notifications-endpoint`
- **Parallelizable with:** other `feat/dashboard-*` branches

### `feat/dashboard-templates-editor`
- **Covers:** Phase 7 (part 2) — Template editor with live Handlebars preview (sandboxed render), version history
- **Merge prerequisite:** Preview renders in a script-free sandbox (XSS check).
- **Depends on:** `feat/dashboard-shell`, `feat/templates-crud`
- **Parallelizable with:** other `feat/dashboard-*` branches

### `feat/dashboard-key-management`
- **Covers:** Phase 7 (part 3) — API key create/list/revoke UI, one-time plaintext display
- **Merge prerequisite:** Plaintext key shown once with explicit warning; masked afterward.
- **Depends on:** `feat/dashboard-shell`, `feat/api-keys`
- **Parallelizable with:** other `feat/dashboard-*` branches

### `feat/dashboard-dlq-view`
- **Covers:** Phase 7 (part 4) — Dead-letter queue view (analytics widget stubbed/deferred per anti-scope-creep guidance)
- **Merge prerequisite:** DLQ entries visible with failure reason.
- **Depends on:** `feat/dashboard-shell`, `feat/worker-dispatch`
- **Parallelizable with:** other `feat/dashboard-*` branches

---

## Integration, testing, and hardening branches

> **TDD note:** under test-after, `test/automated-suite` used to be where the bulk of unit/integration coverage got written. Under TDD, that coverage already exists — it was written *inside* each `feat/*` branch above, before that branch's implementation. What's left here is genuinely cross-cutting work that no single `feat/*` branch owns: full-stack regression, an E2E script, load testing, and a coverage audit.

### `test/integration-regression`
- **Covers:** Phase 8 — Integration
- **Scope:** Full-stack manual + scripted regression pass, multi-worker duplicate-delivery check, Redis-persistence-on-restart check, template-version-freeze check.
- **Merge prerequisite:** No cross-service bugs found; findings documented.
- **Depends on:** All `feat/*` backend and dashboard branches merged.

### `test/suite-hardening` *(replaces `test/automated-suite`)*
- **Covers:** Phase 9 — Test Suite Hardening
- **Scope:** Git-history audit confirming test-before-implementation ordering across Phase 4/5 branches; fill any coverage gaps that individual per-endpoint TDD didn't naturally catch (e.g., multi-endpoint interactions); scripted E2E journey (create key → template → send → poll → log); load/soak test against free-tier-equivalent limits; manual QA checklist run on the dashboard.
- **Merge prerequisite:** Meets §5/§7 quality gates in the main plan; load-test report attached; audit confirms TDD ordering was actually followed, not just that tests exist.
- **Depends on:** `test/integration-regression`
- **Note:** Deliberately smaller in scope than the original `test/automated-suite` — most of what it used to cover now lives inside each `feat/*` branch.

### `fix/security-hardening`
- **Covers:** Phase 10 — Security Hardening
- **Scope:** Full §4 Must-have checklist pass — headers, CORS, audit fixes, least-privilege DB grants, log-scrubbing of `payload`/`data`.
- **Merge prerequisite:** Every "Must-have before production" item checked; second-person review of SSRF and template-sandbox code specifically — including confirming those tests were TDD'd (written before the code) back in `feat/webhook-adapter`/`feat/templates-crud`, not retrofitted here.
- **Depends on:** `test/suite-hardening`

---

## Delivery branches

### `chore/ci-cd-pipeline`
- **Covers:** Phase 11 — CI/CD
- **Scope:** `.github/workflows/ci.yml` (lint/typecheck/unit/integration with service containers), image build/push workflow, dashboard deploy workflow, branch protection rules.
- **Merge prerequisite:** A deliberately-broken PR is blocked; a good merge reaches staging automatically.
- **Depends on:** `chore/test-harness` (needs real tests to run in CI — and under TDD, those tests exist from `feat/api-foundation` onward, not just by Phase 9)
- **Note:** Start this branch early (right after `chore/repo-scaffold`) with just lint/typecheck, and extend it incrementally as each `feat/*` branch lands its tests. TDD makes this more natural than before: there's a growing test suite to run in CI from the very first `feat/*` merge, not a gap until Phase 9.

### `chore/staging-environment`
- **Covers:** Phase 12 — Staging Environment
- **Scope:** Provision staging Postgres/Redis, deploy API+worker and dashboard to staging, staging secrets, smoke-test script.
- **Merge prerequisite:** Staging smoke tests pass.
- **Depends on:** `fix/security-hardening`, `chore/ci-cd-pipeline`

### `chore/production-deployment`
- **Covers:** Phase 13 — Production Deployment
- **Scope:** Pre-production checklist, production infra provisioning, secret regeneration, domain/HTTPS, migration run, deployment, post-deployment checklist, rollback runbook.
- **Merge prerequisite:** Production smoke tests pass; one real notification sent and logged in production; rollback dry-run performed against staging.
- **Depends on:** `chore/staging-environment`

### `chore/monitoring-and-maintenance`
- **Covers:** Phase 14 — Post-Production
- **Scope:** Uptime monitoring, error tracking, DLQ-growth alerting, backup-restore test, maintenance cadence doc, roadmap revisit.
- **Merge prerequisite:** Each alert type test-fired at least once and confirmed received.
- **Depends on:** `chore/production-deployment`
- **Note:** This branch (and its successors) is ongoing, not a one-time merge — expect follow-up branches like `chore/dependency-updates-<date>` on a recurring cadence.

---

## Branch dependency graph (text form)

```
docs/project-charter
  └─ docs/architecture
       └─ chore/repo-scaffold
            ├─ feat/database-schema
            │    └─ chore/test-harness              ← NEW: must land before any TDD branch below
            │         └─ feat/api-foundation
            │              ├─ feat/notifications-endpoint
            │              │    ├─ feat/email-adapter    ─┐
            │              │    ├─ feat/push-adapter      ├─ feat/worker-dispatch
            │              │    ├─ feat/webhook-adapter   ─┘
            │              │    └─ feat/dashboard-shell
            │              │         ├─ feat/dashboard-notifications-view
            │              │         ├─ feat/dashboard-templates-editor ← feat/templates-crud
            │              │         ├─ feat/dashboard-key-management  ← feat/api-keys
            │              │         └─ feat/dashboard-dlq-view        ← feat/worker-dispatch
            │              ├─ feat/templates-crud
            │              └─ feat/api-keys
            └─ chore/ci-cd-pipeline (opened early, grows as each feat/* branch adds its TDD suite)

[all feat/* branches merged]
  └─ test/integration-regression
       └─ test/suite-hardening   (audit + E2E + load test — most unit/integration coverage already exists)
            └─ fix/security-hardening
                 └─ chore/staging-environment
                      └─ chore/production-deployment
                           └─ chore/monitoring-and-maintenance (ongoing)
```

---

## Notes on parallelization

- **`chore/test-harness` is a new, hard gate.** No other `feat/*` branch should open until it merges — TDD needs the test DB, factories, and provider mocks to exist before the first failing test can even be written.
- Once `feat/api-foundation` merges, `feat/notifications-endpoint`, `feat/templates-crud`, and `feat/api-keys` can all be worked in parallel by different contributors — each still following red-green-refactor independently.
- Once `feat/notifications-endpoint` merges, the three adapter branches (`email`/`push`/`webhook`) can be worked in parallel — they share the `NotificationAdapter` interface but touch different files, and each writes its own contract test first.
- `feat/dashboard-shell` can open as soon as the OpenAPI spec from `feat/notifications-endpoint` is stable, even before `feat/templates-crud`/`feat/api-keys` finish — the four `feat/dashboard-*` view branches then parallelize against their respective backend branches. Dashboard work follows manual QA / test-alongside rather than strict TDD (see the main plan's §1 TDD decision).
- `chore/ci-cd-pipeline` should not wait for `test/suite-hardening` — open it right after `chore/repo-scaffold` with lint/typecheck only, then add test stages as each `feat/*` branch's TDD suite lands. Under TDD there's meaningful test coverage to run in CI far earlier than before.
- Do not open `fix/security-hardening` as an afterthought — SSRF and template-sandbox protections must already exist, test-first, inside `feat/webhook-adapter` and `feat/templates-crud`; this branch is the audit/closing pass (including verifying the TDD ordering was actually followed), not the first implementation of those protections.
- **What changed from the original plan:** `test/automated-suite` (which used to be where most tests got written) is renamed/shrunk to `test/suite-hardening` and now mainly audits, fills gaps, and adds cross-cutting E2E/load tests — because TDD moved the bulk of test-writing into each `feat/*` branch, ahead of its implementation, instead of after.
