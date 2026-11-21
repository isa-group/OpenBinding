// "Check now" (MEMBER): the version in effect against its sources at this moment, as the gateway reads them, writing nothing.
// SPHERE has no check; the rows follow the adoption history's. Each row is one sentence built from the names the gateway
// answered (the upstream plan's pricing and versions, the offering's), so no lab result is written into the screen. The
// report lives only in this component's state: nothing is stored, and nothing moves the environment or its feed.

import { formatDistanceToNow, parseISO } from 'date-fns';
import { useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import type { EnvironmentCheck } from '../../../core/api/types';
import { useEnvironmentsApi } from '../../api/environmentsApi';
import { checkRows, type CheckTone } from '../../utils/checkReport';

const TONE: Record<CheckTone, string> = {
  ok: 'bg-tp-severity-success-bg text-tp-severity-success',
  news: 'bg-tp-severity-warning-bg text-tp-severity-warning',
  muted: 'bg-tp-surface text-tp-steel',
};

interface Props {
  org: string;
  composition: string;
  environment: string;
  /** Something is adopted here: there is something to check. */
  adopted: boolean;
}

export default function CheckPanel({ org, composition, environment, adopted }: Props) {
  const api = useEnvironmentsApi();
  const [report, setReport] = useState<EnvironmentCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setReport(await api.checkEnvironment(org, composition, environment));
    } catch (caught) {
      const refusal = readApiError(caught);
      setError(
        refusal.code === 'nothing_adopted'
          ? 'Nothing is adopted here yet: there is nothing to check.'
          : `The check couldn’t be made${refusal.code ? ` (${refusal.code})` : ''}${refusal.message ? `: ${refusal.message}` : '.'}`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={`check-${environment}`}
      className="flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas px-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={`check-${environment}`} className="text-sm font-semibold text-tp-ink">
            Sources
          </h3>
          <p className="text-xs text-tp-steel">
            Whether the pricings the version in effect was read from have moved since.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !adopted}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-default disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
        {report && (
          <div className="flex flex-col gap-2">
            <ul
              aria-label="Check report"
              className="divide-y divide-tp-hairline rounded-lg border border-tp-hairline"
            >
              {checkRows(report).map(row => (
                <li
                  key={row.key}
                  className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3"
                >
                  <span className="w-32 shrink-0 text-xs font-medium text-tp-steel">
                    {row.label}
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-tp-ink">{row.text}</span>
                  <span
                    className={`self-start rounded-full px-2 py-0.5 text-[10px] font-semibold ${TONE[row.tone]}`}
                  >
                    {row.status}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-tp-steel">
              {`Checked version ${report.version.label} ${formatDistanceToNow(parseISO(report.checkedAt))} ago. `}
              Nothing was changed. OpenBinding also watches these pricings every few minutes; changes appear under
              Upstream changes.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
