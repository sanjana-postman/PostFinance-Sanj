#!/usr/bin/env npx ts-node
/**
 * Tears down THIS repo's SE instance from the shared demo hosting platform — the mirror image of
 * scripts/onboard.ts. Run from inside your cloned copy of the template repo, interactively:
 *
 *   npx ts-node scripts/offboard.ts
 *
 * ...or non-interactively with `--se-name <name> -y` (see `--help`). Same access-control model as
 * onboarding: valid AWS credentials for the shared platform account, nothing else. This script
 * only ever destroys your own independent `SE-SDLC-DEMO-SeStack-<you>` — it cannot affect the
 * shared cluster or any other SE's resources.
 *
 * This is PERMANENT: your ECR repo (and every image in it), both namespaces' pods/Ingress rules,
 * and your CI IAM role are all deleted. Any in-flight GitHub Actions deploy against this SE will
 * fail immediately once the CI role is gone.
 */
import { parseArgs } from 'util';
import { run, runStreaming } from './lib/exec';
import { closePrompts, promptConfirm, promptText } from './lib/prompt';
import { sanitizeSeName } from './lib/naming';
import { bridgeAwsCredentialsForCdk } from './lib/aws-creds';
import { reExecWithCaCertsIfNeeded } from './lib/ca-certs';
import {
  CLUSTER_NAME,
  SE_REGISTRY_TABLE,
  checkAwsCredentials,
  cloneInfraRepo,
  deployAccessStack,
  detectSeNameFromAwsIdentity,
  parseGithubRepo,
  resolveAwsRegion,
  seStackName,
  verifyPlatformExistsInRegion,
} from './lib/infra-repo';

// See onboard.ts's identical call for why this must run before anything else in the module.
reExecWithCaCertsIfNeeded();

interface CliOptions {
  seName?: string;
  yes: boolean;
}

function printHelp(): void {
  console.log(`Usage: npx ts-node scripts/offboard.ts [options]

  --se-name <name>   SE name to tear down (default: derived from your AWS login)
  -y, --yes          Skip the destructive-action confirmation prompt
  -h, --help         Show this help
`);
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'se-name': { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printHelp();
    process.exit(0);
  }
  return { seName: values['se-name'], yes: values.yes ?? false };
}

const AWS_REGION = resolveAwsRegion();

interface RegistryRecord {
  seName: string;
  githubRepo: string;
  postmanWorkspaceId: string;
  onboardedAt: string;
}

function getRegistryRecord(seName: string): RegistryRecord | undefined {
  let raw: string;
  try {
    raw = run('aws', [
      'dynamodb', 'get-item',
      '--table-name', SE_REGISTRY_TABLE,
      '--key', JSON.stringify({ seName: { S: seName } }),
      '--region', AWS_REGION,
    ], { silent: true });
  } catch {
    throw new Error(`Could not read the SE registry table "${SE_REGISTRY_TABLE}" — has PlatformStack/RegistryStack been deployed yet?`);
  }
  if (!raw) return undefined;
  const item = JSON.parse(raw).Item;
  if (!item) return undefined;
  return {
    seName: item.seName?.S,
    githubRepo: item.githubRepo?.S,
    postmanWorkspaceId: item.postmanWorkspaceId?.S,
    onboardedAt: item.onboardedAt?.S,
  };
}

function deleteRegistryRecord(seName: string): void {
  run('aws', [
    'dynamodb', 'delete-item',
    '--table-name', SE_REGISTRY_TABLE,
    '--key', JSON.stringify({ seName: { S: seName } }),
    '--region', AWS_REGION,
  ]);
}

/** Tolerates the parameter already being gone — a re-run after a partially-failed prior attempt,
 * or a platform admin having already cleaned it up by hand, are both fine. */
function deleteSsmParameterIfExists(name: string): void {
  try {
    run('aws', ['ssm', 'delete-parameter', '--name', name, '--region', AWS_REGION], { silent: true });
  } catch (err: any) {
    if (!/ParameterNotFound/.test(err.message)) throw err;
  }
}

/**
 * `cdk destroy` is purely identity-based, never content-based — confirmed by reading the CDK
 * CLI's own source: it looks up the already-deployed stack by name via DescribeStacks, then calls
 * plain DeleteStack. It never reads the freshly-synthesized template body, and never diffs it
 * against the deployed one (that comparison only exists on the `deploy` path). Stack identity
 * comes from the stack name (`seStackName(seName)`, driven only by `seName`) and the account/
 * region from real AWS credentials — never from `postmanWorkspaceId`/`postmanSystemEnvId`.
 * `infra/bin/app.ts` only checks those three for truthiness before it can synthesize the SeStack
 * construct at all, so fixed placeholders here are genuinely safe, not a shortcut that happens to
 * work — don't "fix" this into doing a real Postman lookup, it would be pure wasted work.
 */
const PLACEHOLDER_CONTEXT_VALUE = 'offboarding';

function destroySeStack(infraDir: string, seName: string, githubRepo: string): void {
  console.log(`\nDestroying ${seStackName(seName)} — this ONLY touches your own stack, never PlatformStack.\n`);
  bridgeAwsCredentialsForCdk();
  runStreaming(
    'npx',
    [
      'cdk', 'destroy', seStackName(seName),
      '--force',
      '-c', `seName=${seName}`,
      '-c', `githubRepo=${githubRepo}`,
      '-c', `postmanWorkspaceId=${PLACEHOLDER_CONTEXT_VALUE}`,
      '-c', `staging:postmanSystemEnvId=${PLACEHOLDER_CONTEXT_VALUE}`,
      '-c', `prod:postmanSystemEnvId=${PLACEHOLDER_CONTEXT_VALUE}`,
    ],
    { cwd: infraDir },
  );
}

async function main() {
  const cli = parseCliOptions();
  console.log('=== SE Demo Hosting Platform — Offboarding ===\n');
  checkAwsCredentials();
  console.log(`Using AWS region: ${AWS_REGION} (from your AWS CLI config — the platform is deployed per-region).`);
  verifyPlatformExistsInRegion(AWS_REGION);
  bridgeAwsCredentialsForCdk();

  const detectedSeName = detectSeNameFromAwsIdentity();
  const seNameRaw = cli.seName ?? (await promptText('SE name to tear down', { default: detectedSeName }));
  const seName = sanitizeSeName(seNameRaw);
  console.log(`Using sanitized SE name: ${seName}`);

  const record = getRegistryRecord(seName);
  if (!record) {
    throw new Error(`"${seName}" is not registered in the platform registry — nothing to tear down.`);
  }

  // Mirrors upsertRegistryRecord's own collision guard in onboard.ts: catches running this from
  // the wrong local clone with an SE name that happens to collide with someone else's.
  const remoteUrl = run('git', ['remote', 'get-url', 'origin']);
  const githubRepo = parseGithubRepo(remoteUrl);
  if (record.githubRepo !== githubRepo) {
    throw new Error(
      `Registry record for "${seName}" belongs to a different repo (${record.githubRepo}), not this one ` +
        `(${githubRepo}). Refusing to continue — double-check the SE name, or that you're running this from ` +
        'the right repo clone.',
    );
  }

  console.log(
    `\nFound registry record for "${seName}" (onboarded ${record.onboardedAt}, repo ${record.githubRepo}).\n\n` +
      'This will PERMANENTLY:\n' +
      `  - Destroy CloudFormation stack ${seStackName(seName)}\n` +
      `    (both ${seName}-staging/${seName}-prod namespaces, pods, Ingress rules, ECR repo + all images, CI IAM role)\n` +
      `  - Delete 4 SSM parameters under /demo-host/${seName}/*\n` +
      `  - Remove the registry record for "${seName}"\n\n` +
      'Any in-flight GitHub Actions deploy against this SE will fail immediately once the CI role is gone.\n' +
      'This does NOT touch your Postman workspace/collection/System Environments — clean those up yourself if desired.\n',
  );
  const confirmed = cli.yes || (await promptConfirm('Continue?'));
  closePrompts();
  if (!confirmed) {
    console.log('\nAborted — nothing was destroyed.');
    process.exit(0);
  }

  // Destroy the real infrastructure FIRST, and only clean up the SSM params/registry record once
  // that has actually succeeded — `cdk destroy` on an already-gone stack is itself a safe no-op
  // (it short-circuits if the stack doesn't exist), so this ordering means a failed/interrupted
  // run always leaves the SE in a "still findable, still has real resources" state rather than
  // "registry gone but a real, billable stack silently orphaned."
  const infraDir = cloneInfraRepo();
  destroySeStack(infraDir, seName, githubRepo);

  console.log('\nCleaning up SSM secrets ...');
  for (const envName of ['staging', 'prod']) {
    deleteSsmParameterIfExists(`/demo-host/${seName}/${envName}/admin-api-key`);
    deleteSsmParameterIfExists(`/demo-host/${seName}/${envName}/postman-insights-key`);
  }

  console.log('Removing registry record ...');
  deleteRegistryRecord(seName);

  // Recomputes the shared access entry's group list now that this SE's registry record is gone —
  // without this, a departing SE sharing an AWS SSO permission set's ARN with another active SE
  // would leave that ARN's Kubernetes groups stale (harmless), but more importantly this is what
  // keeps AccessStack's state in sync with the registry going forward.
  console.log('Updating shared EKS access entries ...');
  deployAccessStack(infraDir, AWS_REGION);

  console.log('\n=== Offboarding complete ===');
  console.log(`"${seName}" has been fully removed from the shared platform (cluster: ${CLUSTER_NAME}).`);
  console.log('\nStill your responsibility, left untouched by this script:');
  console.log('  - Your Postman workspace, collection, and System Environments (never created by this platform).');
  console.log('  - This repo\'s GitHub Actions variables and local postman/environments/*.yaml files —');
  console.log('    harmless dead references now that the CI role is gone, but yours to clean up if you\'d like.');
}

main().catch((err) => {
  console.error(`\nOffboarding failed: ${err.message}`);
  process.exit(1);
});
