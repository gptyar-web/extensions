# GPT Yar — shared Supabase deployment

Date: 2026-10-18 (UTC).

The user explicitly authorized use of the connected existing project.

- Project ref: `efibfevyiepkwpnobaro`
- Existing project name: `isfahan-education-system` (unchanged)
- Migration version/name: `20261018161002_gptyar_commerce`
- Application tables: 25, all named `public.gptyar_*`, all with RLS
- RPCs: `public.gptyar_*`, invoker rights, executable only by backend `service_role`
- Private buckets: `gptyar-videos`, `gptyar-posters`, `gptyar-releases`
- Function: `gptyar-api`, version 2, active, custom authentication
- Public base: https://efibfevyiepkwpnobaro.supabase.co/functions/v1/gptyar-api

## Verification

Existing 59 public tables retained their access/schema fingerprints, indexes, policies and functions. Existing Storage policies were inspected: permissive policies only cover the existing `assignment-files` bucket; the two ALL-command gates are restrictive policies. No pre-existing app grants, functions, policies or data were modified.

All 25 GPT Yar tables have RLS. Browser-role table grants and RPC execute privileges: zero. Backend-role read of actual prices and execution of actual metrics succeeded. Metrics are zero because there are no sales/subscriptions in the new application. Private storage bucket settings were queried after creation. Security Advisors had no GPT Yar findings; unrelated pre-existing project findings remain outside this change.

Live HTTPS smoke checks:

| Endpoint | Result |
|---|---|
| GET `/health` | 200, security/worker configuration explicitly false |
| GET `/public/catalog` | 200, actual DB prices 350000/10000000 IRR, sales disabled |
| POST `/public/check-for-update` | 200, no published update |
| GET `/api/account`, no session | 401 `SESSION_REQUIRED` |
| POST `/jobs/run`, no worker secret | 401 `WORKER_UNAUTHORIZED` |

The public TLS gateway forwards an internal HTTP URL to hosted functions. This was observed in the live test and fixed using the documented hosted-runtime deployment marker, without trusting a client-supplied forwarded-protocol header. A regression test covers the distinction.

## Still required

Set `GPTYAR_ACCOUNT_ID`, `GPTYAR_ENCRYPTION_KEY` and `GPTYAR_WORKER_SECRET` through a secure initial infrastructure setup. The current connector does not expose project secret management, so no secret was embedded in deployed function source, PostgreSQL or git to bypass this limitation. The function reports its missing configuration and refuses login before processing an admin token.

Install and verify the worker Cron schedule once its secret is configured. Merge/release the reviewed frontend branches to publish their configured public endpoint. Then complete bot/provider setup in the admin panel and run authorized live acceptance tests. No bot webhook, real payment, official wallet sandbox payment or upstream subscriber create/renew has been performed.

The shared project already has other applications' migration history. Do not use migration-history repair, reset or deletion to make a standalone application checkout appear synchronized. Future shared-project database changes must reconcile the full infrastructure migration history first.
