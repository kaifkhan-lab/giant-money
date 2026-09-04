# Deploying Giant Money

## Why Firebase Hosting on its own will not work

Firebase Hosting serves **static files**. Giant Money is a **running server**, and three
things in it need a real, always-on process with a writable disk:

| Requirement | Where it comes from | Why serverless breaks it |
|---|---|---|
| A writable SQLite file | `src/db.js` — `new Database(...)` | Hosting and Cloud Functions have an ephemeral filesystem. The database, **including user accounts**, is wiped on every cold start. |
| A 24/7 scheduler | `src/scheduler.js` — 15 cron jobs | A function only lives for the length of one request, so the filing loop never runs. |
| A compiled native module | `better-sqlite3` | Needs to be built for the target runtime. |

So the choice is not "which host is best" but **"which hosts can run a stateful Node process"**.

---

## Option A — Fly.io (recommended)

Real persistent volumes, stays awake, and the config is already in this repo
(`Dockerfile`, `fly.toml`).

```bash
# once
curl -L https://fly.io/install.sh | sh
fly auth signup

# create the app (the name must be globally unique — edit fly.toml to match)
fly apps create giant-money-hasan

# the database lives here and survives every redeploy
fly volumes create gm_data --size 1 --region iad --app giant-money-hasan

# tell SEC who you are (their fair-access policy expects a real contact)
fly secrets set SEC_USER_AGENT="GIANT-MONEY research you@example.com" --app giant-money-hasan

fly deploy --app giant-money-hasan
```

Result: `https://giant-money-hasan.fly.dev`, always on, database intact across deploys.

---

## Option B — Firebase Hosting + Cloud Run  ← configured in this repo

`firebase.json`, `.firebaserc` and `.gcloudignore` are already written for this.

**How the two halves split the work**

| Request | Served by |
|---|---|
| `styles.css`, `app.js`, `assets/*.svg` | Firebase CDN (fast, cached) |
| `/`, `/app`, `/login`, `/classic` | Cloud Run (Express decides which HTML) |
| `/api/**`, `/healthz` | Cloud Run |

The `.html` files are deliberately **excluded** from the Hosting deploy. Firebase serves
static files *before* it applies rewrites, so a deployed `public/index.html` would hijack
`/` and show the old `/classic` page instead of the real landing. Leaving the HTML out of
Hosting lets every page fall through to Cloud Run, which already routes them correctly.

### Steps

```bash
# 1 — install the two CLIs (neither is on this Mac yet)
npm install -g firebase-tools
curl https://sdk.cloud.google.com | bash && exec -l $SHELL

# 2 — sign in and pick the project
firebase login
gcloud auth login
firebase use --add                      # writes your real project id into .firebaserc
gcloud config set project YOUR_PROJECT_ID

# 3 — enable the services Cloud Run needs (one time)
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 4 — build the container from the Dockerfile in this repo
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/giant-money

# 5 — run it. min-instances=1 is what keeps the 24/7 filing loop alive.
gcloud run deploy giant-money \
  --image gcr.io/YOUR_PROJECT_ID/giant-money \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --memory 512Mi \
  --timeout 300 \
  --set-env-vars SEC_USER_AGENT="GIANT-MONEY research you@example.com"

# 6 — point the Firebase domain at that service
firebase deploy --only hosting
```

Result: `https://YOUR_PROJECT_ID.web.app`

Keep the region in the `gcloud run deploy` command and in `firebase.json` **identical**,
otherwise the rewrite cannot find the service.


Use this if you want to stay inside Firebase/Google. Hosting handles the domain and
CDN; the actual server runs as a container on **Cloud Run**, and `firebase.json`
rewrites every request to it.

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# build the image from the Dockerfile already in this repo
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/giant-money

# min-instances=1 keeps one container warm so the cron loop keeps running
gcloud run deploy giant-money \
  --image gcr.io/YOUR_PROJECT_ID/giant-money \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --memory 512Mi \
  --set-env-vars SEC_USER_AGENT="GIANT-MONEY research you@example.com"

# point the Firebase domain at that service
firebase deploy --only hosting
```

### The one catch you must decide about

Cloud Run's own filesystem is **ephemeral**. Two ways to handle the database:

1. **Mount a volume** (keeps accounts and watchlists safely):

   ```bash
   gcloud run services update giant-money --region us-central1 \
     --add-volume name=gmdata,type=nfs,location=<FILESTORE_IP>:/gm \
     --add-volume-mount volume=gmdata,mount-path=/data
   ```

   Filestore costs noticeably more than a Fly volume. Do **not** put SQLite on a
   GCS-FUSE mount — SQLite over an object-store filesystem risks corruption.

2. **Accept a rebuild on restart.** The app self-heals: `seedFunds()` and
   `bootstrap()` re-ingest all market data from the public sources on boot, so
   filings and prices come back within minutes. What does **not** come back is
   anything a person typed — **user accounts, watchlists, portfolios, alerts**.
   Only choose this if you have no signed-up users yet.

`min-instances 1` means Cloud Run bills for a container that never scales to zero,
which is what makes the 24/7 loop possible. Budget for that.

---

## Option C — Render or Railway

Both run a container with an attached disk and need no CLI gymnastics: connect the
GitHub repo, add a 1 GB disk mounted at `/data`, set `DATA_DIR=/data`, deploy.
On Render, the free tier sleeps after 15 minutes of inactivity, which stops the
scheduler — pick the paid always-on tier if the loop matters.

---

## Environment variables

| Name | Needed? | Purpose |
|---|---|---|
| `PORT` | host usually sets it | Port to listen on (defaults to 4600) |
| `DATA_DIR` | **yes, when hosted** | Where SQLite and the cookie jar are written. Point it at the mounted volume, e.g. `/data`. |
| `SEC_USER_AGENT` | **yes, when public** | EDGAR throttles requests that do not declare a real contact. |
| `ANTHROPIC_API_KEY` | optional | Enables Claude-written news summaries; without it a labelled local fallback is used. |
| `DISABLE_SCHEDULER` | optional | Set to `1` to run the API without the cron loop (for a second, read-only instance). |
