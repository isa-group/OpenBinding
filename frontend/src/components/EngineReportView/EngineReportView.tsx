import type { EngineReport } from '../../api/client';
import { Badge } from '../ui/Badge';
import './EngineReportView.css';

/**
 * What the engine said, next to what the reference evaluator worked out.
 *
 * Every metric a solution carries is recomputed here - that is what makes four
 * engines' answers comparable at all - and until now the engine's own version
 * was simply overwritten. This shows it, and shows where the two differ.
 *
 * The framing matters: agreement is the ordinary case and is reported in one
 * line, while a disagreement is spelled out. An engine whose termination
 * disagrees with the reference has a bug in its result handling, and that
 * sentence is worth more to whoever is building it than a table of numbers.
 */
export function EngineReportView({ report }: { report?: EngineReport | null }) {
  if (!report) {
    return (
      <div className="result-view engine-report-empty">
        <p>
          The engine's own answer was not requested. Turn on <strong>Engine report</strong>{' '}
          beside the solver options and solve again to see what it reported before the
          reference evaluator recomputed it.
        </p>
      </div>
    );
  }

  const { divergence } = report;

  return (
    <div className="result-view engine-report">
      <div className="divergence-summary">
        <Badge variant={divergence.agrees ? 'success' : 'warning'}>
          {divergence.agrees ? 'Agrees with the reference' : 'Disagrees with the reference'}
        </Badge>
        <span className="compared">
          {divergence.solutions_compared} solution
          {divergence.solutions_compared === 1 ? '' : 's'} compared
        </span>
      </div>

      {divergence.agrees ? (
        <p className="divergence-note">
          Everything this engine reported matches what the reference evaluator derived from
          the same binding. The canonical result is still the official one - it always is -
          but nothing was overwritten with a different value.
        </p>
      ) : (
        <>
          <p className="divergence-note">
            The canonical result above is the official answer. These are the places where
            this engine's own account of it differs, which is usually the fastest way to
            find a bug in a solver.
          </p>
          <ul className="divergence-notes">
            {divergence.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
          {divergence.termination_mismatches > 0 && (
            <p className="divergence-hint">
              A termination the reference evaluator rejects points at result-contract or
              constraint handling rather than at search quality.
            </p>
          )}
          {divergence.max_objective_delta != null && (
            <p className="divergence-hint">
              Largest objective gap: <code>{divergence.max_objective_delta}</code>. If the
              instance declares normalization, check that it is applied.
            </p>
          )}
        </>
      )}

      <h4>What the engine reported</h4>
      <pre className="engine-claimed">{JSON.stringify(report.solutions, null, 2)}</pre>

      {report.provenance && (
        <>
          <h4>Its provenance</h4>
          <pre className="engine-claimed">{JSON.stringify(report.provenance, null, 2)}</pre>
        </>
      )}

      <h4>Untransformed response</h4>
      {report.raw_truncated ? (
        <p className="divergence-note">
          Too large to return. This is capped because a solve accepts payloads far larger
          than anything worth putting in a response.
        </p>
      ) : (
        <pre className="engine-claimed">{JSON.stringify(report.raw, null, 2)}</pre>
      )}
    </div>
  );
}
