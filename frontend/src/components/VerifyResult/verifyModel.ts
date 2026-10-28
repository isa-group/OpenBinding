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
  /** What the copy button copies, for its accessible name: `computed fingerprint` → "Copy computed fingerprint". */
  copyLabel: string;
  /** `null` when this side shows no digest: nothing is recorded, or it matches the other side. */
  value: string | null;
  /** Shown instead of a digest when `value` is `null`. */
  note?: string;
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
): Side[] {
  const expected = status === 'mismatch';
  const right: Side = expected
    ? { label: 'Fingerprint you expected', copyLabel: 'expected fingerprint', value: digest }
    : recorded
      ? { label: 'Recorded by OpenBinding', copyLabel: 'recorded fingerprint', value: digest }
      : { label: 'Recorded by OpenBinding', copyLabel: 'recorded fingerprint', value: null, note: 'nothing recorded' };
  const left: Side | null = computed
    ? { label: 'Computed in your browser', copyLabel: 'computed fingerprint', value: computed }
    : given
      ? { label: 'Fingerprint you gave', copyLabel: 'fingerprint you gave', value: given }
      : null;
  if (!left) return [right];
  // One copyable value: when both sides hold the same digest, only the recorded/expected side shows it.
  if (right.value !== null && left.value === right.value) {
    return [{ ...left, value: null, note: expected ? 'Matches the expected fingerprint' : 'Matches the recorded fingerprint' }, right];
  }
  return [left, right];
}

/** The browser and the server fingerprinted the same input differently (a mismatch is a different situation). */
export function disagrees(status: VerifierStatus, digest: string, computed: string | null | undefined): boolean {
  return !!computed && status !== 'mismatch' && computed !== digest;
}
