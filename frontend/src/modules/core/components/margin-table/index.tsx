// The margin per plan of a composition version, as the gateway computed it (`GET …/versions/{version}/margins`, or `margins`
// of an evaluation): one row per offering plan alone and with each single add-on, on OpenBinding's data table. SPHERE has no
// margins; the table is SPHERE's list card through `DataTable`. Every amount is the gateway's string, shown to two places by
// rounding its text, with the full value in a title; nothing is summed, subtracted or apportioned here. Every status the
// gateway can answer is said in words, and a negative margin carries a minus sign and the word "loss" as well as the tone.

import { useId } from 'react';
import type { CompositionMargins, MarginRow } from '../../api/types';
import { DataTable } from '../data-table';
import { ValueBadge } from '../value-badge/ValueBadge';
import { isNegative, twoPlaces } from './money';
import { marginsStatusText } from './statusText';

interface Props {
  /** The gateway's answer; null while it has not come. */
  margins: CompositionMargins | null;
  /** The users field: what it shows and how it changes (every role may change it; nothing is saved from it). */
  users?: { value: string; onChange: (value: string) => void };
  loading?: boolean;
  /** Why the margins could not be read, in words. */
  error?: string | null;
}

/** The caption: what the rows were computed from. */
function basisText(margins: CompositionMargins): string {
  const parts: string[] = [];
  const offering = margins.offering;
  if (offering?.versionName) {
    const source = offering.source ? Object.values(offering.source)[0] : null;
    parts.push(
      `Offering ${source ? `${source} ` : ''}${offering.versionName}, read when ${margins.version.label} was evaluated`
    );
  } else parts.push(`Version ${margins.version.label}`);
  if (margins.users !== null) parts.push(`${margins.users.toLocaleString('en')} users`);
  if (margins.cost?.monthly)
    parts.push(
      `upstream cost ${twoPlaces(margins.cost.monthly)} ${margins.currency ?? ''} a month`.trim()
    );
  parts.push('shared uniformly per user');
  return parts.join(' · ');
}

function Amount({
  value,
  currency,
  row,
  signed = false,
}: {
  value: string | null;
  currency: string | null;
  row: MarginRow;
  signed?: boolean;
}) {
  if (row.requiresQuote) return <span className="text-tp-steel">Quote</span>;
  if (row.outOfRange && value === null) return <span className="text-tp-steel">Too large</span>;
  if (value === null) return <span className="text-tp-steel">—</span>;
  const loss = signed && isNegative(value);
  return (
    <span
      title={`${value} ${currency ?? ''}`.trim()}
      className={`font-mono tabular-nums ${loss ? 'font-semibold text-tp-error-strong' : ''}`}
    >
      {twoPlaces(value)}
      {loss && <span className="ml-1 font-sans text-[10px] font-medium uppercase">loss</span>}
    </span>
  );
}

export function MarginTable({ margins, users, loading = false, error = null }: Props) {
  const usersId = useId();
  const status = margins ? marginsStatusText(margins) : null;
  const currency = margins?.currency ?? null;
  const declared = margins?.warnings.includes('declared_values') ?? false;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-tp-ink">Margin per plan</h3>
          <p className="text-xs text-tp-steel">
            Each plan’s revenue a month minus the upstream cost per user
            {currency ? `, in ${currency}` : ''}.
          </p>
        </div>
        {users && (
          <div className="flex flex-col gap-1">
            <label htmlFor={usersId} className="text-xs font-medium text-tp-ink">
              Users
            </label>
            <input
              id={usersId}
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000_000_000}
              value={users.value}
              onChange={event => users.onChange(event.target.value)}
              className="h-9 w-36 rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink outline-none focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/20"
              aria-describedby={`${usersId}-note`}
            />
            <span id={`${usersId}-note`} className="text-[11px] text-tp-steel">
              Asks again; nothing is saved.
            </span>
          </div>
        )}
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
        {loading && !margins && (
          <p role="status" className="text-sm text-tp-steel">
            Computing the margins…
          </p>
        )}
        {status && (
          <p
            className="rounded-lg bg-tp-surface px-3 py-2 text-sm text-tp-slate"
            data-status={margins?.status}
          >
            {status}
          </p>
        )}
        {declared && (
          <p className="flex items-center gap-2 text-xs text-tp-steel">
            <ValueBadge status="declared" compact />
            The cost is the author’s declared value, not one the toolchain computed.
          </p>
        )}
        {margins?.rowsTruncated && (
          <p className="text-xs text-tp-steel">Only the first 200 plans and add-ons are shown.</p>
        )}
        {margins?.warnings.includes('amount_out_of_range') && (
          <p className="text-xs text-tp-steel">
            Some amounts are too large to compute; their rows say so.
          </p>
        )}
      </div>
      {margins && margins.rows.length > 0 && (
        <DataTable label="Margin per plan" minWidth={640} caption={basisText(margins)}>
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Add-on</th>
              <th scope="col">Basis</th>
              <th scope="col" className="text-right">
                Revenue
              </th>
              <th scope="col" className="text-right">
                Upstream cost
              </th>
              <th scope="col" className="text-right">
                Margin
              </th>
            </tr>
          </thead>
          <tbody>
            {margins.rows.map(row => (
              <tr key={`${row.plan}+${row.addOns.join('+')}`}>
                <td>
                  <span className="font-medium">{row.planName}</span>
                  {row.private && (
                    <span className="ml-2 rounded-full bg-tp-surface px-2 py-0.5 text-[10px] text-tp-steel">
                      private
                    </span>
                  )}
                  {row.excludedParts.length > 0 && (
                    <span className="block text-[11px] text-tp-steel">
                      Leaves out {row.excludedParts.join(', ')} (no monthly price)
                    </span>
                  )}
                </td>
                <td>{row.addOns.length ? row.addOns.join(', ') : '—'}</td>
                <td className="text-tp-steel">
                  {row.basis === 'seat' ? 'Per seat' : 'Per subscription'}
                </td>
                <td className="text-right">
                  <Amount value={row.revenue} currency={currency} row={row} />
                </td>
                <td className="text-right">
                  <Amount value={row.cost} currency={currency} row={row} />
                </td>
                <td className="text-right">
                  <Amount value={row.margin} currency={currency} row={row} signed />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
