import type { EngineRegistrationReport, EngineReport } from '../../api/client';
import { formatDateTime } from '../../utils/format';
import { Badge } from '../ui/Badge';
import { CopyField } from '../ui/CopyField';
import { DataTable } from '../ui/DataTable';
import './EngineReportView.css';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type CheckStatus = 'passed' | 'failed' | 'pending';

interface ConformanceCheck {
  id: string;
  status: CheckStatus;
  /** The status word the gateway used, shown as written. */
  word: string;
  message: string | null;
}

const PASSED = new Set(['passed', 'pass', 'ok', 'verified', 'success', 'succeeded']);
const FAILED = new Set(['failed', 'fail', 'error', 'rejected', 'refused']);

/** One entry of `report.checks`, whatever fields the gateway chose to fill. */
function conformanceChecks(report: Record<string, unknown> | null): ConformanceCheck[] {
  if (!report || !Array.isArray(report.checks)) return [];
  return report.checks.map((check, index) => {
    const entry: Record<string, unknown> = isRecord(check) ? check : {};
    const word = typeof entry.status === 'string' ? entry.status : typeof entry.result === 'string' ? entry.result : 'pending';
    const id = [entry.id, entry.name, entry.check].find((value): value is string => typeof value === 'string' && value !== '') ?? `check ${index + 1}`;
    const message = [entry.message, entry.detail, entry.error].find((value): value is string => typeof value === 'string' && value !== '') ?? null;
    return { id, word, message, status: PASSED.has(word.toLowerCase()) ? 'passed' : FAILED.has(word.toLowerCase()) ? 'failed' : 'pending' };
  });
}

const VERDICT: Record<string, { label: string; variant: 'success' | 'error' | 'warning' }> = {
  verified: { label: 'Conformance passed', variant: 'success' },
  failed: { label: 'Conformance failed', variant: 'error' },
  pending: { label: 'Conformance pending', variant: 'warning' },
};

/**
 * What the gateway found when it checked one engine deployment against the bim-engine/v1 protocol: the verdict, the
 * protocol and OpenAPI digests it pinned, and each check with its own outcome. Shown as a table rather than as the
 * report's JSON; the report object is not echoed.
 */
export function RegistrationReportView({ registration }: { registration: EngineRegistrationReport }) {
  const report = registration.report;
  const checks = conformanceChecks(report);
  const statusWord = typeof report?.status === 'string' ? report.status : null;
  const verdict = statusWord ? VERDICT[statusWord] ?? { label: `Conformance ${statusWord}`, variant: 'warning' as const } : null;
  const protocolDigest = typeof report?.protocolDigest === 'string' ? report.protocolDigest : null;
  const verifiedAt = formatDateTime(typeof report?.verifiedAt === 'string' ? report.verifiedAt : null);
  const duration = typeof report?.durationMs === 'number' ? `${Math.round(report.durationMs).toLocaleString('en-US')} ms` : null;

  if (!report) {
    return (
      <div className="registration-report">
        <p className="divergence-note">The gateway has not recorded a conformance report for this registration yet.</p>
        {registration.openapiDigest && <ReportDigest label="OpenAPI document digest" value={registration.openapiDigest} />}
      </div>
    );
  }

  return (
    <div className="registration-report">
      <div className="divergence-summary">
        {verdict && <Badge variant={verdict.variant}>{verdict.label}</Badge>}
        <span className="compared">
          {checks.length} check{checks.length === 1 ? '' : 's'}
          {duration ? ` · ${duration}` : ''}
          {verifiedAt ? ` · verified ${verifiedAt}` : ''}
        </span>
      </div>
      <div className="registration-report-digests">
        {protocolDigest && <ReportDigest label={`Protocol ${typeof report.protocol === 'string' ? report.protocol : 'digest'}`} value={protocolDigest} />}
        {registration.openapiDigest && <ReportDigest label="OpenAPI document digest" value={registration.openapiDigest} />}
      </div>
      {checks.length > 0 ? (
        <DataTable label="Conformance checks" minWidth={520}>
          <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">What the gateway said</th></tr></thead>
          <tbody>
            {checks.map((check, index) => (
              <tr key={`${check.id}-${index}`}>
                <td className="is-mono">{check.id}</td>
                <td><Badge variant={check.status === 'passed' ? 'success' : check.status === 'failed' ? 'error' : 'warning'}>{check.word}</Badge></td>
                <td>{check.message ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="divergence-note">The report lists no individual checks.</p>
      )}
    </div>
  );
}

function ReportDigest({ label, value }: { label: string; value: string }) {
  return (
    <div className="registration-report-digest">
      <span>{label}</span>
      <CopyField value={value} label={label.toLowerCase()} truncate />
    </div>
  );
}

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
