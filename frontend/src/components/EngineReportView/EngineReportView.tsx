import type { EngineRegistrationReport } from '../../api/client';
import { formatDateTime } from '../../utils/format';
import { Badge } from '../ui/Badge';
import { CopyField } from '../ui/CopyField';
import { DataTable } from '../ui/DataTable';
import './EngineReportView.css';

// [impl->req~frontend-rendering-engine-report-view-retired~1]
// The engine's own answer view (solutions, provenance and raw response dumped in <pre>) is retired; only the registration report remains.

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
