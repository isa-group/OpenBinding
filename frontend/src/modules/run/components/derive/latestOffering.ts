// The offering a derived version keeps: a version derived into a composition whose latest version states an offering
// states the same one, so its margins and its offering's upstream changes go on. A failed read is not "no offering".

import { readApiError } from '../../../core/api/errors';
import { compositionsApi } from '../../../core/utils/composition/api';

/** The latest version's offering could not be read: a derivation would silently drop it, so it does not go ahead. */
export class OfferingUnreadable extends Error {
  readonly label: string;

  constructor(label: string, cause: unknown) {
    super(`The latest version ${label} couldn’t be read`, { cause });
    this.name = 'OfferingUnreadable';
    this.label = label;
  }
}

/** The offering version `latest` of `org/slug` states, or null when it states none; throws OfferingUnreadable on a failed read. */
export async function latestOffering(
  org: string,
  slug: string,
  latest: { id: string; label: string } | null | undefined
): Promise<Record<string, unknown> | null> {
  if (!latest) return null;
  let read;
  try {
    read = await compositionsApi.version(org, slug, latest.id, { document: true });
  } catch (caught) {
    throw new OfferingUnreadable(latest.label, caught);
  }
  return (read?.document as { offering?: Record<string, unknown> } | null)?.offering ?? null;
}

/** What to say when the latest version's offering could not be read. */
export function offeringUnreadableText(error: OfferingUnreadable): string {
  const read = readApiError(error.cause);
  const code = read.status
    ? ` (${read.status}${read.code !== 'unknown' ? ` · ${read.code}` : ''})`
    : '';
  return `The latest version ${error.label} couldn’t be read${code}, so its offering can’t be carried into the new version. Nothing was derived; try again.`;
}
