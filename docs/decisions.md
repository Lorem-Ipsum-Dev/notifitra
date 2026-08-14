# Notifitra — Project Charter & Decisions

**Status:** Ratified — Phase 0 (Project Validation) complete.
**Owner:** Lorem-Ipsum-Dev
**Last updated:** 2026-08-14

This document is the committed record of Notifitra's project decisions. It ratifies the adopted decisions from `docs/NOTIFITRA_IMPLEMENTATION_PLAN.md` (§0.4) and records the Phase 0 validation results. It is a living record: revisit entries deliberately if a decision turns out to be wrong — do not silently change them.

---

## 1. Phase 0 validation results

| Question | Decision | Impact |
|---|---|---|
| **v1 channels** | Email + webhook + push (all three README channels) | All three provider adapters in scope; SMS stays out (§9). |
| **Deployment path** | Managed free-tier PaaS | Render/Fly (API+worker), Upstash (Redis), Neon/Supabase (Postgres), Cloudflare Pages/Vercel (dashboard). VPS self-host via `docker-compose.prod.yml` documented but not the target. |
| **Expected volume** | Low — hundreds of notifications/day | Confirms free-tier limits are comfortable; no early scaling work. Phase 9 load test still sanity-checks the low end. |
| **Dashboard users** | Just me | Single admin account (email+password or magic link) is sufficient for v1; multi-user RBAC deferred (§4 nice-to-have). |

---

## 2. Adopted decisions — ratified (§0.4)

All ten rows of the §0.4 table are **ratified as-is**, no overrides. Restated here for reference:

| # | Decision |
|---|---|
| 1 | Admin dashboard auth: simple single-tenant login behind a `.env`-configured admin account. |
| 2 | **Single-tenant per deployment** — one deployment serves one org/person. |
| 3 | Push targets via explicit `ntfyTopic` carried in the notification payload. |
| 4 | Optional `Idempotency-Key` header; dedup window in Postgres, **24h**. |
| 5 | No batch / multi-recipient sends in v1 (roadmap item). |
| 6 | Template versioning: latest published version by default, unless `templateVersion` passed. |
| 7 | Webhook retries on 5xx/timeout/network error; **no retry on 4xx** (permanent failure). |
| 8 | Delivery-log retention: **90 days**, configurable. |
| 9 | DLQ queryable via API + dashboard view; manual replay deferred as fast-follow. |
| 10 | Single-region, free-tier-scale deployment; no multi-region/HA in v1. |

---

## 3. Open questions resolved by this charter

- **Push topic model** (#3): payload carries `ntfyTopic` explicitly — no stored per-recipient mapping in v1.
- **Idempotency window** (#4): fixed at 24h.
- **Auth** (#1): single admin account, `.env`-configured.

These are now locked inputs for Phase 3 (database design) and `feat/push-adapter`.

---

## 4. Standing constraints

- Revisit this document only via a deliberate decision (new row, dated), never by silent edit.
- Any override to §2 must be recorded here **before** it lands in code, to avoid plan drift.
