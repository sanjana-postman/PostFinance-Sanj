#!/usr/bin/env npx ts-node
/**
 * Onboards THIS repo's SE onto the shared demo hosting platform. Run from inside your freshly
 * cloned copy of the template repo, interactively:
 *
 *   npx ts-node scripts/onboard.ts
 *
 * ...or non-interactively, e.g. from CI or a wrapper script, by passing everything as flags
 * (run `--help` for the full list). Any flag you omit falls back to an interactive prompt, so
 * you can mix and match (e.g. pass --se-name but let it prompt for the rest).
 *
 * The entire access-control model for onboarding is: do you have valid AWS credentials for the
 * shared platform account? There is no separate token, API, or login flow of its own. This
 * script never touches the platform's stack — it only ever deploys your own independent
 * `SE-SDLC-DEMO-SeStack-<you>` (see infra/lib/se-stack.ts in the platform's infra repo), so it
 * cannot affect the shared cluster or any other SE's resources.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { run, runStreaming } from './lib/exec';
import { closePrompts, promptConfirm, promptSecret, promptText } from './lib/prompt';
import { sanitizeSeName } from './lib/naming';
import { bridgeAwsCredentialsForCdk } from './lib/aws-creds';
import { reExecWithCaCertsIfNeeded } from './lib/ca-certs';
import { findSystemEnvironmentByName, listSystemEnvironments, updateEnvironmentValues, SystemEnvironment } from './lib/postman';
import { readPostmanResources } from './lib/postman-resources';
import {
  CLUSTER_NAME,
  SE_REGISTRY_TABLE,
  checkAwsCredentials,
  cloneInfraRepo,
  deployAccessStack,
  detectSeNameFromAwsIdentity,
  hasNonGroupAccessEntry,
  parseGithubRepo,
  resolveAwsRegion,
  resolveOwnPrincipalArnForEks,
  seStackName,
  verifyPlatformExistsInRegion,
} from './lib/infra-repo';

// Must run before anything else in this module — including before parseCliOptions() below —
// since it works by re-executing this entire script as a child process with
// NODE_EXTRA_CA_CERTS set before that child's own Node runtime starts (see ca-certs.ts's doc
// comment for why this can't just be a call inside main()). A no-op everywhere this isn't needed
// (non-macOS, or the var is already set).
reExecWithCaCertsIfNeeded();

interface CliOptions {
  seName?: string;
  postmanWorkspaceId?: string;
  postmanApiKey?: string;
  stagingSystemEnvId?: string;
  prodSystemEnvId?: string;
  yes: boolean;
}

function printHelp(): void {
  console.log(`Usage: npx ts-node scripts/onboard.ts [options]

Every option below is optional — anything you don't pass falls back to an interactive prompt.

  --se-name <name>               SE name (default: derived from your AWS login)
  --postman-workspace-id <id>    Your Postman workspace ID
  --postman-api-key <key>        Your Postman API key (or set the POSTMAN_API_KEY env var —
                                  preferred for non-interactive use, since it won't show up in
                                  \`ps\`/shell history the way a CLI argument does)
  --staging-system-env-id <id>   Skip the automatic lookup for the staging System Environment
  --prod-system-env-id <id>      Skip the automatic lookup for the prod System Environment
  -y, --yes                      Skip the "have you completed Postman setup?" confirmation
  -h, --help                     Show this help
`);
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'se-name': { type: 'string' },
      'postman-workspace-id': { type: 'string' },
      'postman-api-key': { type: 'string' },
      'staging-system-env-id': { type: 'string' },
      'prod-system-env-id': { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printHelp();
    process.exit(0);
  }
  return {
    seName: values['se-name'],
    postmanWorkspaceId: values['postman-workspace-id'],
    // CLI flag takes precedence if both are given, but the env var is the recommended path for
    // exactly the reason --help says: it doesn't land in `ps`/shell history the way an argument does.
    postmanApiKey: values['postman-api-key'] ?? process.env.POSTMAN_API_KEY,
    stagingSystemEnvId: values['staging-system-env-id'],
    prodSystemEnvId: values['prod-system-env-id'],
    yes: values.yes ?? false,
  };
}

const AWS_REGION = resolveAwsRegion();

// Mirrors infra/lib/types.ts's URL_ENV mapping — duplicated here for the same reason
// STACK_NAME_PREFIX already is (the two repos don't share code). Used to build the
// `<se>-<dev|prod>` Deployment name se-stack.ts's Workload manifest actually creates, so this
// script's own `kubectl` calls target the right object.
const URL_ENV: Record<string, string> = { staging: 'dev', prod: 'prod' };

/** Idempotent: safe to re-run for the same SE. Aborts if the SE name is already registered
 * under a DIFFERENT GitHub repo — that almost certainly means a name collision with someone
 * else's SE, not a legitimate re-run.
 *
 * Stores `sePrincipalArn` (when resolvable) so `access-stack.ts` — deployed separately, right
 * after this — can recompute the full union of `demo-host-<seName>-owner` Kubernetes groups for
 * every SE that shares this same IAM principal ARN (AWS SSO permission sets give every SE
 * assigned to them the same underlying role ARN; EKS allows only one Access Entry per ARN per
 * cluster, so that union has to be computed centrally rather than per-SE). Omitted from the item
 * entirely when unresolved, rather than writing an empty string — `access-stack.ts`'s grouping
 * logic only cares about entries that actually have this field. */
function upsertRegistryRecord(seName: string, githubRepo: string, postmanWorkspaceId: string, sePrincipalArn: string | undefined): void {
  let existing: any = null;
  try {
    const raw = run('aws', [
      'dynamodb', 'get-item',
      '--table-name', SE_REGISTRY_TABLE,
      '--key', JSON.stringify({ seName: { S: seName } }),
      '--region', AWS_REGION,
    ], { silent: true });
    existing = raw ? JSON.parse(raw).Item : null;
  } catch {
    throw new Error(`Could not read the SE registry table "${SE_REGISTRY_TABLE}" — has PlatformStack/RegistryStack been deployed yet?`);
  }
  if (existing && existing.githubRepo?.S !== githubRepo) {
    throw new Error(
      `SE name "${seName}" is already registered against a different repo (${existing.githubRepo?.S}). ` +
        'Pick a different SE name, or confirm with the platform admin this isn\'t a collision.',
    );
  }

  const item: Record<string, { S: string }> = {
    seName: { S: seName },
    githubRepo: { S: githubRepo },
    postmanWorkspaceId: { S: postmanWorkspaceId },
    onboardedAt: { S: new Date().toISOString() },
  };
  if (sePrincipalArn) {
    item.sePrincipalArn = { S: sePrincipalArn };
  }
  run('aws', ['dynamodb', 'put-item', '--table-name', SE_REGISTRY_TABLE, '--item', JSON.stringify(item), '--region', AWS_REGION]);
}

function putSsmSecureString(name: string, value: string): void {
  run('aws', ['ssm', 'put-parameter', '--name', name, '--type', 'SecureString', '--value', value, '--overwrite', '--region', AWS_REGION], { silent: true });
}

function bootstrapSecrets(seName: string, postmanApiKey: string): void {
  for (const envName of ['staging', 'prod']) {
    const adminApiKey = crypto.randomBytes(24).toString('hex');
    putSsmSecureString(`/demo-host/${seName}/${envName}/admin-api-key`, adminApiKey);
    // Same Postman key value in both envs is intentional (see infra/lib/se-stack.ts comments) —
    // stored twice only so each env's secret can be rotated independently later.
    putSsmSecureString(`/demo-host/${seName}/${envName}/postman-insights-key`, postmanApiKey);
  }
}

function deploySeStack(infraDir: string, args: {
  seName: string;
  githubRepo: string;
  postmanWorkspaceId: string;
  postmanSystemEnvIds: { staging: string; prod: string };
}): void {
  console.log(`\nDeploying ${seStackName(args.seName)} — this ONLY touches your own stack, never PlatformStack.\n`);
  // Re-bridge right before the longest-running step, so it starts with the freshest possible
  // token rather than whatever was current several `aws`/prompt round-trips ago.
  bridgeAwsCredentialsForCdk();
  runStreaming('npx', [
    'cdk', 'deploy', seStackName(args.seName),
    '--require-approval', 'never',
    '-c', `seName=${args.seName}`,
    '-c', `githubRepo=${args.githubRepo}`,
    '-c', `postmanWorkspaceId=${args.postmanWorkspaceId}`,
    '-c', `staging:postmanSystemEnvId=${args.postmanSystemEnvIds.staging}`,
    '-c', `prod:postmanSystemEnvId=${args.postmanSystemEnvIds.prod}`,
  ], { cwd: infraDir });
}

function getStackOutput(seName: string, outputKey: string): string {
  return run('aws', [
    'cloudformation', 'describe-stacks',
    '--stack-name', seStackName(seName),
    '--query', `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue`,
    '--output', 'text',
    '--region', AWS_REGION,
  ], { silent: true });
}

function updateKubeconfig(): void {
  run('aws', ['eks', 'update-kubeconfig', '--name', CLUSTER_NAME, '--region', AWS_REGION], { silent: true });
}

/** Fixed name, not prompted — mirrors the reference repo's own setup-demo.sh pattern (create a
 * local branch before touching any files, so everything onboarding writes locally lands there
 * instead of whatever branch the SE happened to have checked out). Idempotent: already on it,
 * exists but checked out elsewhere, or doesn't exist yet are all handled.
 *
 * Named `develop`, not an arbitrary onboarding-only branch name, quite deliberately:
 * `.github/workflows/deploy.yml`'s `deploy` job only runs `if: github.ref == 'refs/heads/develop'
 * || ... 'refs/heads/main'`. Whenever the SE pushes this branch (a manual step now — see
 * printFinalInstructions below for why), pushing straight to a branch literally named `develop`
 * means that push already exercises the real staging deploy job end-to-end, instead of silently
 * no-op'ing (lint/test still run on any branch, but `deploy` would skip) until they separately
 * merge into `develop`/`main` later. */
function ensureDevelopBranch(): void {
  const BRANCH = 'develop';
  const current = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current === BRANCH) return;
  try {
    run('git', ['rev-parse', '--verify', BRANCH], { silent: true });
    run('git', ['checkout', BRANCH]);
  } catch {
    run('git', ['checkout', '-b', BRANCH]);
  }
}

function isDockerRunning(): boolean {
  try {
    run('docker', ['info'], { silent: true });
    return true;
  } catch {
    return false;
  }
}

/** Fail-fast check, run before anything else in main() — no point letting the SE sit through
 * prompts and a multi-minute `cdk deploy` only to find out at the very end that Docker was never
 * running. */
function ensureDockerRunning(): void {
  if (!isDockerRunning()) {
    throw new Error('Docker does not appear to be running. Start Docker Desktop and re-run — onboarding needs it to build your first image.');
  }
}

/** Used at the actual build/push call site, several minutes (a full `cdk deploy`) after
 * ensureDockerRunning() already passed once at the top of main() — Docker could have been quit
 * in between. Unlike ensureDockerRunning(), doesn't abort: real AWS work has already happened by
 * this point (registry record, secrets, the SE's whole stack), so this pauses and lets the SE
 * start Docker back up and retry rather than throwing away that work. */
async function waitForDockerRunning(): Promise<void> {
  while (!isDockerRunning()) {
    await promptText('Docker does not appear to be running. Start Docker Desktop, then press Enter to retry');
  }
}

// The cluster is amd64-only end to end — platform-stack.ts's managed node group is t3.medium
// (x86_64) and karpenter.ts's NodePool pins `kubernetes.io/arch: In [amd64]` with no arm64/
// Graviton option. A plain `docker build` on an Apple Silicon Mac defaults to arm64, which would
// push an image that pulls fine but crashes every pod with "exec format error" — silent at push
// time, only surfacing once Kubernetes tries to actually run it. `--platform linux/amd64` forces
// the correct target regardless of the SE's own machine architecture; modern Docker Desktop's
// bundled buildx handles the cross-build/emulation automatically, no extra setup needed.
const TARGET_PLATFORM = 'linux/amd64';

/** Builds and pushes a real image immediately, so the SE isn't left with ErrImagePull pods until
 * their first manual `git push` to develop/main triggers CI. One build, tagged as BOTH
 * `staging-latest` and `prod-latest` — matches SeStack's Deployment image reference exactly for
 * both envs, so no CDK change is needed. */
async function buildAndPushInitialImage(ecrRepositoryUri: string): Promise<void> {
  console.log('\nBuilding and pushing your initial container image (this can take a few minutes) ...');
  await waitForDockerRunning();
  const registry = ecrRepositoryUri.split('/')[0];
  const loginPassword = run('aws', ['ecr', 'get-login-password', '--region', AWS_REGION], { silent: true });
  run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { input: loginPassword, silent: true });
  runStreaming('docker', [
    'build', '--platform', TARGET_PLATFORM,
    '-t', `${ecrRepositoryUri}:staging-latest`,
    '-t', `${ecrRepositoryUri}:prod-latest`,
    '.',
  ]);
  runStreaming('docker', ['push', `${ecrRepositoryUri}:staging-latest`]);
  runStreaming('docker', ['push', `${ecrRepositoryUri}:prod-latest`]);
}

/** The pods `cdk deploy` just created are already sitting in ImagePullBackOff's exponential
 * backoff (the tag didn't exist yet at that point) — restarting forces an immediate pull attempt
 * against the tag that now actually exists, rather than waiting out whatever backoff interval
 * each pod is currently on. */
function rolloutInitialDeploy(seName: string): void {
  updateKubeconfig();
  for (const envName of ['staging', 'prod']) {
    run('kubectl', ['rollout', 'restart', `deployment/${seName}-${URL_ENV[envName]}`, '-n', `${seName}-${envName}`], { silent: true });
  }
  for (const envName of ['staging', 'prod']) {
    console.log(`Waiting for ${seName}-${envName} rollout ...`);
    runStreaming('kubectl', ['rollout', 'status', `deployment/${seName}-${URL_ENV[envName]}`, '-n', `${seName}-${envName}`, '--timeout=180s']);
  }
}

/** The shared ALB is created dynamically by the AWS Load Balancer Controller the first time
 * ANY SE's Ingress is applied — there's no CDK output for its hostname (see infra/lib/types.ts).
 * Poll both namespaces' Ingress objects until the controller has assigned one. */
function discoverSharedHostname(seName: string): string {
  updateKubeconfig();
  for (const namespace of [`${seName}-staging`, `${seName}-prod`]) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const hostname = run('kubectl', [
        'get', 'ingress', 'app', '-n', namespace,
        '-o', 'jsonpath={.status.loadBalancer.ingress[0].hostname}',
      ], { silent: true });
      if (hostname) return hostname;
      execSleep(5000);
    }
  }
  throw new Error('Timed out waiting for the shared ALB hostname to appear on either namespace\'s Ingress.');
}

function execSleep(ms: number): void {
  // No async sleep needed here — this script is a short-lived one-shot CLI, and a blocking
  // wait keeps the polling loop above simple. Uses a child process rather than a busy loop.
  run('sleep', [String(ms / 1000)], { silent: true });
}

function setGithubRepoConfig(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    run('gh', ['variable', 'set', key, '--body', value]);
  }
}

/** `deploy.yml`'s `lint`/`test` jobs both do `postman login --with-api-key ${{ secrets.POSTMAN_API_KEY }}`
 * — without this, the SE's very first CI run fails at that step. `--input` (not `--body`) keeps
 * the key off argv/`ps`, same treatment as `docker login --password-stdin` earlier in this file. */
function setGithubRepoSecret(name: string, value: string): void {
  run('gh', ['secret', 'set', name], { input: value, silent: true });
}

/** Replaces the `value:` line under a given `- key: <key>` entry in a Postman Native Git-sync
 * `.environment.yaml` file — anchored on the KEY, not the current value. The original version of
 * this rewrote fixed placeholder tokens (`REPLACE_ME_...`) via literal string substitution, which
 * only ever worked on the very first onboarding run: once a placeholder was replaced with a real
 * value, a second run had nothing left to match and silently left the file stale — confirmed for
 * real, this is exactly how a re-onboarded SE ended up with a local `adminPassword` that matched
 * neither the current SSM value nor the pod's actual credential. Anchoring on the key instead
 * means every re-run overwrites whatever value is currently there, template placeholder or real. */
function setEnvironmentValue(content: string, key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(-\\s*key:\\s*${escapedKey}\\n\\s*value:\\s*).*`);
  if (!pattern.test(content)) {
    throw new Error(`Could not find a "${key}" entry to update in this environment file — has its structure changed?`);
  }
  return content.replace(pattern, (_match, prefix) => `${prefix}'${value}'`);
}

/** Expects the file in Postman's Native Git-sync `.environment.yaml` format, which is what
 * actually lands here once the SE's workspace is linked via the desktop app — but that link is
 * a manual step this script can only ask the SE to confirm, not enforce, so a missing file
 * (skipped/not-yet-done) warns instead of crashing after AWS provisioning has already
 * succeeded; the SE can paste these values in by hand once they do link it. `values` maps each
 * Postman environment variable's `key` (not a placeholder token) to its new value. */
function rewriteEnvironmentFile(filePath: string, values: Record<string, string>): void {
  if (!fs.existsSync(filePath)) {
    console.log(`  (skipped: ${path.basename(filePath)} not found — link your workspace via the desktop app, then fill these in yourself: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')})`);
    return;
  }
  let content = fs.readFileSync(filePath, 'utf-8');
  for (const [key, value] of Object.entries(values)) {
    content = setEnvironmentValue(content, key, value);
  }
  fs.writeFileSync(filePath, content);
}

/** The template repo ships its CI workflow in `.github/workflows-staging/`, NOT the real
 * `.github/workflows/` GitHub Actions watches — if it lived there from the start, the very
 * first push (creating the repo from the template) would trigger `lint`/`test`/`deploy`
 * immediately, before onboarding has set any of the repo variables/secrets those jobs need
 * (AWS_DEPLOY_ROLE_ARN, POSTMAN_API_KEY, etc.) or provisioned the SeStack the deploy job targets
 * — an inevitable, immediate failed run for every new SE. Moves it into place only now that
 * provisioning + variable configuration have both actually succeeded; the SE commits and pushes
 * it themselves, alongside the environment file changes — see printFinalInstructions below. */
function activateGithubActionsWorkflow(): void {
  const stagedPath = path.join(process.cwd(), '.github/workflows-staging/deploy.yml');
  if (!fs.existsSync(stagedPath)) {
    return; // already activated by a previous run of this script
  }
  const activePath = path.join(process.cwd(), '.github/workflows/deploy.yml');
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.renameSync(stagedPath, activePath);
}

/** Prints, but does NOT run, the commands that commit the environment-file rewrites and workflow
 * activation, push `develop` (which — see ensureDevelopBranch's comment — is exactly what
 * triggers CI's real staging deploy job on the very first push, not just lint/test), and open a
 * PR promoting `develop` into `main` for when the SE is ready to go to prod.
 *
 * Deliberately NOT automated: real-world testing found `.postman/resources.yaml` can still be
 * mid-sync from the Postman desktop app at exactly this point in the script, so committing and
 * pushing immediately risks baking a stale/incomplete resources.yaml into git history and
 * triggering a real deploy before a human ever gets a chance to notice. Instead this prints a
 * checklist the SE works through by hand — verify the sync actually finished, verify the live
 * Postman environments show the right values, and only then run the commands themselves. */
function printFinalInstructions(seName: string, stagingUrl: string, prodUrl: string, bothPushedLive: boolean): void {
  console.log('\n=== Before you commit: verify everything actually synced ===');
  if (bothPushedLive) {
    console.log('1. Open `.postman/resources.yaml` and confirm every environment/collection/spec entry');
    console.log('   under `cloudResources:` has a real cloud ID (not blank or missing) — this script');
    console.log('   found IDs for both "AWS Dev" and "AWS Prod" environments, but the Postman desktop');
    console.log('   app may still be finishing a sync for OTHER resources (collections/specs). If any');
    console.log('   entry looks incomplete, reopen the workspace in the desktop app, push again, and');
    console.log('   let it fully finish before continuing.');
  } else {
    console.log('1. This script did NOT find a cloud ID for one or both environments in');
    console.log('   `.postman/resources.yaml` — that means the desktop app sync has not finished (or');
    console.log('   never ran). Open the workspace in the Postman desktop app, push to Postman Cloud,');
    console.log('   and wait for it to fully finish, then re-run `npx ts-node scripts/onboard.ts`');
    console.log('   (safe to re-run — it picks up right where it left off).');
  }
  console.log('2. In the Postman web/desktop app, open the "AWS Dev" and "AWS Prod" environments and');
  console.log('   confirm they show these exact values (this script already pushed them live):');
  console.log(`     AWS Dev  -> baseUrl: ${stagingUrl}`);
  console.log(`     AWS Prod -> baseUrl: ${prodUrl}`);
  console.log('   (admin passwords were also pushed live — compare against your saved copies.)');

  if (bothPushedLive) {
    console.log('\nOnce both checks above look right, commit, push, and open your PR yourself:');
    console.log('');
    console.log('  git add .');
    console.log(`  git commit -m "Onboard ${seName} onto the shared demo hosting platform"`);
    console.log('  git push -u origin develop');
    console.log(
      `  gh pr create --base main --head develop --title "Onboard ${seName}" --body ` +
        `"Staging: ${stagingUrl}\\nProd: ${prodUrl}"`,
    );
    console.log('\nPushing `develop` triggers CI\'s real staging build/deploy job immediately — check the');
    console.log('Actions tab. Merging the PR into `main` deploys to prod the same way.');
  } else {
    console.log('\nDo not commit/push yet — finish the sync above and re-run this script first.');
  }
}

/** Queries the Postman API Catalog for System Environments named "staging"/"prod" instead of
 * asking the SE to hunt down and paste raw IDs. Not prefixed with the SE's own name: each SE
 * uses their own separate Postman team/instance (see the "Postman workspace" decision — this
 * isn't one shared team all SEs' environments live in together), so there's no cross-SE
 * collision to guard against by prefixing. The API Catalog has no per-workspace filter either
 * way (confirmed against the live API reference — environments are team-wide, with no workspace
 * field on the object at all), so this matches by name regardless. Falls back to manual entry —
 * for the whole pair if the query fails outright (e.g. plan tier doesn't include API Catalog),
 * or per-environment if only one name matches — rather than hard-failing onboarding over
 * something Postman-side that this script was never going to fully control anyway. */
async function resolveSystemEnvironmentIds(
  apiKey: string,
  overrides: { staging?: string; prod?: string } = {},
): Promise<{ staging: string; prod: string }> {
  if (overrides.staging && overrides.prod) {
    console.log(`\nUsing provided System Environment IDs: staging=${overrides.staging}, prod=${overrides.prod}`);
    return { staging: overrides.staging, prod: overrides.prod };
  }

  console.log('\nLooking up your Postman System Environments ...');
  let environments: SystemEnvironment[] = [];
  try {
    environments = await listSystemEnvironments(apiKey);
  } catch (err: any) {
    console.log(`Could not query the Postman API Catalog automatically (${err.message}).`);
  }

  // Accept both this platform's own convention and the reference repo's original one — real
  // teams (including the one used to test this) already have theirs named "Development"/
  // "Production", not "staging"/"prod".
  const stagingMatch = overrides.staging ? undefined : findSystemEnvironmentByName(environments, ['staging', 'dev', 'development']);
  const prodMatch = overrides.prod ? undefined : findSystemEnvironmentByName(environments, ['prod', 'production']);
  const stagingId = overrides.staging ?? stagingMatch?.id;
  const prodId = overrides.prod ?? prodMatch?.id;

  if (stagingId && prodId) {
    if (stagingMatch) console.log(`Found "${stagingMatch.name}" (${stagingMatch.id}).`);
    if (prodMatch) console.log(`Found "${prodMatch.name}" (${prodMatch.id}).`);
    return { staging: stagingId, prod: prodId };
  }

  console.log('Could not automatically match both System Environments by name (expected "staging"/"prod" or "Development"/"Production").');
  if (environments.length) {
    console.log('System Environments visible to this API key:');
    for (const e of environments) {
      console.log(`  - ${e.name} (${e.id})${e.isProduction ? ' [production]' : ''}`);
    }
  } else {
    console.log('No System Environments were returned at all — double-check the API key and that your Postman plan includes API Catalog.');
  }

  return {
    staging: stagingId ?? (await promptText('Staging System Environment ID')),
    prod: prodId ?? (await promptText('Prod System Environment ID')),
  };
}

async function main() {
  const cli = parseCliOptions();
  console.log('=== SE Demo Hosting Platform — Onboarding ===\n');
  // Cheapest, most local check available — run it before anything that talks to AWS or prompts
  // the SE, so a missing/stopped Docker fails immediately instead of after a multi-minute deploy.
  ensureDockerRunning();
  checkAwsCredentials();
  console.log(`Using AWS region: ${AWS_REGION} (from your AWS CLI config — the platform is deployed per-region).`);
  verifyPlatformExistsInRegion(AWS_REGION);
  // Bridges `aws login`'s SSO credential cache into plain env vars the CDK CLI's Node SDK can
  // read — the `aws` CLI calls above/below already understand the cache natively, but `cdk
  // deploy` (spawned from deploySeStack) does not. See scripts/lib/aws-creds.ts for why this
  // must re-derive from scratch rather than trust anything already exported in this shell.
  bridgeAwsCredentialsForCdk();

  const remoteUrl = run('git', ['remote', 'get-url', 'origin']);
  const githubRepo = parseGithubRepo(remoteUrl);
  console.log(`Detected GitHub repo: ${githubRepo}`);

  ensureDevelopBranch();

  // Written by the Postman desktop app's "Push to Postman Cloud" step (a prerequisite already
  // completed by this point) — no reason to ask the SE to paste something already sitting in
  // their own repo.
  const postmanResources = readPostmanResources(process.cwd());

  const detectedSeName = detectSeNameFromAwsIdentity();
  const seNameRaw = cli.seName ?? (await promptText('Your SE name (used in URLs and resource names)', { default: detectedSeName }));
  const seName = sanitizeSeName(seNameRaw);
  console.log(`Using sanitized SE name: ${seName}`);

  console.log(
    '\nBefore continuing, you need YOUR OWN Postman workspace already set up:\n' +
      '  1. Create/select a Postman workspace (must be a TEAM workspace, not personal).\n' +
      '  2. If this workspace has never used Insights before: open it in the Postman DESKTOP APP,\n' +
      '     Files > Open folder, then "Push to Postman Cloud" at least once (desktop-app-only,\n' +
      '     no REST/CLI equivalent).\n' +
      '  3. Confirm the template collection (postman/collections/PostFinanceCo API/) is in your\n' +
      '     workspace — step 2\'s "Push to Postman Cloud" already syncs it there if it wasn\'t.\n' +
      '  4. Under API Catalog > Integrated Services, create two System Environments — one for\n' +
      '     staging, one for prod. Either naming convention is fine ("staging"/"prod" or\n' +
      '     "Development"/"Production"); this script recognizes both when looking them up\n' +
      '     automatically, so you don\'t need to type IDs. No need to include your own name in\n' +
      '     them either — you have your own separate Postman team/instance, so there\'s nothing\n' +
      '     else in there to collide with.\n',
  );
  const alreadySetUp = cli.yes || (await promptConfirm('Have you completed all of the above?'));
  if (!alreadySetUp) {
    console.log('\nComplete the steps above, then re-run this script.');
    process.exit(0);
  }

  const postmanWorkspaceId =
    cli.postmanWorkspaceId ?? postmanResources.workspaceId ?? (await promptText('Your Postman workspace ID'));
  if (!cli.postmanWorkspaceId && postmanResources.workspaceId) {
    console.log(`Using Postman workspace ID from .postman/resources.yaml: ${postmanWorkspaceId}`);
  }
  const postmanApiKey =
    cli.postmanApiKey ??
    (await promptSecret(
      'Paste your Postman API key (must be team-level Admin/Super Admin ' +
        '- will not be displayed inline)',
    ));
  const { staging: stagingSystemEnvId, prod: prodSystemEnvId } = await resolveSystemEnvironmentIds(postmanApiKey, {
    staging: cli.stagingSystemEnvId,
    prod: cli.prodSystemEnvId,
  });
  // No more prompts anywhere after this point in the normal path — release stdin now rather than
  // leaving the process implicitly waiting on an open readline interface through several more
  // minutes of pure automation (cdk deploy, kubectl polling, gh calls). The one deliberate
  // exception is waitForDockerRunning()'s retry pause, much later in buildAndPushInitialImage()
  // — that's fine because promptText()/getSharedInterface() (scripts/lib/prompt.ts) lazily
  // recreate the readline interface on next use even after it's been closed here.
  closePrompts();

  console.log('\nRegistering SE in the platform registry ...');
  // Best-effort: omitted from the registry entirely (rather than failing onboarding) if it can't
  // be resolved — the admin is left to grant cluster access manually in that case (see
  // resolveOwnPrincipalArnForEks's own doc comment for why a wrong guess is worse than no value).
  // Also omitted (distinct reason) when this identity already has cluster access via a
  // non-group mechanism — e.g. the platform admin's own cluster-admin role — since including it
  // would collide with the access entry that already owns that ARN; see hasNonGroupAccessEntry's
  // doc comment.
  let sePrincipalArn = resolveOwnPrincipalArnForEks();
  if (sePrincipalArn && hasNonGroupAccessEntry(sePrincipalArn, AWS_REGION)) {
    console.log(`Skipping the SE-owner group grant for ${sePrincipalArn} — it already has cluster access via a different (non-group) mechanism, e.g. cluster-admin.`);
    sePrincipalArn = undefined;
  }
  upsertRegistryRecord(seName, githubRepo, postmanWorkspaceId, sePrincipalArn);

  console.log('Bootstrapping per-env secrets in SSM ...');
  bootstrapSecrets(seName, postmanApiKey);

  const infraDir = cloneInfraRepo();
  // Deployed before SeStack: SeStack's Role/RoleBinding manifests grant permissions to the
  // `demo-host-${seName}-owner` Kubernetes group, but AccessStack is what actually maps this
  // caller's IAM identity onto that group — without it, rolloutInitialDeploy()/
  // discoverSharedHostname() below run kubectl under an identity the cluster has never heard of
  // and fail with "Forbidden"/"You must be logged in to the server".
  deployAccessStack(infraDir, AWS_REGION);
  deploySeStack(infraDir, {
    seName,
    githubRepo,
    postmanWorkspaceId,
    postmanSystemEnvIds: { staging: stagingSystemEnvId, prod: prodSystemEnvId },
  });

  console.log('\nDeploy succeeded. Fetching outputs ...');
  const ecrRepositoryUri = getStackOutput(seName, 'EcrRepositoryUri');
  const ciDeployRoleArn = getStackOutput(seName, 'CiDeployRoleArn');

  await buildAndPushInitialImage(ecrRepositoryUri);
  rolloutInitialDeploy(seName);

  console.log('Waiting for the shared ALB to register your Ingress rules (this can take a few minutes) ...');
  const sharedHostname = discoverSharedHostname(seName);

  console.log('\nConfiguring GitHub Actions repository variables and secrets ...');
  setGithubRepoConfig({
    SE_NAME: seName,
    AWS_REGION,
    AWS_DEPLOY_ROLE_ARN: ciDeployRoleArn,
    ECR_REPO: ecrRepositoryUri.split('/').slice(1).join('/'),
    CLUSTER_NAME,
    NAMESPACE_STAGING: `${seName}-staging`,
    NAMESPACE_PROD: `${seName}-prod`,
    POSTMAN_WORKSPACE_ID: postmanWorkspaceId,
  });
  setGithubRepoSecret('POSTMAN_API_KEY', postmanApiKey);

  console.log('Updating local Postman environment files with your live URLs/credentials ...');
  const adminApiKeyStaging = run('aws', [
    'ssm', 'get-parameter', '--name', `/demo-host/${seName}/staging/admin-api-key`,
    '--with-decryption', '--query', 'Parameter.Value', '--output', 'text', '--region', AWS_REGION,
  ], { silent: true });
  const adminApiKeyProd = run('aws', [
    'ssm', 'get-parameter', '--name', `/demo-host/${seName}/prod/admin-api-key`,
    '--with-decryption', '--query', 'Parameter.Value', '--output', 'text', '--region', AWS_REGION,
  ], { silent: true });

  // http, not https: the shared Ingress only opens an HTTP listener (see infra/lib/se-stack.ts)
  // — no custom domain/ACM cert is part of this design (a reasonable later addition, not
  // required to stand the platform up).
  //
  // No trailing slash: the Postman collection's requests are built as `{{baseUrl}}/api/v1/...`
  // (leading slash on the path side, the collection's own convention) — a baseUrl that ALSO ends
  // in `/` produces a double slash (".../dev//api/v1/...") once concatenated, which is exactly
  // what broke request matching. This value feeds every consumer (the local environment file
  // rewrite, the live Postman API push, the printed URLs below, and the PR body) from this one
  // spot, so fixing it here fixes all of them.
  const stagingUrl = `http://${sharedHostname}/${seName}/dev`;
  const prodUrl = `http://${sharedHostname}/${seName}/prod`;

  rewriteEnvironmentFile(path.join(process.cwd(), 'postman/environments/AWS Dev.environment.yaml'), {
    baseUrl: stagingUrl,
    adminPassword: adminApiKeyStaging,
  });
  rewriteEnvironmentFile(path.join(process.cwd(), 'postman/environments/AWS Prod.environment.yaml'), {
    baseUrl: prodUrl,
    adminPassword: adminApiKeyProd,
  });

  // Updates the live Postman environment directly, by the exact cloud ID .postman/resources.yaml
  // already tracks — a merge-update, not a recreate, so it can't disturb the System Environment
  // link the SE set up during their own Postman-side setup (confirmed for real: depending on the
  // SE's own manual `postman workspace push` to do this was breaking that link). Only runs once
  // the SE has pushed at least once themselves (that's what populates the ID in the first place);
  // until then this just no-ops per environment and the SE still pushes manually as before.
  console.log('Updating your live Postman environments ...');
  const stagingEnvId = postmanResources.environmentIds['postman/environments/AWS Dev.environment.yaml'];
  const prodEnvId = postmanResources.environmentIds['postman/environments/AWS Prod.environment.yaml'];
  if (stagingEnvId) {
    await updateEnvironmentValues(postmanApiKey, stagingEnvId, { baseUrl: stagingUrl, adminPassword: adminApiKeyStaging });
  }
  if (prodEnvId) {
    await updateEnvironmentValues(postmanApiKey, prodEnvId, { baseUrl: prodUrl, adminPassword: adminApiKeyProd });
  }
  const bothPushedLive = Boolean(stagingEnvId && prodEnvId);
  if (!bothPushedLive) {
    console.log(
      '  (no cloud ID yet in .postman/resources.yaml for one or both environments — push from the ' +
        'desktop app once, then re-run this script to sync live values automatically from then on.)',
    );
  }

  console.log('Activating the GitHub Actions workflow (now that everything it needs actually exists) ...');
  activateGithubActionsWorkflow();

  console.log('\n=== Onboarding complete ===');
  console.log(`Staging URL: ${stagingUrl}`);
  console.log(`Prod URL:    ${prodUrl}`);
  console.log('\nYour app is already live in both environments — no further push is needed to get it running.');
  console.log('AWS provisioning, the Docker build/push, the rollout, and GitHub variables/secrets are all done.');

  printFinalInstructions(seName, stagingUrl, prodUrl, bothPushedLive);
}

main().catch((err) => {
  console.error(`\nOnboarding failed: ${err.message}`);
  process.exit(1);
});
