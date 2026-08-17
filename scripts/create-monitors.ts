#!/usr/bin/env npx ts-node
/**
 * Creates a Postman Monitor for "AWS Prod" that periodically runs this repo's smoke-test
 * collection against your live deployed instance. Run manually, once you've finished onboarding
 * (see printFinalInstructions in onboard.ts):
 *
 *   npx ts-node scripts/create-monitors.ts
 *
 * ...or non-interactively with `--postman-api-key <key> -y` (see `--help`). Postman-only — no AWS
 * credentials are touched by this script at all. Safe to re-run: a monitor whose name already
 * exists in the workspace is skipped, not duplicated.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { promptConfirm, promptSecret, closePrompts } from './lib/prompt';
import { reExecWithCaCertsIfNeeded } from './lib/ca-certs';
import { createMonitor, listMonitors } from './lib/postman';
import { readPostmanResources } from './lib/postman-resources';

// See onboard.ts's identical call for why this must run before anything else in the module.
reExecWithCaCertsIfNeeded();

const CRON = '0 */6 * * *';
const TIMEZONE = 'Etc/UTC';

const TARGETS = [
  { envFile: 'postman/environments/AWS Prod.environment.yaml', monitorName: 'AWS Prod Health Check' },
];

interface CliOptions {
  postmanApiKey?: string;
  yes: boolean;
}

function printHelp(): void {
  console.log(`Usage: npx ts-node scripts/create-monitors.ts [options]

  --postman-api-key <key>   Your Postman API key (or set the POSTMAN_API_KEY env var — preferred
                             for non-interactive use, since it won't show up in \`ps\`/shell
                             history the way a CLI argument does)
  -y, --yes                 Skip the confirmation prompt before creating monitors
  -h, --help                Show this help
`);
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'postman-api-key': { type: 'string' },
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
    postmanApiKey: values['postman-api-key'] ?? process.env.POSTMAN_API_KEY,
    yes: values.yes ?? false,
  };
}

/** `deploy.yml`'s own `test` job already names the one collection CI treats as canonical for this
 * SE's instance (see the "postman collection run" step) — reusing that exact path means this
 * script never has to ask the SE to disambiguate between the repo's API-version collection
 * variants (PostFinanceCo API / V1.5 / V2 — see README's "API version switch" section) itself.
 * Checks `.github/workflows/` first (the active location once onboard.ts has activated it), then
 * falls back to `.github/workflows-staging/` (pre-activation). */
function findCanonicalCollectionPath(repoRoot: string): string {
  const candidates = [
    path.join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    path.join(repoRoot, '.github', 'workflows-staging', 'deploy.yml'),
  ];
  const deployYmlPath = candidates.find((p) => fs.existsSync(p));
  if (!deployYmlPath) {
    throw new Error(
      `Could not find deploy.yml in either ${candidates[0]} or ${candidates[1]} — is this script ` +
        'being run from the root of your onboarded repo clone?',
    );
  }
  const content = fs.readFileSync(deployYmlPath, 'utf-8');
  const match = content.match(/postman collection run "([^"]+)"/);
  if (!match) {
    throw new Error(`Could not find a "postman collection run" step in ${deployYmlPath} to determine the collection to monitor.`);
  }
  return match[1];
}

async function main() {
  const cli = parseCliOptions();
  console.log('=== SE Demo Hosting Platform — Create Monitors ===\n');

  const repoRoot = process.cwd();
  const postmanResources = readPostmanResources(repoRoot);
  if (!postmanResources.workspaceId) {
    throw new Error(
      '.postman/resources.yaml has no workspace ID yet — push your workspace to Postman Cloud from ' +
        'the desktop app first (see README\'s "Postman setup"), then re-run this script.',
    );
  }

  const missingEnvs = TARGETS.filter((t) => !postmanResources.environmentIds[t.envFile]);
  if (missingEnvs.length > 0) {
    throw new Error(
      `.postman/resources.yaml is missing a cloud ID for: ${missingEnvs.map((t) => t.envFile).join(', ')}. ` +
        'This is exactly the sync-completeness check onboard.ts asks you to do before committing — ' +
        'push your workspace to Postman Cloud from the desktop app again, let it fully finish, then re-run this script.',
    );
  }

  const collectionPath = findCanonicalCollectionPath(repoRoot);
  const collectionId = postmanResources.collectionIds[collectionPath];
  if (!collectionId) {
    throw new Error(
      `.postman/resources.yaml has no cloud ID for "${collectionPath}" (the collection deploy.yml's test job runs). ` +
        'Push your workspace to Postman Cloud from the desktop app again, let it fully finish, then re-run this script.',
    );
  }

  const postmanApiKey =
    cli.postmanApiKey ??
    (await promptSecret(
      'Your Postman API key (must have monitor-create permission on this workspace; set ' +
        'POSTMAN_API_KEY instead to avoid pasting it interactively)',
    ));

  console.log('\nAbout to create, in workspace ' + postmanResources.workspaceId + ':');
  for (const target of TARGETS) {
    console.log(`  "${target.monitorName}" — collection "${collectionPath}", environment "${target.envFile}"`);
  }
  console.log(`  Schedule: ${CRON} (${TIMEZONE}) — every 6 hours.`);
  console.log(
    '\nMonitor runs count against your Postman team\'s monitoring-usage quota — this is a real, ' +
      'ongoing cost, not a one-time setup step.',
  );
  const confirmed = cli.yes || (await promptConfirm('Continue?'));
  closePrompts();
  if (!confirmed) {
    console.log('\nAborted — no monitors created.');
    process.exit(0);
  }

  const existingMonitors = await listMonitors(postmanApiKey, postmanResources.workspaceId);

  for (const target of TARGETS) {
    if (existingMonitors.some((m) => m.name === target.monitorName)) {
      console.log(`\n"${target.monitorName}" already exists — skipping.`);
      continue;
    }
    const monitor = await createMonitor(postmanApiKey, {
      workspaceId: postmanResources.workspaceId,
      name: target.monitorName,
      collectionId,
      environmentId: postmanResources.environmentIds[target.envFile],
      cron: CRON,
      timezone: TIMEZONE,
    });
    console.log(`\nCreated "${monitor.name}" (id: ${monitor.id}).`);
  }

  console.log('\n=== Done ===');
  console.log('Find your monitors under this workspace\'s Monitors tab in Postman.');
  console.log('Schedule and notification settings can be adjusted there at any time.');
}

main().catch((err) => {
  console.error(`\nCreating monitors failed: ${err.message}`);
  process.exit(1);
});
