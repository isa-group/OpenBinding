import { apiClient, errorFromResponse } from '../../api/http';

/**
 * The bytes of a pricing snapshot (`GET …/pricing-snapshots/{snapshot}/yaml`), the YAML pricing-renderer draws. A snapshot is
 * immutable and content-addressed, so one read per address serves every screen of the session (the browser revalidates by
 * `ETag` across sessions); a failed read is forgotten, so the next asks again. The gateway answers it to whoever may read the
 * organization, and only what it stored: nothing here reaches SPHERE.
 */
const reads = new Map<string, Promise<string>>();

/** The snapshot at `href` (a `yamlHref` or `/v1/organizations/{org}/pricing-snapshots/{id}/yaml`), as text. */
export function snapshotYaml(href: string): Promise<string> {
  const known = reads.get(href);
  if (known) return known;
  const read = (async () => {
    const response = await apiClient.fetchWithInterceptor(href, {
      headers: { Accept: 'application/yaml' },
    });
    if (!response.ok) throw await errorFromResponse(response);
    return response.text();
  })();
  reads.set(href, read);
  read.catch(() => reads.delete(href));
  return read;
}

/** The address of a snapshot's bytes in an organization. */
export const snapshotYamlHref = (org: string, snapshot: string): string =>
  `/v1/organizations/${encodeURIComponent(org)}/pricing-snapshots/${encodeURIComponent(snapshot)}/yaml`;

/** Forget every read (tests). */
export function forgetSnapshotReads(): void {
  reads.clear();
}
