const POSTMAN_API_BASE = 'https://api.postman.com';

export interface SystemEnvironment {
  id: string;
  name: string;
  label: string;
  isProduction: boolean;
}

/** Paginates through the team's full System Environment list. This endpoint is team-wide, not
 * workspace-scoped — the API Catalog has no "list system environments for workspace X" call, and
 * individual environment objects carry no workspace field (confirmed against the live API
 * reference) — so matching by name is the only option, not a shortcut taken for convenience. */
export async function listSystemEnvironments(apiKey: string): Promise<SystemEnvironment[]> {
  const results: SystemEnvironment[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${POSTMAN_API_BASE}/api-catalog/system-environments`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) {
      throw new Error(
        `Postman API Catalog request failed (${res.status} ${res.statusText}) — check the API key's ` +
          'team-admin tier and that your Postman plan includes API Catalog (Enterprise-tier feature).',
      );
    }
    const body = (await res.json()) as { data?: SystemEnvironment[]; meta?: { nextCursor?: string } };
    results.push(...(body.data ?? []));
    cursor = body.meta?.nextCursor;
  } while (cursor);
  return results;
}

/** Merge-updates a live Postman environment by its exact, existing cloud UID — a GET, then merge
 * the given keys into whatever values already exist (adding any that are missing, leaving every
 * other variable the SE may have added completely untouched), then PUT the whole thing back.
 * Deliberately never creates or re-links anything: this only writes to an environment the SE
 * already made and (per the Postman-side setup steps) already linked to a System Environment
 * themselves. Using the known ID rather than depending on the SE's own manual `postman workspace
 * push` is exactly what keeps that link intact — confirmed for real that manual push was breaking
 * it, most likely by not consistently updating the existing environment object in place. */
export async function updateEnvironmentValues(
  apiKey: string,
  environmentId: string,
  updates: Record<string, string>,
): Promise<void> {
  const url = `${POSTMAN_API_BASE}/environments/${environmentId}`;
  const getRes = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!getRes.ok) {
    throw new Error(`Could not fetch Postman environment ${environmentId} (${getRes.status} ${getRes.statusText}).`);
  }
  const { environment } = (await getRes.json()) as {
    environment: { name: string; values: { key: string; value: string; enabled?: boolean }[] };
  };
  const values = environment.values ?? [];
  for (const [key, value] of Object.entries(updates)) {
    const existing = values.find((v) => v.key === key);
    if (existing) existing.value = value;
    else values.push({ key, value, enabled: true });
  }
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ environment: { name: environment.name, values } }),
  });
  if (!putRes.ok) {
    throw new Error(`Could not update Postman environment ${environmentId} (${putRes.status} ${putRes.statusText}).`);
  }
}

/** Accepts a list of candidate names, first match wins — teams don't all follow the same naming
 * convention. Confirmed for real: this platform's own docs suggest "staging"/"prod", but the
 * reference repo this was generalized from (and at least one real team's actual workspace) uses
 * "Development"/"Production" instead. Match on either `name` or `label`, case-insensitively. */
export function findSystemEnvironmentByName(
  environments: SystemEnvironment[],
  candidateNames: string[],
): SystemEnvironment | undefined {
  for (const name of candidateNames) {
    const lower = name.toLowerCase();
    const match = environments.find((e) => e.name?.toLowerCase() === lower || e.label?.toLowerCase() === lower);
    if (match) return match;
  }
  return undefined;
}

export interface Monitor {
  id: string;
  name: string;
}

/** Used only for create-monitors.ts's idempotency check — skip creating a monitor whose exact
 * name already exists rather than creating a duplicate on a re-run. Not paginated: an SE's
 * workspace realistically has a handful of monitors at most, nowhere near needing cursor-based
 * paging the way the team-wide System Environment list does. */
export async function listMonitors(apiKey: string, workspaceId: string): Promise<Monitor[]> {
  const url = new URL(`${POSTMAN_API_BASE}/monitors`);
  url.searchParams.set('workspace', workspaceId);
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) {
    throw new Error(`Could not list Postman monitors (${res.status} ${res.statusText}).`);
  }
  const body = (await res.json()) as { monitors?: Monitor[] };
  return body.monitors ?? [];
}

/** Creates a scheduled collection run against an environment — see
 * https://learning.postman.com/api-docs/api-reference/monitors/create-monitor. Notifications and
 * distribution regions are deliberately left at Postman's defaults — out of scope for
 * create-monitors.ts; the SE can add those by editing the monitor afterward if they want them. */
export async function createMonitor(
  apiKey: string,
  params: { workspaceId: string; name: string; collectionId: string; environmentId: string; cron: string; timezone: string },
): Promise<Monitor> {
  const url = new URL(`${POSTMAN_API_BASE}/monitors`);
  url.searchParams.set('workspace', params.workspaceId);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      monitor: {
        name: params.name,
        collection: params.collectionId,
        environment: params.environmentId,
        schedule: { cron: params.cron, timezone: params.timezone },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Could not create Postman monitor "${params.name}" (${res.status} ${res.statusText}).`);
  }
  const body = (await res.json()) as { monitor: Monitor };
  return body.monitor;
}
