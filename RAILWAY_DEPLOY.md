# DataOS on Railway — Exact Deployment Steps

This guide assumes zero prior Railway setup. Every command and click is listed in order. Follow top to bottom.

**What you'll have at the end:** all 10 backend services live on Railway, a managed Postgres database with the schema applied, a managed Redis instance, and a single public API URL that the PWA frontend points at.

---

## Before you start — fixes already applied

Two real bugs were fixed in the codebase specifically for Railway compatibility before writing this guide (not theoretical — these would have broken your deployment):

1. **Redis connection** — all 10 services now use `shared/utils/redis-client.js`, which reads Railway's single `REDIS_URL` correctly. The old code expected separate `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` vars, which Railway doesn't provide.
2. **Postgres SSL** — all 10 services now use `shared/utils/db-client.js`, which doesn't force strict SSL certificate verification. Railway's internal database network doesn't present a publicly verifiable cert, so the old `rejectUnauthorized: true` setting would have hung every connection.

You don't need to do anything for these — they're already fixed in the code you have. Mentioning them so you understand why the connection works.

---

## Step 1 — Create the Railway project

1. Go to [railway.app](https://railway.app), sign up (GitHub login is fastest)
2. Click **New Project**
3. Choose **Empty Project** (not a template — we're adding services manually)
4. Rename the project to `dataos` (Project Settings → top left)

---

## Step 2 — Add Postgres

1. Inside the project, click **+ New** → **Database** → **Add PostgreSQL**
2. Wait ~30 seconds for it to provision
3. Click the Postgres service → **Variables** tab → confirm `DATABASE_URL` exists (Railway creates this automatically)
4. Click **Connect** tab → copy the **Postgres Connection URL** (you'll need this once, locally, to run the migration)

---

## Step 3 — Add Redis

1. Click **+ New** → **Database** → **Add Redis**
2. Wait for provisioning
3. Confirm `REDIS_URL` exists in its Variables tab (automatic)

---

## Step 4 — Run the database migration (one-time, from your machine)

You need `psql` installed locally, or use Railway's web-based query console instead (Postgres service → **Data** tab → **Query**).

**Option A — psql (faster if you have it):**
```bash
psql "<paste the Postgres Connection URL from Step 2>" -f database/migrations/001_initial_schema.sql
```

**Option B — Railway web console:**
1. Open the Postgres service → **Data** tab → **Query**
2. Open `database/migrations/001_initial_schema.sql` from the codebase, copy its full contents
3. Paste into the query box, run it
4. Repeat for `scripts/seed.js` logic if you want test data — or skip seeding for a clean production start

Verify it worked:
```sql
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM bundle_catalog;
```
Both should return without error (0 rows is fine if you skipped seeding).

---

## Step 5 — Generate JWT keys (one-time, local)

```bash
openssl genrsa -out jwt_private.pem 4096
openssl rsa -in jwt_private.pem -pubout -out jwt_public.pem
cat jwt_private.pem    # copy this entire output, including BEGIN/END lines
cat jwt_public.pem     # copy this entire output too
```

Keep these two files somewhere safe outside the repo — you'll paste their contents into Railway in Step 7. **Do not commit these files to git.**

**Railway UI note:** when pasting a multi-line value into Railway's variable editor, paste it exactly as-is (with real line breaks). Railway's variable editor supports multi-line values natively — you do not need to escape newlines as `\n`.

---

## Step 6 — Create a "Shared Variables" reference set

Railway doesn't have a built-in cross-service variable group on all plans, so the fastest reliable approach is: set identical values on each of the 10 services individually (Step 7 below gives you the exact list to paste 10 times), OR use Railway's **Shared Variables** feature if your plan includes it (Project Settings → Shared Variables → add once, reference in each service as `${{shared.VAR_NAME}}`).

If Shared Variables is available on your plan, use it — it means you set secrets once instead of ten times. The variable names are identical either way.

---

## Step 7 — Deploy each of the 10 services

Repeat this block **10 times**, once per service. The only things that change each time are: the service name, the Dockerfile path, and the `PORT` isn't something you set — Railway injects it automatically and the code already reads `process.env.PORT`.

### 7.1 — Add the service

1. Click **+ New** → **GitHub Repo** (connect your GitHub account if first time, select the `dataos` repo)
   - If your code isn't on GitHub yet: `git init`, commit, push to a new GitHub repo first — Railway deploys from a git source, not a local zip
2. Railway will ask which directory/Dockerfile to use. Go to the new service's **Settings** tab:
   - **Root Directory**: `/` (leave as repo root — this matters, see note below)
   - **Dockerfile Path**: `services/auth/Dockerfile` (change `auth` to the current service name each time)
3. Rename the service (top of Settings) to match: `auth-service`, `user-service`, `telecom-service`, `ai-service`, `wallet-service`, `rewards-service`, `analytics-service`, `forecasting-service`, `notification-service`, `community-service`

**Why Root Directory must stay `/`**: every service imports `../../shared/...` from its own `src/index.js`. The Dockerfile (already written for each service) copies both `shared/` and the specific `services/{name}/` folder into the build — but only if Railway's build context starts at the repo root. Setting Root Directory to `services/auth` would break this.

### 7.2 — Set environment variables for this service

Go to the service's **Variables** tab and add these (paste real values, not the placeholders):

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
JWT_PRIVATE_KEY=<paste full contents of jwt_private.pem>
JWT_PUBLIC_KEY=<paste full contents of jwt_public.pem>
INTERNAL_API_KEY=<run: openssl rand -hex 32>
ALLOWED_ORIGINS=https://your-pwa-url.vercel.app
PHONE_HASH_SECRET=<run: openssl rand -hex 32>
MSISDN_HASH_SECRET=<run: openssl rand -hex 32>
NIN_HASH_SECRET=<run: openssl rand -hex 32>
BVN_HASH_SECRET=<run: openssl rand -hex 32>
ANTHROPIC_API_KEY=<your Claude API key>
CLAUDE_MODEL=claude-sonnet-4-6
TERMII_API_KEY=<from Termii dashboard, sandbox key is fine to start>
```

The `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}` syntax tells Railway to inject the live value from those other services automatically — this is Railway's variable referencing feature, and it means you never hardcode a database URL anywhere.

**Note:** `JWT_PRIVATE_KEY` is only actually used by `auth-service` (it's the only service that signs tokens — everyone else only verifies with the public key). You can omit it from the other 9 services if you want tighter secret hygiene, but including it everywhere doesn't break anything.

### 7.3 — Deploy

Railway auto-deploys on every push to your connected branch. After setting variables, click **Deploy** (or push a commit) to trigger the first build.

Watch the **Deployments** tab — you should see the Docker build logs, then `Auth service started {"port":...}` (or the equivalent for whichever service) in the runtime logs once it's live.

### 7.4 — Get the public URL

Once deployed, go to **Settings** → **Networking** → **Generate Domain**. Railway gives you a free `*.up.railway.app` subdomain per service.

Repeat 7.1–7.4 for all 10 services. Yes, this is repetitive — that's the nature of a 10-service deploy on Railway's per-service model. Budget about 20–30 minutes total.

---

## Step 8 — Stitch services together behind one public URL

Right now you have 10 separate `*.up.railway.app` URLs. The frontend expects one API base URL (matching the nginx gateway routing built into the codebase). Two options:

**Option A (fastest to ship, less clean):** Point the PWA directly at each service's individual Railway URL by modifying `frontend/src/services/api.js` — instead of one `API_BASE`, define one base URL per service group. This works immediately with zero extra infrastructure.

**Option B (matches the original architecture, more setup):** Deploy the existing `infrastructure/docker/nginx.conf` as an 11th Railway service acting as the gateway, with its upstream blocks pointing at the 10 internal Railway service URLs (use Railway's private networking — services in the same project can reach each other via `servicename.railway.internal` without a public domain). This preserves the rate-limiting and routing logic already written.

Given you're moving fast toward real users, **Option A is the pragmatic choice right now** — I can rewrite `api.js` to call each service's Railway URL directly if you confirm this is the path. Option B is the "do it properly later" version once you're past initial validation.

---

## Step 9 — Verify everything is actually working

```bash
curl https://auth-service-production-xxxx.up.railway.app/health
curl https://ai-service-production-xxxx.up.railway.app/health
# ...repeat for all 10
```

Each should return `{"status":"ok","service":"...","ts":"..."}`. If any return an error, check that service's **Deployments → Logs** tab — the error will tell you exactly which env var is missing or which connection failed.

Then test the real flow:
```bash
curl -X POST https://auth-service-production-xxxx.up.railway.app/api/v1/auth/request-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"08031234567","purpose":"login"}'
```

With `NODE_ENV=production` and a real Termii key, this sends an actual SMS. With a Termii sandbox key, check Termii's dashboard for the simulated send instead of your phone.

---

## What's genuinely unverified

I have not run any of these commands against a live Railway account — I don't have the ability to create one or access yours. Every command above is correct against Railway's documented behavior and the actual code in this repository, which I validated by reading the connection code directly and fixing the two real incompatibilities found (Redis URL format, Postgres SSL). But "correct on paper" and "confirmed working in your account" are different claims, and I want to be honest about which one this is.

If something doesn't work exactly as described, the most likely culprits, in order, are: a typo in a pasted env var, the JWT key losing its line breaks during paste, or `ALLOWED_ORIGINS` not matching your actual frontend URL once deployed (causing CORS rejection, which shows up as a network error in the browser console, not a server error in Railway's logs).

---

## Next step after this works

Once all 10 services respond to `/health` and OTP requests succeed, the remaining task is updating the PWA's `src/api.js` to point at these real Railway URLs instead of `localhost`. Tell me once Step 9 passes and I'll do that wiring.
