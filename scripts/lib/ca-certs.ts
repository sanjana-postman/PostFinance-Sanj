import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

/** Best-effort: exports the same two keychains `curl`/the `aws` CLI already trust into a PEM
 * bundle on disk, or returns undefined (non-macOS, or nothing found). See the module doc comment
 * on why both keychains are needed. */
function writeCaCertBundle(): string | undefined {
  try {
    const bundle = execFileSync(
      'security',
      ['find-certificate', '-a', '-p', '/Library/Keychains/System.keychain', '/System/Library/Keychains/SystemRootCertificates.keychain'],
      { encoding: 'utf-8' },
    );
    if (!bundle.trim()) return undefined;
    const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-bundle-')), 'roots.pem');
    fs.writeFileSync(bundlePath, bundle);
    return bundlePath;
  } catch {
    return undefined;
  }
}

/**
 * On macOS, Node doesn't trust the same CA store `curl`/the `aws` CLI use — a corporate
 * MITM/proxy root CA (common on managed corporate laptops) usually lives only in
 * `SystemRootCertificates.keychain`, not `System.keychain` alone. Without this, `npm ci`/
 * `cdk deploy` (both spawned from this script) fail with `unable to get local issuer
 * certificate` — hit this for real setting up the platform's own infra repo. Exporting just
 * `System.keychain` alone was NOT enough there; both keychains combined were required.
 *
 * `NODE_EXTRA_CA_CERTS` is only read by Node at process **startup** — setting
 * `process.env.NODE_EXTRA_CA_CERTS` from already-running code does nothing for THIS process's own
 * `fetch()`/TLS calls (confirmed for real: onboard.ts's own Postman API Catalog lookup kept
 * failing with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` even after this ran, despite the exact same
 * env var working fine for the `cdk deploy`/`npm ci` CHILD processes spawned later — those are new
 * processes that read the env var at their own startup). The only way to make it take effect for
 * the current process's own outbound calls is to re-exec: spawn an identical copy of this same
 * script as a child process with the env var already set before that child's Node runtime
 * initializes, then exit once it finishes. A no-op (returns without spawning) if the bundle can't
 * be built or the var is already set — e.g. because a parent invocation already did this.
 */
export function reExecWithCaCertsIfNeeded(): void {
  if (process.env.NODE_EXTRA_CA_CERTS || os.platform() !== 'darwin') {
    return;
  }
  const bundlePath = writeCaCertBundle();
  if (!bundlePath) return;
  const scriptPath = process.argv[1];
  const userArgs = process.argv.slice(2);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: bundlePath };
  // ts-node's CLI (how this script is normally run, per its own shebang) rewrites argv[1] to the
  // raw .ts file path and injects its require/ESM hook into only the CURRENT process — a plain
  // `node <that .ts path>` child has no such hook and fails outright on TypeScript syntax.
  // Re-invoke through `npx ts-node` again so the child picks up the same hook properly; a
  // compiled `.js` entry point (no ts-node involved) just re-execs directly.
  const result = scriptPath.endsWith('.ts')
    ? spawnSync('npx', ['ts-node', scriptPath, ...userArgs], { stdio: 'inherit', env })
    : spawnSync(process.execPath, [scriptPath, ...userArgs], { stdio: 'inherit', env });
  process.exit(result.status ?? 1);
}
