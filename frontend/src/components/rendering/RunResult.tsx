import type { ReactNode } from 'react';
import type { RunProblem, RunReport, RunResultData } from './runResultModel';
import './RunResult.css';

interface RunResultProps {
  result: RunResultData;
  /** undefined: not loaded yet; null: not available (no note is shown while loading). */
  problem?: RunProblem | null;
  /** The compiled document's spec.constraints, as qosBoundsOf reads them; [] when absent. */
  constraints?: unknown;
  report?: RunReport | null;
  /** Page content right after the summary. */
  notice?: ReactNode;
  /** Page content after the trade-off set, before the sources. */
  children?: ReactNode;
  label?: string;
}

/** Stub: the final implementation renders the whole run. */
export function RunResult({ label = 'Run result' }: RunResultProps) {
  return <section aria-label={label} className="rendering-run" />;
}
