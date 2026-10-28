// Raw-rendering offenders still on screen (constitution Article 15, ADR 0014: render, never dump). The list may only shrink: the slice
// named in `retiredBy` replaces the raw block with a catalogue component and deletes the entry. Matching against the detector is by
// file plus trimmed line text; `line` is informative and a test keeps it correct.

export type RawRenderingLine = { line: number; text: string };

export type RawRenderingOffender = {
  /** Number in ROADMAP.md, "Raw-rendering offenders at 912648c". */
  offender: number;
  /** Path under frontend/src. */
  file: string;
  lines: RawRenderingLine[];
  reason: string;
  retiredBy: 'M2.3' | 'M2.4' | 'M2.5' | 'M2.6';
};

/** A finding of the detector that ROADMAP M2 does not list. Same shape; nobody has said yet which slice retires it. */
export type UnlistedFinding = Omit<RawRenderingOffender, 'retiredBy'> & { retiredBy: null };

/** Equals the number of entries of RAW_RENDERING_ALLOW_LIST; lower it as entries go. */
// [impl->req~frontend-retire-allow-list-leaves~1]
// [impl->req~frontend-retire-reports-allow-list~1]
// [impl->req~frontend-retire-library-allow-list~1]
// [impl->req~frontend-m25-leave-allow-list~1]
export const MAX_ALLOWED_OFFENDERS = 1;
// [impl->req~frontend-rendering-run-result-allow-list~1]

export const UNLISTED_REASON = 'found by the detector, not in ROADMAP M2; to be decided by the owner/coordinator';

export const RAW_RENDERING_ALLOW_LIST: RawRenderingOffender[] = [
  {
    offender: 6,
    file: 'pages/Reports/Verifier.tsx',
    lines: [{ line: 178, text: '<pre aria-label="Normalised document">{verdict.canonical_json}</pre>' }],
    reason: 'Canonical JSON shown as the verification result.',
    retiredBy: 'M2.6',
  },
];

export const UNLISTED_FINDINGS: UnlistedFinding[] = [
  {
    offender: 16,
    file: 'pages/Workbench/SourcePanel.tsx',
    lines: [{ line: 108, text: '<pre className="wb-diff" aria-label={`Changes to ${path}`}>' }],
    reason: UNLISTED_REASON,
    retiredBy: null,
  },
];
