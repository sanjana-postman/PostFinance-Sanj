import * as fs from 'fs';
import * as path from 'path';

export interface PostmanResources {
  workspaceId?: string;
  /** Keyed by the environment file's repo-relative path (e.g.
   * "postman/environments/AWS Dev.environment.yaml"), value is that environment's stable cloud
   * UID. */
  environmentIds: Record<string, string>;
  /** Keyed by the collection folder's repo-relative path (e.g.
   * "postman/collections/PostFinanceCo API"), value is that collection's stable cloud UID. Added
   * for scripts/create-monitors.ts, which needs a collection UID to create a monitor against —
   * narrower than a previously-attempted version of this file that also added `specIds`
   * speculatively for an unrelated, abandoned theory; this field is the only addition, and it's
   * directly required by that feature. */
  collectionIds: Record<string, string>;
}

/** Extracts the indented block of lines directly under `<sectionName>:` (stops at the next
 * same-or-lesser-indented line), then pulls a `../<repoRelativePath>: <cloudUid>` pair out of
 * each line. Shared by both `collections:` and `environments:` below — same line shape in both
 * cases, just a different path suffix. */
function parseIdSection(content: string, sectionName: string): Record<string, string> {
  const ids: Record<string, string> = {};
  const section = content.match(new RegExp(`${sectionName}:\\s*\\n((?:[ \\t]{4,}.*\\n?)*)`))?.[1] ?? '';
  for (const line of section.split('\n')) {
    // The file stores paths relative to `.postman/` (e.g. "../postman/environments/AWS
    // Dev.environment.yaml") — strip the leading "../" to get the repo-relative path onboard.ts
    // itself uses ("postman/environments/AWS Dev.environment.yaml").
    const m = line.match(/\.\.\/(.+):\s*(\S+)/);
    if (m) ids[m[1]] = m[2];
  }
  return ids;
}

/** `.postman/resources.yaml` is written by the Postman desktop app's Native Git-sync "Push to
 * Postman Cloud" step — a step already required before onboarding runs (see README's "Postman
 * setup"). It already carries the workspace ID and, once resources have been pushed at least
 * once, a stable cloud UID per environment/collection file — no need to ask the SE to paste
 * anything that's already sitting right here. Deliberately a small regex/line-scan, not a full
 * YAML parser dependency — matches this repo's existing preference (see onboard.ts's
 * setEnvironmentValue) for avoiding a YAML library for this project's simple, fixed file shapes.
 * Missing file, or missing sections (SE hasn't pushed yet), both degrade gracefully to an empty
 * result rather than throwing — callers fall back to prompting. */
export function readPostmanResources(repoRoot: string): PostmanResources {
  const filePath = path.join(repoRoot, '.postman', 'resources.yaml');
  if (!fs.existsSync(filePath)) return { environmentIds: {}, collectionIds: {} };

  const content = fs.readFileSync(filePath, 'utf-8');
  const workspaceId = content.match(/workspace:\s*\n\s*id:\s*(\S+)/)?.[1];
  const environmentIds = parseIdSection(content, 'environments');
  const collectionIds = parseIdSection(content, 'collections');
  return { workspaceId, environmentIds, collectionIds };
}
