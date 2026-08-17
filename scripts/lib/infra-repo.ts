import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bridgeAwsCredentialsForCdk } from './aws-creds';
import { run, runStreaming } from './exec';
import { sanitizeSeName } from './naming';

/** The platform's infra repo (Repo 1) — onboard.ts/offboard.ts need it to run `cdk deploy`/
 * `cdk destroy` against your own SeStack. `owner/repo` slug form (not a URL) — this is what
 * `gh repo clone` expects. */
export const INFRA_REPO_SLUG = 'postman-solutions-eng/SDLC-Demo-AWS-Shared-Host';

// Must match infra/lib/types.ts's STACK_NAME_PREFIX exactly — the two repos don't share code,
// so this is duplicated by necessity, not oversight. Every CloudFormation stack in this app is
// named `${STACK_NAME_PREFIX}-<suffix>` for easy filtering in the console.
export const STACK_NAME_PREFIX = 'SE-SDLC-DEMO';
export const CLUSTER_NAME = 'demo-host-platform';
export const SE_REGISTRY_TABLE = 'demo-host-se-registry';

export function seStackName(seName: string): string {
  return `${STACK_NAME_PREFIX}-SeStack-${seName}`;
}

// Singleton — one AccessStack for the whole platform, not one per SE. It owns the ARN-keyed
// EKS Access Entries that SeStack used to try to own individually (see access-stack.ts's doc
// comment in the infra repo for why that collided whenever SEs share an AWS SSO permission set's
// IAM role ARN).
export function accessStackName(): string {
  return `${STACK_NAME_PREFIX}-AccessStack`;
}

// Resolved from the current AWS CLI profile/config, NOT hardcoded — the platform's actual
// region (us-west-1, chosen because that's what this account's CDK bootstrap already used) has
// no reason to match any particular default, and hardcoding one here caused a real failure
// (every aws/cdk call silently targeting the wrong region) before this was caught.
//
// This makes the platform genuinely multi-region-capable with zero extra code: nothing in
// infra/lib/*.ts hardcodes a region (every resource reference uses CDK's own dynamic
// `this.region`), so an admin can deploy a fully independent PlatformStack/RegistryStack pair
// into a second region (e.g. eu-west-1 for European SEs), and an SE whose AWS CLI is configured
// for that region gets their own SeStack deployed there automatically via this same resolution.
//
// Deliberately REGION-SILOED, not unified, for now: each region's RegistryStack is a fully
// separate DynamoDB table with no cross-region visibility. SE-name uniqueness is therefore only
// enforced WITHIN a region — the same SE name could exist independently in us-west-1 and
// eu-west-1 without either onboarding/offboarding run ever knowing about the other. Revisit if
// that turns out to matter in practice; the fix (checking a shared table in one "home" region
// regardless of where the SeStack itself deploys) is a small, deliberate change, not a redesign.
export function resolveAwsRegion(): string {
  if (process.env.AWS_REGION) return process.env.AWS_REGION;
  try {
    const configured = run('aws', ['configure', 'get', 'region'], { silent: true });
    if (configured) return configured;
  } catch {
    // fall through to default below
  }
  return 'us-east-1';
}

export function parseGithubRepo(remoteUrl: string): string {
  const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
  if (!match) {
    throw new Error(`Could not parse a GitHub "<org>/<repo>" out of git remote "origin" (${remoteUrl}).`);
  }
  return match[1];
}

/** Default SE name, derived from the current AWS caller identity — same trick the reference
 * repo's deploy.sh used for its own deployerUsername auto-detection. An SSO/assumed-role ARN
 * (`arn:aws:sts::<account>:assumed-role/<RoleName>/<session-name>`) puts the actual person's
 * identifier in the last "/"-segment (their SSO session name, e.g. "graham.king"); a plain IAM
 * user ARN puts it there too (`.../user/<name>`). Only a default, not a hard requirement — the
 * SE still confirms/overrides it at the prompt, since nothing stops someone from onboarding (or
 * offboarding) a different SE name than their own login under a shared/admin credential. */
export function detectSeNameFromAwsIdentity(): string | undefined {
  try {
    const arn = run('aws', ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'], { silent: true });
    const lastSegment = arn.split('/').pop();
    return lastSegment ? sanitizeSeName(lastSegment) : undefined;
  } catch {
    return undefined;
  }
}

/** The caller's own IAM principal ARN, resolved into the form EKS Access Entries actually accept
 * — stored on this SE's registry record so `access-stack.ts` can grant this identity cluster
 * access (see `scanRegistryForAccessEntries`/`deployAccessStack` above). `aws sts
 * get-caller-identity` returns the STS *session* ARN for an SSO/assumed role
 * (`arn:aws:sts::<account>:assumed-role/<RoleName>/<session-name>`), but EKS rejects that form
 * outright for access entries ("You can't use the STS session principal type... this is a
 * temporary principal for each session and not a permanent identity that can be assigned
 * permissions") — it wants the underlying role's own ARN instead.
 *
 * Deliberately does NOT reconstruct that role ARN by string surgery (e.g.
 * `arn:aws:iam::<account>:role/<RoleName>`) — IAM Identity Center's own permission-set roles live
 * under a non-root path (`role/aws-reserved/sso.amazonaws.com/[<region>/]<RoleName>`, per AWS's
 * own docs on referencing permission sets), which the assumed-role session ARN never reveals.
 * A path-less guess for one of those would be syntactically valid but point at a role that
 * doesn't exist, and `CreateAccessEntry` validates the principal really exists at deploy time —
 * so a wrong guess wouldn't just skip this grant, it would fail the whole `cdk deploy`. Instead,
 * `aws iam get-role --role-name <RoleName>` looks up the SAME role by name (paths are irrelevant
 * to that lookup) and returns its one true ARN, path included. A plain IAM user ARN needs no
 * lookup at all. Returns `undefined` — never a guess — on any failure (parse failure, or the
 * caller's identity lacking `iam:GetRole` on itself) so onboarding still succeeds; the admin is
 * left to grant cluster access manually in that case. */
export function resolveOwnPrincipalArnForEks(): string | undefined {
  let arn: string;
  try {
    arn = run('aws', ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'], { silent: true });
  } catch {
    return undefined;
  }
  const assumedRoleMatch = arn.match(/^arn:aws:sts::\d+:assumed-role\/([^/]+)\/.+$/);
  if (!assumedRoleMatch) {
    return arn || undefined;
  }
  const [, roleName] = assumedRoleMatch;
  try {
    const roleArn = run('aws', ['iam', 'get-role', '--role-name', roleName, '--query', 'Role.Arn', '--output', 'text'], { silent: true });
    return roleArn || undefined;
  } catch {
    return undefined;
  }
}

export interface RegistryAccessEntry {
  seName: string;
  sePrincipalArn?: string;
}

/** Scans the full SE registry for `access-stack.ts`'s benefit — it needs every SE's own
 * `sePrincipalArn` (not just the current onboard/offboard run's) to recompute, per distinct IAM
 * principal ARN, the full union of `demo-host-<seName>-owner` Kubernetes groups for every SE who
 * shares it. This replaced the old `hasExistingEksAccessEntry()` skip-the-grant workaround: that
 * approach checked only "does this ARN have SOME entry", which fails silently for the SECOND (and
 * every subsequent) SE sharing an AWS SSO permission set's IAM role ARN, since only the first
 * SE's own group ever got attached. `AccessStack` now owns the whole ARN-keyed entry, keyed
 * correctly on the thing EKS actually enforces uniqueness on, so this scan — not a per-caller
 * existence check — is the right client-side input.
 *
 * SEs onboarded before this field existed have `sePrincipalArn: undefined` here until backfilled
 * (a one-time `dynamodb update-item` per pre-existing record — see the migration plan). */
export function scanRegistryForAccessEntries(region: string): RegistryAccessEntry[] {
  const raw = run('aws', [
    'dynamodb', 'scan',
    '--table-name', SE_REGISTRY_TABLE,
    '--projection-expression', 'seName, sePrincipalArn',
    '--region', region,
  ], { silent: true });
  const items = raw ? JSON.parse(raw).Items ?? [] : [];
  return items.map((item: any) => ({
    seName: item.seName?.S,
    sePrincipalArn: item.sePrincipalArn?.S,
  }));
}

/** Grants every registered SE's own IAM identity EKS cluster access, keyed correctly on the thing
 * EKS actually enforces uniqueness on — the IAM principal ARN, not the SE name. Deployed as its
 * own stack, separate from any individual SE's, precisely because AWS SSO permission sets give
 * every SE assigned to them the same underlying role ARN: EKS allows only one Access Entry per
 * ARN per cluster, so this can't be owned by a per-SE stack without colliding the moment a second
 * SE shares a permission set with an existing one (this used to be handled by a client-side
 * `hasExistingEksAccessEntry()` check that silently skipped granting access to whichever SE lost
 * that race — see the infra repo's `access-stack.ts` for the real fix). Shared by onboard.ts (run
 * right after registering the new SE) and offboard.ts (run right after removing one), so the
 * group list this recomputes always reflects current registry contents. */
export function deployAccessStack(infraDir: string, region: string): void {
  const registryEntries = scanRegistryForAccessEntries(region);
  console.log(`\nDeploying ${accessStackName()} — grants EKS cluster access for every registered SE's own IAM identity.\n`);
  bridgeAwsCredentialsForCdk();
  runStreaming('npx', [
    'cdk', 'deploy', accessStackName(),
    '--require-approval', 'never',
    '-c', `registryEntries=${JSON.stringify(registryEntries)}`,
  ], { cwd: infraDir });
}

/** True if `principalArn` already has an EKS access entry that grants access via an AWS-managed
 * `AccessPolicy` (empty `kubernetesGroups`) rather than via Kubernetes groups — e.g. the platform
 * admin's own `SSO-AdminAccess` role, granted cluster-admin by `PlatformStack`'s
 * `ClusterAdminAccessEntry`. `AccessStack` manages ARN->group mappings only; an identity granted
 * access this other way already has broader access than a group grant would add, and including
 * it in `AccessStack`'s input would collide with the entry that ALREADY owns that ARN (a
 * CloudFormation "already exists" failure on `AccessStack`'s next deploy) — this is checked
 * up front so onboard.ts can skip storing `sePrincipalArn` for exactly that identity, the same way
 * it would for any other reason `resolveOwnPrincipalArnForEks()` itself couldn't resolve one.
 *
 * Deliberately NOT "does this ARN have ANY entry at all" — that was the old, wrong check
 * (`hasExistingEksAccessEntry`, removed): it also matched the ordinary case of two SEs sharing an
 * AWS SSO permission set, which `AccessStack` is specifically designed to handle correctly rather
 * than skip. Fails open (`false`) on any lookup error, including "no entry exists yet" (the common
 * case for a brand-new SE) — the caller still gets a correct grant once `AccessStack` runs. */
export function hasNonGroupAccessEntry(principalArn: string, region: string): boolean {
  try {
    const raw = run('aws', [
      'eks', 'describe-access-entry',
      '--cluster-name', CLUSTER_NAME,
      '--principal-arn', principalArn,
      '--region', region,
      '--query', 'accessEntry.kubernetesGroups',
      '--output', 'json',
    ], { silent: true });
    const groups = raw ? JSON.parse(raw) : [];
    return Array.isArray(groups) && groups.length === 0;
  } catch {
    return false;
  }
}

export function checkAwsCredentials(): void {
  try {
    run('aws', ['sts', 'get-caller-identity'], { silent: true });
  } catch {
    throw new Error(
      'No valid AWS credentials found for the shared platform account. Authenticate (e.g. ' +
        '`aws sso login`) and re-run — this is the entire access-control model for onboarding/offboarding.',
    );
  }
}

/** Fails fast, with an actionable message, if no PlatformStack/RegistryStack exists in the given
 * region — since the platform is region-siloed, this is a real, expected way for onboarding or
 * offboarding to be pointed at the wrong place (e.g. a laptop's AWS CLI region left over from
 * unrelated work), and without this check the failure surfaces much later as a cryptic
 * SSM-parameter-not-found or DynamoDB-table-not-found error deep inside some other function. */
export function verifyPlatformExistsInRegion(region: string): void {
  const missing: string[] = [];
  try {
    run('aws', ['ssm', 'get-parameter', '--name', '/demo-host/platform/clusterName', '--region', region], { silent: true });
  } catch {
    missing.push('the EKS cluster (PlatformStack)');
  }
  try {
    run('aws', ['dynamodb', 'describe-table', '--table-name', SE_REGISTRY_TABLE, '--region', region], { silent: true });
  } catch {
    missing.push('the SE registry (RegistryStack)');
  }
  if (missing.length) {
    throw new Error(
      `No shared demo hosting platform found in region "${region}" — missing: ${missing.join(', ')}.\n` +
        'This platform is deployed independently per region. Either point your AWS CLI at a region ' +
        'where one already exists (`aws configure set region <region>`, or `export AWS_REGION=<region>` ' +
        'for just this run), or ask a platform admin to deploy one in this region first.',
    );
  }
}

/** Clones the infra repo into a fresh temp dir and installs its dependencies — the shared setup
 * step both `cdk deploy` (onboard.ts) and `cdk destroy` (offboard.ts) need before they can run.
 * Returns the `infra/` subdirectory path (where `cdk.json` actually lives).
 *
 * Uses `gh repo clone`, not a raw `git clone` of the HTTPS URL — confirmed for real: the infra
 * repo is private, and a plain `git clone` against a private repo only avoids an interactive
 * username/password prompt if git's own credential helper is separately wired to GitHub (`gh
 * auth setup-git`, SSH keys, a credential manager, etc.). `gh auth login` — already a hard
 * prerequisite for this script, used elsewhere for `gh variable set`/`gh secret set`/`gh pr
 * create` — does NOT always do that wiring automatically, so a second real user with a perfectly
 * valid `gh` session (and even collaborator access to the repo) still hit the prompt. `gh repo
 * clone` injects the CLI's own authenticated credentials directly, with no dependency on git's
 * separate config. */
export function cloneInfraRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-host-infra-'));
  console.log(`\nCloning platform infra into ${tmpDir} ...`);
  run('gh', ['repo', 'clone', INFRA_REPO_SLUG, tmpDir, '--', '--depth', '1']);
  const infraDir = path.join(tmpDir, 'infra');

  console.log('Installing infra dependencies ...');
  runStreaming('npm', ['ci'], { cwd: infraDir });

  return infraDir;
}
