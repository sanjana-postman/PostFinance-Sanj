# SE Demo API — template

A FastAPI demo bank API (accounts/transactions), pre-wired for Postman Collections/Monitors and
the Postman Insights Agent, that you deploy to the shared multi-tenant demo hosting platform
under your own path (`http://<shared-hostname>/<your-se-name>/dev/` and `.../prod/` — plain HTTP,
since this platform doesn't set up a custom domain/ACM cert).

You cloned this from a GitHub template — this copy is yours to customize. There is no separate
infra repo to clone; onboarding (below) handles everything on the AWS side remotely.

## Prerequisites

- **AWS credentials** for the shared platform account, with onboarding permissions (ask the
  platform admin if you don't have these — this is the entire access-control model for
  onboarding, there's no separate signup step).
- **Your AWS CLI's configured region** (`aws configure get region`) must point at a region where
  a platform has actually been deployed — the platform is region-siloed (each region is a fully
  independent deployment), and onboarding deploys into whichever region your CLI is pointed at.
  If you're in Europe and a platform exists in `eu-west-1`, point your CLI there; onboarding
  checks this up front and fails with a clear message if nothing exists in your current region.
- **`gh` CLI**, authenticated (`gh auth login`) — onboarding sets your own repo's Actions
  variables using your own GitHub permissions, not the platform's.
- **Node.js 18+** (for the onboarding script) and **`kubectl`** (onboarding uses it to discover
  the shared ALB's hostname).
- **Docker, running** — onboarding builds and pushes your first container image itself (targeting
  `linux/amd64` regardless of your own machine's architecture, since the cluster is amd64-only),
  so your app is actually running by the time the script finishes rather than waiting on your
  first CI-triggering push.
- **[`uv`](https://docs.astral.sh/uv/)** and **Python 3.12+** for local app development.
- **Your own Postman workspace**, already set up — see "Postman setup" below. This is the one
  thing onboarding cannot do for you.

## Onboarding

1. Complete the Postman setup steps below FIRST. The onboarding script will ask you to confirm
   this; it does **not** need you to paste your workspace ID — that's already sitting in
   `.postman/resources.yaml` (written by step 2's "Push to Postman Cloud"), so onboarding reads it
   from there automatically. It also looks up your two System Environment IDs automatically by
   name via the Postman API Catalog (accepts either `staging`/`prod` or `Development`/`Production`),
   falling back to asking for them manually only if that lookup can't find both.
2. Install onboarding script dependencies and run it:
   ```bash
   npm install
   npx ts-node scripts/onboard.ts
   ```
   It will: switch you to your local `develop` branch (created if it doesn't exist yet — every
   local file change below happens there, not on whatever branch you had checked out), register
   you in the platform's registry, generate and store your app's admin credentials, deploy your
   own `SeStack-<you>` (namespace, ECR repo, ingress rule — **never touches the shared cluster
   itself**), **build and push your first container image and get both environments actually
   running** (no need to wait for a CI-triggering push first), configure this repo's GitHub
   Actions variables and secrets (including `POSTMAN_API_KEY`, needed by CI's `lint`/`test`
   jobs), rewrite `postman/environments/AWS Dev.environment.yaml` /
   `AWS Prod.environment.yaml` with your live URL and credentials **and push those same values
   directly to your live Postman environments** (by their existing cloud ID, so it can't disturb
   the System Environment link you set up in step 1 — no manual push needed for this, unless
   you're onboarding for the very first time before that ID exists yet), move
   `.github/workflows-staging/deploy.yml` into `.github/workflows/` (kept out of the active
   location until now — otherwise the very first push creating this repo would trigger an
   immediate, guaranteed-to-fail CI run, before any of the above existed), and then **print a
   checklist for you to work through by hand** before committing anything yourself — the script
   deliberately does NOT commit, push, or open a PR automatically, because `.postman/resources.yaml`
   can still be mid-sync from the desktop app at this point, and baking a stale sync into git
   history (plus triggering a real deploy from it, since pushing `develop` does that immediately)
   is worse than a short manual check. The checklist has you confirm `.postman/resources.yaml`
   finished syncing and the live "AWS Dev"/"AWS Prod" environments show the right values, then
   gives you the exact `git add .` / `git commit` / `git push -u origin develop` / `gh pr create`
   commands to run yourself.
3. Review and merge that pull request when ready — merging deploys to prod the same way. Your app
   is already live in both environments before that, though; future pushes to `develop`/`main`
   deploy new app images via CI exactly as normal (see "CI/CD" below).

Re-running `scripts/onboard.ts` is safe — every step is idempotent.

## Postman setup (manual, one-time, per your workspace)

The onboarding script deliberately does **not** call the Postman API on your behalf — it only
confirms you've done this yourself:

1. Create or select a Postman **team** workspace (Insights' Native Git feature doesn't support
   personal workspaces).
2. If this workspace has never used Insights before: open it in the **Postman desktop app**,
   **Files > Open folder** → this repo's local clone, then **Push to Postman Cloud** at least
   once. This is desktop-app-only — there's no REST API or CLI equivalent, and skipping it
   produces a sidecar that looks healthy (`2/2 Running`) but silently never reports traffic.
3. Confirm the template collection (`postman/collections/PostFinanceCo API/`) is in your workspace —
   step 2's "Push to Postman Cloud" already syncs it there if it wasn't already.
4. Under **API Catalog > Integrated Services**, create two **System Environments** — one for
   staging, one for prod. Either naming convention works (`staging`/`prod` or
   `Development`/`Production`); onboarding recognizes both and looks them up automatically, so
   you never have to find or paste their IDs yourself. No need to
   include your own name in them: you have your own separate Postman team/instance, so there's
   nothing else in there to collide with.
5. Generate a Postman API key from an account with **team-level Admin or Super Admin** —
   workspace-scoped-only Admin access authenticates fine on ordinary Postman REST calls but
   makes the Insights sidecar fail its internal init check with a misleading generic "Invalid
   credentials" error. Prefer setting it as the `POSTMAN_API_KEY` environment variable
   (`export POSTMAN_API_KEY=...`) rather than pasting it at the prompt — besides keeping it out of
   `ps`/shell history, it sidesteps relying on your terminal's paste handling entirely for a value
   this sensitive.

## Local development

```bash
uv sync
uv run fastapi dev main.py --port 8000
curl http://localhost:8000/health
```

Locally, `SE_NAME`/`URL_ENV` are unset, so routes are unprefixed (`/api/v1/accounts`, etc.) — the
`/<se>/<dev|prod>` prefix only applies to your deployed instance, driven by the ConfigMap your
`SeStack` creates.

### API version switch (v1 / v1.5 / v2)

`main.py` has an `API_VERSION` line near the top (default `"v1"`) that gates progressively more
API behavior — useful for demoing an API's evolution:

- **`v1`** (default): baseline behavior.
- **`v1.5`**: adds `Idempotency-Key` handling on `POST /api/v1/accounts` and
  `POST /api/v1/transactions`, plus `GET /.well-known/llms.txt`.
- **`v2`**: adds `PATCH /api/v1/accounts/{accountId}` on top of everything in `v1.5`.

Edit the `API_VERSION` default in `main.py` and save — the dev server's reloader
(`uv run fastapi dev main.py`) restarts automatically, so switching versions locally is a one-line
edit. A deployed instance just bakes in whatever default is in `main.py` at image build time, same
as any other code change; an `API_VERSION` environment variable can override it if you ever need
to without rebuilding, but nothing in this platform's CDK/onboarding sets one.

## CI/CD

`.github/workflows/deploy.yml`: every push runs spec lint + a local smoke test; pushes to
`develop`/`main` additionally deploy to staging/prod via GitHub OIDC (no long-lived AWS keys) —
`onboard.ts` already wired the required repo variables (`AWS_DEPLOY_ROLE_ARN`, `ECR_REPO`,
`CLUSTER_NAME`, `NAMESPACE_STAGING`/`NAMESPACE_PROD`, `POSTMAN_WORKSPACE_ID`). CI only ships new
app images (`kubectl set image` + `rollout status`) — it never runs `cdk deploy`. Each deploy
pushes two tags: an immutable `<env>-<sha>` tag (the actual rollout target) and `<env>-latest`
(kept in sync on every deploy, since `SeStack`'s Deployment manifest always references it — this
is what a future `cdk deploy`/re-onboarding for this SE would pick up, so keeping it current
avoids silently rolling back to whatever image onboarding originally built).

The Postman CLI steps in CI (`lint`/`test` jobs' spec lint and collection run) need a
`POSTMAN_API_KEY` repo **secret** (not a variable) — `onboard.ts` sets this for you automatically
from the key you gave it, so there's nothing to do here unless you need to rotate it later
(`gh secret set POSTMAN_API_KEY`).

## Monitoring (optional)

Once onboarding is fully done (including the manual commit/push/PR step above), you can set up
ongoing health check for the live production environment:

```bash
npx ts-node scripts/create-monitors.ts
```

Creates a Postman Monitor — "AWS Prod Health Check" — that runs your existing collection
against the AWS Prod environment every 6 hours. Postman-only (no AWS credentials touched) and
safe to re-run; a monitor whose name already exists is skipped, not duplicated. Adjust the
schedule or add failure-notification emails afterward directly in the Postman UI's Monitors tab.

## Tearing down your instance

```bash
npx ts-node scripts/offboard.ts
```

Same access-control model as onboarding — valid AWS credentials, nothing else — and it only ever
touches your own `SeStack-<you>`. It looks up your registry record, shows you exactly what's about
to be destroyed, and (unless you pass `-y`) asks you to confirm before doing anything. This is
**permanent**: it destroys the CloudFormation stack (both namespaces, pods, Ingress rules, your ECR
repo and every image in it, your CI IAM role — any in-flight GitHub Actions deploy against this SE
will fail immediately once the role is gone), deletes your 4 SSM secrets, and removes your registry
record.

It does **not** touch your Postman workspace/collection/System Environments (never created by this
platform, so not this script's job to remove either), or this repo's own GitHub Actions
variables/local `postman/environments/*.yaml` files (harmless dead references at that point — clean
them up yourself if you want to reuse the repo, or just delete the repo entirely).
