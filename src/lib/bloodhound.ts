import type { Host } from '../types';

/**
 * BloodHound Community Edition deep-linking.
 *
 * We don't ingest BloodHound data (yet) — this just opens a running BHCE web UI
 * focused on the host you're looking at. The URL is a user-editable template so
 * it can be adjusted to whatever Explore-search format your BHCE version expects;
 * `{q}` is replaced with the host's (URL-encoded) BloodHound name.
 */

export const DEFAULT_BLOODHOUND_URL = 'http://127.0.0.1:8080/ui/explore?primarySearch={q}&searchType=node';

/** The previous default, kept only so we can migrate anyone still carrying it. */
export const LEGACY_BLOODHOUND_URL =
  'http://localhost:8080/ui/explore?searchType=node&exploreSearchTab=node&primarySearch={q}';

/** BloodHound names computers by their uppercased FQDN, e.g. DC01.CORP.LAN. */
export function bloodhoundName(host: Host): string {
  return (host.hostnames[0] ?? host.ip).toUpperCase();
}

/** Fill the `{q}` placeholder in the template with a URL-encoded query. */
export function bloodhoundUrlFor(template: string, query: string): string {
  const t = (template || DEFAULT_BLOODHOUND_URL).trim();
  const encoded = encodeURIComponent(query);
  if (t.includes('{q}')) return t.split('{q}').join(encoded);
  // No placeholder — append the query as a primarySearch param as a convenience.
  const sep = t.includes('?') ? '&' : '?';
  return `${t}${sep}primarySearch=${encoded}`;
}

/**
 * Deep-link for a host. BHCE's `primarySearch` resolves nodes by object ID, not
 * by name, so:
 *  - with a known object ID (SID/GUID from the note's `bloodhound_id`) we use the
 *    template's exact node link — identical to BHCE's own URLs;
 *  - without one, a name in `primarySearch` selects nothing, so we fall back to a
 *    Cypher deep-link that matches the node by name (which BHCE will render).
 */
export function bloodhoundHostUrl(template: string, host: Host, objectId?: string): string {
  const id = objectId?.trim();
  if (id) return bloodhoundUrlFor(template, id);
  return bloodhoundCypherUrl(template, bloodhoundName(host));
}

/** Build a BHCE Explore Cypher deep-link that matches a node by (case-insensitive) name. */
export function bloodhoundCypherUrl(template: string, name: string): string {
  const safe = name.replace(/["\\]/g, '');
  const cypher = `MATCH (n:Base) WHERE toUpper(n.name) = "${safe}" RETURN n LIMIT 1`;
  // BHCE carries the Cypher query in the URL as base64 under `cypherSearch`.
  const encoded = encodeURIComponent(btoa(cypher));
  return `${bloodhoundOrigin(template)}/ui/explore?searchType=cypher&cypherSearch=${encoded}`;
}

/** Best-effort origin of the BHCE UI, for a plain "open BloodHound" launcher. */
export function bloodhoundOrigin(template: string): string {
  try {
    return new URL((template || DEFAULT_BLOODHOUND_URL).split('{q}').join('')).origin;
  } catch {
    return 'http://localhost:8080';
  }
}
