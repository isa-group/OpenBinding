import { Link } from 'react-router-dom';
import { record } from '../../analysis/model';
import './BindingAnalysis.css';

/** Every entry point opens the same authoritative archive workspace. */
export function BindingAnalysis({ result, jobId }: { result: unknown; jobId?: string }) {
  const solutions = record(result).solutions;
  const count = Array.isArray(solutions) ? solutions.length : 0;
  return <section className="binding-analysis" aria-label="Binding analysis">
    <header><div><h3>Binding decision workspace</h3>
      <p>{count.toLocaleString()} stored result{count === 1 ? '' : 's'} · recommendations, budgets, Pareto fronts, and explanations.</p></div>
      {jobId && <Link className="hash-badge" to={`/app/analysis?job=${encodeURIComponent(jobId)}`}>Open analysis</Link>}
    </header>
    {!jobId && <p>Persist a solver job to compare its canonical evidence. The raw result remains available here.</p>}
  </section>;
}
