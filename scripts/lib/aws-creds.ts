import { run } from './exec';

const BRIDGED_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

/**
 * The `aws` CLI understands `aws login`'s short-term, auto-rotating SSO credential cache; the
 * CDK CLI's Node SDK does not — only plain env vars. Bridges one to the other via
 * `aws configure export-credentials`, exactly like the reference repo's deploy.sh.
 *
 * Unlike deploy.sh (which only calls this once, despite its own README claiming otherwise —
 * checked directly, no retry/unset logic exists there), this ALWAYS unsets the three AWS_* vars
 * before re-deriving. Skipping that step is the real gotcha: once a shell has exported these
 * once, they permanently outrank the SSO/login source in the credential-provider chain — every
 * later `export-credentials` call just echoes back the same frozen, eventually-expired snapshot,
 * no matter how many times `aws login` is re-run elsewhere. Call this again right before the
 * long-running `cdk deploy` step specifically, to get the freshest possible token right before
 * the step most likely to outlast a short-lived session.
 */
export function bridgeAwsCredentialsForCdk(): void {
  for (const key of BRIDGED_VARS) {
    delete process.env[key];
  }
  // `--format json` looks like a documented AWS CLI v2 option, but isn't a valid choice on
  // every CLI build (hit a real "Found invalid choice 'json'" error on one) — `env-no-export`
  // (plain `KEY=value` lines, no `export ` prefix, no JSON parsing needed) is supported
  // everywhere `env` is, so there's no reason to risk the less-portable option.
  const raw = run('aws', ['configure', 'export-credentials', '--format', 'env-no-export'], { silent: true });
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (BRIDGED_VARS.includes(key)) {
      process.env[key] = value;
    }
  }
}
