import type { UpstreamOffering, UpstreamView } from '../../api/types';
import { snapshotYaml, snapshotYamlHref } from '../sphere/snapshotYaml';
import { compositionsApi } from './api';

/**
 * What the composition renderer draws a version's upstream plans and its offering from: the gateway's upstream view (stored data
 * only) and the YAML of each stored snapshot it names, read once per address. A snapshot that cannot be read is left out, and
 * its card keeps the reference face. Nothing here reaches SPHERE.
 */
export interface RendererUpstream {
  view: UpstreamView;
  /** The YAML of each snapshot the view names, by snapshot id. */
  yaml: Readonly<Record<string, string>>;
}

/** The upstream view of a version and its snapshots' YAML. */
export async function loadUpstream(
  org: string,
  composition: string,
  version: string
): Promise<RendererUpstream> {
  const view = await compositionsApi.upstream(org, composition, version);
  const ids = new Set<string>();
  for (const entry of view.entries) if (entry.snapshot) ids.add(entry.snapshot.id);
  if (view.offering?.snapshot) ids.add(view.offering.snapshot.id);
  const read = await Promise.all(
    [...ids].map(async id => {
      try {
        return [id, await snapshotYaml(snapshotYamlHref(org, id))] as const;
      } catch {
        return null;
      }
    })
  );
  return {
    view,
    yaml: Object.fromEntries(
      read.filter((entry): entry is readonly [string, string] => entry !== null)
    ),
  };
}

/** The offering version the current evaluation read, or why it could not be read, in words. */
export function offeringReadText(
  offering: Pick<UpstreamOffering, 'status' | 'versionName'> | null | undefined
): string | null {
  if (!offering?.status) return null;
  if (offering.status === 'read')
    return offering.versionName
      ? `Offering version ${offering.versionName}, read when this version was evaluated.`
      : 'The offering was read when this version was evaluated.';
  if (offering.status === 'registry_unknown')
    return 'The offering names a SPHERE registry this installation does not know, so it was not read.';
  if (offering.status === 'invalid_pricing')
    return 'The offering was read when this version was evaluated, but it is not a pricing OpenBinding can read.';
  return 'The offering could not be read when this version was evaluated.';
}
