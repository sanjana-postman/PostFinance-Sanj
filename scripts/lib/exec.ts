import { execFileSync, ExecFileSyncOptionsWithStringEncoding } from 'child_process';

/** Runs a command and returns trimmed stdout, throwing with stderr surfaced on failure. Never
 * uses a shell (execFileSync with an argv array) — every value onboard.ts feeds in here (SE
 * name, workspace IDs, etc.) is user-provided, and shell interpolation of unsanitized input is
 * exactly the kind of command-injection risk to avoid. */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; silent?: boolean; input?: string } = {},
): string {
  const opts: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    cwd: options.cwd,
    // `input` implies stdin is fed programmatically rather than inherited — stdio's first
    // element is ignored by execFileSync in that case, but 'pipe' keeps the type happy either way.
    stdio: options.silent || options.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'inherit'],
    input: options.input,
  };
  try {
    return execFileSync(command, args, opts).toString().trim();
  } catch (err: any) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${stderr || err.message}`);
  }
}

/** Same as `run`, but streams stdout/stderr live instead of capturing — use for long-running
 * commands (cdk deploy, npm ci) where the SE should see progress rather than a silent hang. */
export function runStreaming(command: string, args: string[], options: { cwd?: string } = {}): void {
  execFileSync(command, args, { cwd: options.cwd, stdio: 'inherit' });
}
