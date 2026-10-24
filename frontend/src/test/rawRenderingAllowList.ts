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

/** A reviewer lowers this number as entries go. */
export const MAX_ALLOWED_OFFENDERS = 15;

export const UNLISTED_REASON = 'found by the detector, not in ROADMAP M2; to be decided by the owner/coordinator';

export const RAW_RENDERING_ALLOW_LIST: RawRenderingOffender[] = [
  {
    offender: 1,
    file: 'components/EngineReportView/EngineReportView.tsx',
    lines: [
      { line: 182, text: '<pre className="engine-claimed">{JSON.stringify(report.solutions, null, 2)}</pre>' },
      { line: 187, text: '<pre className="engine-claimed">{JSON.stringify(report.provenance, null, 2)}</pre>' },
      { line: 198, text: '<pre className="engine-claimed">{JSON.stringify(report.raw, null, 2)}</pre>' },
    ],
    reason: 'Solutions, provenance and raw report dumped in <pre>.',
    retiredBy: 'M2.3',
  },
  {
    offender: 2,
    file: 'pages/Jobs/JobResult.tsx',
    lines: [
      { line: 31, text: '<pre aria-label={label}>{JSON.stringify(value, null, 2)}</pre>' },
      { line: 286, text: '<pre aria-label="Engine log">{result.logs}</pre>' },
    ],
    reason: 'Generic JSON block and the engine log in <pre>.',
    retiredBy: 'M2.3',
  },
  {
    offender: 3,
    file: 'pages/Workbench/RunPanel.tsx',
    lines: [
      { line: 28, text: '<pre>{JSON.stringify(decision, null, 2)}</pre>' },
      {
        line: 54,
        text: '<pre>{JSON.stringify({ metrics: solution.metrics, objectives: solution.objectives, penalties: solution.penalties, violations: solution.violations, evaluation: solution.evaluation }, null, 2)}</pre>',
      },
    ],
    reason: 'Decision and solution JSON in <pre>.',
    retiredBy: 'M2.3',
  },
  {
    offender: 4,
    file: 'pages/Workbench/CheckResult.tsx',
    lines: [
      { line: 58, text: "<code>{item.code || 'diagnostic'}</code> {item.message || item.detail || JSON.stringify(item)}" },
    ],
    reason: 'A diagnostic item is stringified as the fallback text.',
    retiredBy: 'M2.3',
  },
  {
    offender: 5,
    file: 'pages/Reports/RepDetail.tsx',
    lines: [
      { line: 326, text: '<pre aria-label="Report document (JSON)">{JSON.stringify(report.document, null, 2)}</pre>' },
    ],
    reason: 'Whole report as JSON in <pre>. ROADMAP also lists :77 and :329, which the detector does not flag: `sourceText` (:77) is shown in the textarea at :317 through a variable the detector does not see, and :329 is a copy handler. Both go with the screen in M2.4.',
    retiredBy: 'M2.4',
  },
  {
    offender: 6,
    file: 'pages/Reports/Verifier.tsx',
    lines: [{ line: 178, text: '<pre aria-label="Normalised document">{verdict.canonical_json}</pre>' }],
    reason: 'Canonical JSON shown as the verification result.',
    retiredBy: 'M2.6',
  },
  {
    offender: 7,
    file: 'pages/Analysis/Inspector.tsx',
    lines: [
      {
        line: 79,
        text: "<dd>{typeof ref?.resource === 'string' && typeof ref?.id === 'string' ? <>{ref.id} <small>{ref.resource}</small></> : JSON.stringify(ref)}</dd>",
      },
      { line: 141, text: '<pre aria-label="Constraints and raw metrics">{JSON.stringify(loaded.evaluation, null, 2)}</pre>' },
    ],
    reason: 'Reference stringified as fallback; raw metrics and constraints in <pre>.',
    retiredBy: 'M2.4',
  },
  {
    offender: 8,
    file: 'pages/Studies/StudyCell.tsx',
    lines: [
      {
        line: 296,
        text: '<pre aria-label="Cell metrics source">{JSON.stringify({ state: cell.state, job_id: cell.job_id, engine: cell.engine_ref, parameters: cell.parameters, seed: cell.seed, metrics: cell.metrics }, null, 2)}</pre>',
      },
    ],
    reason: 'Cell metrics source in <pre>.',
    retiredBy: 'M2.5',
  },
  {
    offender: 9,
    file: 'pages/Studies/StudyDetail.tsx',
    lines: [{ line: 277, text: '<pre aria-label="Study definition source">{JSON.stringify(study.definition, null, 2)}</pre>' }],
    reason: 'Study definition source in <pre>.',
    retiredBy: 'M2.5',
  },
  {
    offender: 10,
    file: 'pages/Engines/EngineParts.tsx',
    lines: [{ line: 47, text: '<pre tabIndex={0} aria-label={`${label} (JSON)`}><code>{source}</code></pre>' }],
    reason: 'Manifest JSON in <pre> (the text is built at :43).',
    retiredBy: 'M2.5',
  },
  {
    offender: 11,
    file: 'pages/Library/ContentView.tsx',
    lines: [{ line: 196, text: '<pre tabIndex={0} aria-label="Source of the content">{sourceOf(content)}</pre>' }],
    reason: 'Content source as the main view.',
    retiredBy: 'M2.4',
  },
  {
    offender: 12,
    file: 'pages/Organization/OrgAudit.tsx',
    lines: [{ line: 88, text: "<dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>" }],
    reason: 'Audit values stringified.',
    retiredBy: 'M2.5',
  },
  {
    offender: 13,
    file: 'pages/RegisterEngine/EngineForm.tsx',
    lines: [{ line: 179, text: '<code>{JSON.stringify(option.rest)}</code>' }],
    reason: 'Option schema stringified.',
    retiredBy: 'M2.5',
  },
  {
    offender: 14,
    file: 'pages/Generator/LabAside.tsx',
    lines: [{ line: 25, text: '<pre>{text[shown]}</pre>' }],
    reason: 'Generated text in <pre>.',
    retiredBy: 'M2.5',
  },
  {
    offender: 15,
    file: 'pages/Cases/SnapshotDetail.tsx',
    lines: [
      {
        line: 94,
        text: '<CodeEditor value={JSON.stringify(snapshot.ir.document, null, 2)} onChange={() => {}} readOnly language="json" minHeight="220px" maxHeight="480px" ariaLabel="Compiled form (JSON)" />',
      },
    ],
    reason: 'Compiled form as the main view (moves to the Source tab).',
    retiredBy: 'M2.5',
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
  {
    offender: 17,
    file: 'pages/Analysis/SavedDecision.tsx',
    lines: [
      {
        line: 34,
        text: "<div key={task}><dt>{task}</dt><dd>{typeof ref?.resource === 'string' && typeof ref?.id === 'string' ? ref.id : JSON.stringify(ref)}</dd></div>",
      },
    ],
    reason: UNLISTED_REASON,
    retiredBy: null,
  },
];
