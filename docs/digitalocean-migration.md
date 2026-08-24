# Moving the deploy from Render to DigitalOcean

Status: **PLANNED, not started.** Written 2026-08-21 after Render warned at 70% of its
5 GB monthly outbound allowance.

Nima: *"its better it all exist in one location in my mind and we dont want to keep
hitting these walls"* — the database is already DigitalOcean (`workhub-db`, SFO3), so
this puts the app beside it.

## Why move (and why it is not only about the wall)

| | Render Hobby | DO App Platform |
|---|---|---|
| included outbound | **5 GB** | **50 GiB** at $5/mo · 200 GiB at $10 |
| overage | $15 / 100 GB = **$0.15/GB** | **$0.02/GiB** |
| spin-down | free tier sleeps after 15 min | paid instances stay up |

Ten times the allowance and **7.5x cheaper overage**. Two arguments that matter more
than the price:

- **One provider, one bill.** The database already costs $15.15/mo on DO.
- ⚠️ **LATENCY, WHICH IS NOT FREE EVEN WHEN TRANSFER IS.** Render runs in
  `gcp-us-west1` and the database is in **SFO3**. That cross-provider hop is the ~29ms
  per-query floor measured 2026-08-21, paid on roughly **157k queries/day**. Putting
  the app in SFO3 removes it. This was already the reasoning behind choosing SFO3 for
  the database (see CLAUDE.md) — the app never followed.
- **Private networking.** A DO app can reach a DO managed database over the VPC, which
  means that traffic is not public egress at all.

## Where to read the bandwidth breakdown (do this FIRST)

Render exposes it in two places (confirmed against their docs 2026-08-21):

- **Per service** — the service's **Metrics** page has an **Outbound Bandwidth** graph
  broken down **BY TRAFFIC TYPE**. This is the attribution that decides whether moving
  is the fix or a distraction.
- **Workspace total** — <https://dashboard.render.com/billing>, the cumulative monthly
  figure the warning email quotes.

### ⚠️ THE DATABASE LEG IS BILLED OUTBOUND ON RENDER, AND CANNOT NOT BE

Render bills "service-initiated communication outside Render" and explicitly does NOT
bill "private network traffic between Render services in the same region".

**`workhub-db` is not a Render service**, so it can never qualify for the free
same-region path. Every query the deploy sends to DigitalOcean SFO3 is billed outbound
— and the deploy makes roughly **157k queries/day**. The same applies to every
service-initiated sync: NetSuite, Gmail, Orderful, ShipStation, and in particular the
warehouse-feed PUSH, which sends real payloads out.

⚠️ This is a HYPOTHESIS until the traffic-type graph confirms it. Query text is small
and the responses coming back are INBOUND (not billed), so the honest position is
"plausibly hundreds of MB/month, and the graph will say". Do not repeat it as a
measured cause.

**Either way it sharpens the decision:**

- browser traffic dominates → #156 already removed 2.2 MB per uncached load, and the
  move is optional (latency and tidiness, not necessity)
- service-initiated traffic dominates → the move is the actual fix, and no amount of
  image squeezing would ever have helped

And it adds an argument the price table misses: on DO App Platform in SFO3, with the
app in the database's trusted sources, the database leg becomes DO private-network
traffic, which DO does not meter either. **The move does not just buy a bigger bucket
for that leg — it removes the metering.**

⚠️ **This is the SECOND metered wall in two weeks** — Neon suspended over 5 GB of
transfer on 08-17. That one turned out to be caused by *our own tooling*, not real
usage. So: read Render's bandwidth breakdown before assuming the move is the fix.
Already found and fixed one real cause (#156: 2,780 KB of oversized portraits, the one
thing Cloudflare's Brotli cannot compress). Moving hosts to escape a number nobody has
explained just carries the waste into a bigger bucket.

## What actually moves

Only the **web service**. Nothing about the database changes — same cluster, same
credentials, same region.

## Steps

### 1. Confirm authority on the company account (BLOCKING — see below)

### 2. Create the app
`.do/app.yaml` in this repo is the App Platform spec, the counterpart to `render.yaml`.
DO reads it the same way: **Apps → Create → GitHub repo → it detects the spec.**

- Region **SFO3** (`sfo`) — the whole latency argument above depends on this.
- Instance `apps-s-1vcpu-1gb` ($10/mo, 100 GiB) or `apps-s-1vcpu-0.5gb` ($5/mo,
  50 GiB). ⚠️ CLAUDE.md notes DO managed Postgres is **one vCPU**; the app being
  small is fine, but do not pick the free static tier — this is a Node service.

### 3. Environment variables — 19 of them
Every one is `sync: false` in `render.yaml`, meaning **no secret is in git** and each
must be pasted into the DO console by hand. Copy them from Render's Environment tab
(or `.env.local`):

```
DATABASE_URL  DATABASE_URL_NEON  SITE_PASSWORD  CRON_SECRET
NS_ACCOUNT_ID  NS_CONSUMER_KEY  NS_CONSUMER_SECRET  NS_TOKEN_ID  NS_TOKEN_SECRET
SHIPSTATION_API_KEY  SHIPSTATION_API_SECRET  SHIPSTATION_API_KEY_V2
GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET  GOOGLE_REFRESH_TOKEN
ORDERFUL_API_KEY  WAREHOUSE_SUPABASE_URL  WAREHOUSE_SUPABASE_KEY  SLACK_BOT_TOKEN
```

⚠️ **`DATABASE_URL_NEON` MUST COME TOO.** Neon still holds the only copy of the
app-owned rows written to the deploy after the mirror was cloned 2026-08-17 — five
orders' `DEPARTURE_CONFIRMED` among them. See CLAUDE.md.

⚠️ **I cannot enter these for you and will not ask you to paste them to me.** Secrets
go from your password manager into the DO console directly.

### 4. TLS to the database
Render uses `?uselibpqcompat=true&sslmode=require` because it has no CA file on disk.
`src/db.js` already applies the committed CA (`db/do-ca-certificate.crt`) in code for
any DigitalOcean host, so **the same `DATABASE_URL` works unchanged**. Proven by
tampering (a bogus CA and an absent CA are both refused).

If the app is added to the database's **Trusted Sources**, it can use the private VPC
hostname instead — better on both latency and egress. Do this AFTER the app is up, so
a connection failure has only one possible cause at a time.

### 5. The cron changes meaning, and must not be deleted
`.github/workflows/recurring-check.yml` hits `/api/internal/recurring-check` hourly.
It was doing **two** jobs: firing the recurring checks *and* keeping Render's free
instance from sleeping. On a paid DO instance the second job disappears — but the
first still matters. **Keep the workflow, update `RENDER_URL`** (the GitHub Actions
secret) to the DO URL. Renaming that secret is optional churn; note it either way.

### 6. Verify before switching, using the same standard as everything else
- [ ] `curl -s <do-url>/api/sync-health` answers (it is behind `SITE_PASSWORD`, so
      expect 401 without auth — a 401 proves the app is *up*, a 502 proves it is not)
- [ ] the served bundle hash matches `client/dist/index.html` from the deployed commit
      — ⚠️ *this exact check caught port 3001 serving a different worktree on 08-21*
- [ ] `npm run check:counters` still 24/26 against the same database
- [ ] the DB shows connections from the new app (`pg_stat_activity`)
- [ ] ⚠️ **pool size**: `src/model/poolLimits.js` gives the deploy 8 connections of the
      plan's 22. With BOTH Render and DO running during the cutover that is 16 —
      inside the limit, but do not also run local scripts during the overlap.

### 7. Cut over, then stop Render
Keep Render running until DO is verified. Then **suspend, do not delete** for a week.

## Rollback
Render stays deployable from the same repo — `render.yaml` is untouched by this plan.
Rollback is re-enabling the Render service. Nothing about the database moves, so there
is no data rollback to perform.

## ⚠️ Using a company DigitalOcean account

Nima asked whether this is usable given he is not the account holder. That is an
authorisation question, not a technical one, and worth being explicit about:

- **Precedent already exists.** `workhub-db` — the production database this app has
  run on since 2026-08-18 — is already on that account. Adding the app is the same
  kind of action, on the same account, for the same tool.
- **It is arguably the CORRECT home.** This is an internal Naghedi tool. A company
  account is a better place for it than a personal Render account.
- **Confirm authority to add a paid resource** (~$5–10/mo on top of the existing
  $15.15). Small, but it is someone else's budget.
- ⚠️ **Bus factor, and this is the real risk.** If Nima's access to that account is
  ever removed, the app and the database go with it. Whoever owns the account should
  know these resources exist. Put both in a named DO **project** so they are not
  loose objects someone tidies away.
- **What is NOT a concern:** the data. It is already there.

## What I can and cannot do

**I can:** write and maintain `.do/app.yaml`, prepare the env-var list, adapt
`src/db.js` or the cron if needed, run every verification above, and diagnose failures
from the logs.

**I cannot, and will not:** create the app in the DO console, enter credentials or
secrets anywhere, or accept billing terms. Those are yours — and I will not ask you to
paste a secret into this chat.
