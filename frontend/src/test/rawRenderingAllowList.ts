// Raw-rendering offenders still on screen (render, never dump). The list may only shrink: the slice
// named in `retiredBy` replaces the raw block with a catalogue component and deletes the entry. Matching against the detector is by
// file plus trimmed line text; `line` is informative and a test keeps it correct.

export type RawRenderingLine = { line: number; text: string };

export type RawRenderingOffender = {
  /** Number in the list of raw-rendering offenders found at 912648c. */
  offender: number;
  /** Path under frontend/src. */
  file: string;
  lines: RawRenderingLine[];
  reason: string;
  retiredBy: 'M2.3' | 'M2.4' | 'M2.5' | 'M2.6';
};

/** A finding of the detector that the original list of offenders does not hold. Same shape; nobody has said yet which slice retires it. */
export type UnlistedFinding = Omit<RawRenderingOffender, 'retiredBy'> & { retiredBy: null };

/** Equals the number of entries of RAW_RENDERING_ALLOW_LIST; lower it as entries go. */
export const MAX_ALLOWED_OFFENDERS = 0;

export const UNLISTED_REASON = 'found by the detector, not in the original list of offenders';

export const RAW_RENDERING_ALLOW_LIST: RawRenderingOffender[] = [];

export const UNLISTED_FINDINGS: UnlistedFinding[] = [];
