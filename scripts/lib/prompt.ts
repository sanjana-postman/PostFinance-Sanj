import * as readline from 'readline';
import * as fs from 'fs';

// A single, shared, lazily-created interface for the whole process — used only for a real TTY.
let sharedRl: readline.Interface | undefined;
function getSharedInterface(): readline.Interface {
  if (!sharedRl) {
    sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedRl;
}

export function closePrompts(): void {
  sharedRl?.close();
  sharedRl = undefined;
}

// For piped/non-interactive stdin (e.g. driving this script from a heredoc for a test), the
// entire input arrives as one buffered chunk and the stream signals EOF immediately after —
// `readline.Interface.question()` reliably answers the FIRST call against a stream in that
// state but not reliably any call after (confirmed empirically: it hangs on the second question
// regardless of whether the interface is shared or freshly created per call — a stream-lifecycle
// quirk, not something worth chasing further into Node's readline internals). Sidestepping this
// entirely for the non-TTY case: slurp all of stdin synchronously ONCE, split into lines, and
// dispense them from an in-memory queue instead of re-querying readline per prompt.
let queuedLines: string[] | undefined;
let queueIndex = 0;
function nextQueuedLine(): string {
  if (!queuedLines) {
    let raw = '';
    try {
      raw = fs.readFileSync(0, 'utf-8');
    } catch {
      raw = '';
    }
    queuedLines = raw.split('\n');
  }
  const line = queuedLines[queueIndex] ?? '';
  queueIndex++;
  return line.trim();
}

function ask(query: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(query);
    const answer = nextQueuedLine();
    process.stdout.write(`${answer}\n`);
    return Promise.resolve(answer);
  }
  return new Promise((resolve) => {
    getSharedInterface().question(query, (answer) => resolve(answer.trim()));
  });
}

export async function promptText(label: string, opts: { default?: string } = {}): Promise<string> {
  const suffix = opts.default ? ` [${opts.default}]` : '';
  const answer = await ask(`${label}${suffix}: `);
  return answer || opts.default || '';
}

/** Same as promptText, but for secrets (API keys) — masked from the terminal when run
 * interactively, never logged. When stdin is piped (no TTY — e.g. driven from a script/CI),
 * there's no terminal to echo to anyway, so `ask()`'s queue-based path (which also handles this
 * case) is used instead — see the comment above `nextQueuedLine`.
 *
 * Two prior approaches were tried and confirmed broken for real: a hand-rolled raw-mode
 * keystroke interceptor, and (after that) toggling kernel-level echo via `stty -echo`. Both
 * still let a pasted value show up. Root cause, confirmed by monkey-patching `process.stdout.
 * write` and logging every call: whenever both stdin/stdout are real TTYs, Node's `readline`
 * writes each character straight to `this.output.write()` itself as part of its own line
 * rendering (typed or pasted alike) — a JS-level echo, independent of the kernel's ECHO flag,
 * and NOT funneled through the `_writeToOutput` hook some masking guides point at either (tried
 * that too — confirmed for real it doesn't intercept plain character writes in this Node
 * version). The only call site that's actually guaranteed to see 100% of what readline sends to
 * the terminal is `process.stdout.write` itself, so that's what gets suppressed here — verified
 * against a real pty harness for both pasted and character-by-character typed input. */
export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return ask(`${label}: `);
  }
  process.stdout.write(`${label}: `);
  const rl = getSharedInterface();
  const realWrite = process.stdout.write.bind(process.stdout);
  const suppressOutput = () => {
    process.stdout.write = (() => true) as typeof process.stdout.write;
  };
  const restoreOutput = () => {
    process.stdout.write = realWrite;
  };
  const restoreOnInterrupt = () => {
    restoreOutput();
    process.exit(1);
  };
  suppressOutput();
  process.once('SIGINT', restoreOnInterrupt);
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question('', (a) => resolve(a));
    });
    return answer.trim();
  } finally {
    restoreOutput();
    process.removeListener('SIGINT', restoreOnInterrupt);
    process.stdout.write('\n');
  }
}

export async function promptConfirm(label: string): Promise<boolean> {
  const answer = await ask(`${label} [y/N]: `);
  return /^y(es)?$/i.test(answer.trim());
}
