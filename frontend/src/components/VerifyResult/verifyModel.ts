import type { VerifierEntity, VerifierStatus } from '../../api/platform';

export type VerdictTone = 'ok' | 'info' | 'bad' | 'plain';

export const VERDICTS: Record<VerifierStatus, { title: string; text: string; tone: VerdictTone }> = {
  verified: { title: 'Verified', text: 'The fingerprint is what OpenBinding recorded.', tone: 'ok' },
  computed: { title: 'Computed, not on record', text: 'We computed its fingerprint, but OpenBinding hasn’t recorded anything with it. That’s normal for drafts or local files.', tone: 'info' },
  mismatch: { title: 'Doesn’t match', text: 'The content you gave hashes differently from the fingerprint you expected. It was changed somewhere along the way.', tone: 'bad' },
  not_found: { title: 'Nothing found', text: 'OpenBinding has no element recorded with this fingerprint that you can see. Someone else’s private item reads exactly like one that was never registered, so this doesn’t say which it is.', tone: 'plain' },
};

export interface Side {
  label: string;
  /** `null` when nothing is recorded: there is no digest to show or copy. */
  value: string | null;
}

/** The reader's name for an element: never its identifier. */
export function entityName(entity: VerifierEntity): string {
  return entity.title_or_name?.trim() || entity.slug?.trim() || 'unnamed element';
}

export function kindLabelOf(entityType: string, labels?: Record<string, string>): string {
  return labels?.[entityType] ?? entityType.replace(/_/g, ' ');
}

export function sidesOf(
  status: VerifierStatus,
  digest: string,
  recorded: boolean,
  computed: string | null | undefined,
  given: string | null | undefined,
): { left: Side; right: Side } {
  const left: Side = computed
    ? { label: 'Computed in your browser', value: computed }
    : { label: 'Fingerprint you gave', value: given ?? digest };
  const right: Side = status === 'mismatch'
    ? { label: 'Fingerprint you expected', value: digest }
    : { label: 'Recorded by OpenBinding', value: recorded ? digest : null };
  return { left, right };
}

/** The browser and the server fingerprinted the same input differently (a mismatch is a different situation). */
export function disagrees(status: VerifierStatus, digest: string, computed: string | null | undefined): boolean {
  return !!computed && status !== 'mismatch' && computed !== digest;
}
