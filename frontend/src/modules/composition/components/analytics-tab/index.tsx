// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-analytics-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's layout (a heading with the from/to DatePicker, a grid of chart cards, recharts lines 220 px high) over a
// composition's versions, with OpenBinding's rules (plan §13): verified, declared and unverified values are separate series,
// each drawn its own way and never joined; each value and unit has its own chart; the versions where the linked problem or
// its compilation changed are marked on the axis; the axis is by date or by version; each chart's data sits behind "Show
// data". No zero point is prepended: a value nobody stated would be drawn as if it were one.
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Action } from '../../../core/components/action-button';
import DatePicker from '../../../core/components/date-picker';
import { DataTable } from '../../../core/components/data-table';
import { FilterPills } from '../../../core/components/filter-pills';
import { Notice } from '../../../core/components/notice';
import { compositionsApi } from '../../../core/utils/composition/api';
import {
  evolutionModel,
  STRUCTURE_METRICS,
  type EvolutionModel,
  type StructureMetric,
  type ValueSeries,
} from '../../../core/utils/composition/evolution';
import { formatValue, type ValueStatus } from '../../../core/utils/composition/values';
import { classifyAuthError, marker as authMarker } from '../../../core/api/errors';
import type { CompositionVersionView } from '../../../core/api/types';
import { formatDate, formatNumber } from '../../../core/utils/format';
import { useResource } from '../../../core/hooks/useResource';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { VALUE_STATUS_TEXT } from '../../../core/components/value-badge/statusText';
import {
  dateBounds,
  formatDay,
  formatTick,
  hasStatus,
  markerShort,
  markerVersion,
  METRIC_TEXT,
  rangeInverted,
  readPreferences,
  STATUSES,
  structureRows,
  valueRows,
  writePreferences,
  type Axis,
  type Preferences,
  type RowBase,
  type StructureRow,
  type ValueRow,
} from './chartData';

interface EvolutionChartsProps {
  org: string;
  composition: string;
  /** Changes when the versions change (a seal, a re-evaluation), so the charts read them again. */
  refresh?: string;
}

const AXES: ReadonlyArray<{ id: Axis; label: string }> = [
  { id: 'time', label: 'By date' },
  { id: 'version', label: 'By version' },
];

/** Stroke colours: one per status (the legend and the line style say which), and the structure lines. */
const COLOR: Record<ValueStatus | 'structure', string> = {
  verified: 'var(--color-tp-chart-1)',
  declared: 'var(--color-tp-chart-2)',
  unverified: 'var(--color-tp-chart-3)',
  structure: 'var(--color-tp-chart-1)',
};

const TICK = { fontSize: 11, fill: 'var(--color-tp-slate)' };
const MARGIN = { top: 18, right: 12, bottom: 4, left: 0 };
const HEIGHT = 220;

interface DotArgs {
  cx?: number | null;
  cy?: number | null;
  index?: number;
  value?: unknown;
}

/** The mark of a status: a filled dot (verified), a hollow square (declared) or a hollow circle (unverified). */
function StatusMark({ status, x, y }: { status: ValueStatus; x: number; y: number }) {
  if (status === 'declared') {
    return (
      <rect
        className="ec-dot is-declared"
        x={x - 4}
        y={y - 4}
        width={8}
        height={8}
        fill="var(--color-tp-canvas)"
        stroke={COLOR.declared}
        strokeWidth={2}
      />
    );
  }
  if (status === 'unverified') {
    return (
      <circle
        className="ec-dot is-unverified"
        cx={x}
        cy={y}
        r={4.5}
        fill="var(--color-tp-canvas)"
        stroke={COLOR.unverified}
        strokeWidth={2}
      />
    );
  }
  return (
    <circle
      className="ec-dot is-verified"
      cx={x}
      cy={y}
      r={4}
      fill={COLOR.verified}
      stroke={COLOR.verified}
    />
  );
}

const dotOf = (status: ValueStatus) =>
  function StatusDot({ cx, cy, index, value }: DotArgs): ReactElement<SVGElement> {
    const key = `${status}-${index ?? 0}`;
    if (
      cx === null ||
      cx === undefined ||
      cy === null ||
      cy === undefined ||
      value === null ||
      value === undefined
    )
      return <g key={key} />;
    return (
      <g key={key}>
        <StatusMark status={status} x={cx} y={cy} />
      </g>
    );
  };

const STRUCTURE_DOT = { r: 3, fill: COLOR.structure, stroke: COLOR.structure };

/** The tooltip: the version, when it was sealed, and each number shown at that point with its unit and status. */
function Tip({
  active,
  payload,
  lines,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  lines: (row: never) => ReactNode[];
}) {
  const row = payload?.[0]?.payload as RowBase | undefined;
  if (!active || !row) return null;
  return (
    <div className="ec-tip flex flex-col gap-0.5 rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2 text-xs text-tp-ink shadow-elevation-2">
      <strong>{`Version ${row.label}`}</strong>
      <span className="text-tp-steel">{formatDate(row.sealed)}</span>
      {lines(row as never)}
    </div>
  );
}

interface PlotProps {
  model: EvolutionModel;
  axis: Axis;
  rows: readonly RowBase[];
  children: ReactNode;
  tip: (row: never) => ReactNode[];
  integers?: boolean;
}

/** One small chart: the axes, the change markers and the lines it is given. */
function Plot({ model, axis, rows, children, tip, integers = false }: PlotProps) {
  const key = axis === 'time' ? 't' : 'ordinal';
  const labels = new Map(model.points.map(point => [point.ordinal, point.label]));
  const last = rows.at(-1);
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <LineChart data={[...rows]} margin={MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tp-hairline-soft)" />
        <XAxis
          dataKey={key}
          type="number"
          scale={axis === 'time' ? 'time' : 'linear'}
          domain={['dataMin', 'dataMax']}
          ticks={axis === 'version' ? rows.map(row => row.ordinal) : undefined}
          tickFormatter={
            axis === 'time' ? formatDay : (ordinal: number) => labels.get(ordinal) ?? ''
          }
          allowDecimals={false}
          padding={{ left: 14, right: 14 }}
          tick={TICK}
          stroke="var(--color-tp-hairline)"
        />
        <YAxis
          tick={TICK}
          tickFormatter={formatTick}
          width={48}
          domain={['auto', 'auto']}
          allowDecimals={!integers}
          stroke="var(--color-tp-hairline)"
        />
        <Tooltip
          isAnimationActive={false}
          content={props => <Tip active={props.active} payload={props.payload} lines={tip} />}
        />
        {model.markers.map(marker => {
          const x = axis === 'time' ? marker.t : marker.ordinal;
          const right = last !== undefined && x >= (axis === 'time' ? last.t : last.ordinal);
          return (
            <ReferenceLine
              key={`${marker.kind}-${marker.ordinal}`}
              className={`ec-marker is-${marker.kind}`}
              x={x}
              stroke="var(--color-tp-slate)"
              strokeDasharray="2 3"
              ifOverflow="discard"
              label={{
                value: markerShort(model, marker),
                position: right ? 'insideTopRight' : 'insideTopLeft',
                fill: 'var(--color-tp-slate)',
                fontSize: 10,
                offset: 4,
              }}
            />
          );
        })}
        {children}
      </LineChart>
    </ResponsiveContainer>
  );
}

interface CardProps {
  title: string;
  summary: string;
  chart: ReactNode;
  table: ReactNode;
}

/** A chart with its title and a table that says the same, one or the other on screen. */
function ChartCard({ title, summary, chart, table }: CardProps) {
  const id = useId();
  const [asTable, setAsTable] = useState(false);
  return (
    <figure
      className="m-0 flex min-w-0 flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-4"
      aria-labelledby={id}
    >
      <figcaption className="flex items-center justify-between gap-2 text-[11px] text-tp-ink">
        <span className="font-medium" id={id}>
          {title}
        </span>
        <button
          type="button"
          className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium text-tp-accent hover:bg-tp-surface"
          aria-expanded={asTable}
          onClick={() => setAsTable(current => !current)}
        >
          {asTable ? 'Show chart' : 'Show data'}
        </button>
      </figcaption>
      {asTable ? (
        table
      ) : (
        <div role="img" aria-label={summary}>
          {chart}
        </div>
      )}
    </figure>
  );
}

const sealedCell = (row: RowBase) => <time dateTime={row.sealed}>{formatDate(row.sealed)}</time>;

function StructureChart({
  model,
  metric,
  axis,
}: {
  model: EvolutionModel;
  metric: StructureMetric;
  axis: Axis;
}) {
  const rows = structureRows(model, metric);
  const title = METRIC_TEXT[metric];
  return (
    <ChartCard
      title={title}
      summary={`${title} per version, ${rows.length} ${rows.length === 1 ? 'version' : 'versions'} by ${axis === 'time' ? 'date' : 'version'}. The table view lists each count.`}
      chart={
        <Plot
          model={model}
          axis={axis}
          rows={rows}
          integers
          tip={(row: StructureRow) => [
            <span key="v">{row.value === null ? 'Not recorded' : formatNumber(row.value)}</span>,
          ]}
        >
          <Line
            type="stepAfter"
            dataKey="value"
            name={title}
            stroke={COLOR.structure}
            strokeWidth={2}
            dot={STRUCTURE_DOT}
            connectNulls={false}
            isAnimationActive={false}
          />
        </Plot>
      }
      table={
        <DataTable label={`${title} by version`} minWidth={0}>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Sealed</th>
              <th scope="col">{title}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.ordinal}>
                <th scope="row">
                  <code>{row.label}</code>
                </th>
                <td>{sealedCell(row)}</td>
                <td>
                  {row.value === null ? (
                    <span className="text-tp-steel">Not recorded</span>
                  ) : (
                    formatNumber(row.value)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      }
    />
  );
}

/** A value's unit as its chart names it; `"1"` is a bare number. */
const unitTitle = (series: ValueSeries) =>
  series.unit === '1' || series.unit === ''
    ? `${series.name} · number`
    : `${series.name} · ${series.unit}`;

function ValueChart({
  model,
  series,
  axis,
  hidden,
}: {
  model: EvolutionModel;
  series: ValueSeries;
  axis: Axis;
  hidden: readonly ValueStatus[];
}) {
  const rows = valueRows(model, series);
  const title = unitTitle(series);
  const drawn = STATUSES.filter(status => !hidden.includes(status) && hasStatus(rows, status));
  const statusOf = (row: ValueRow) => STATUSES.find(status => row[status] !== null) ?? null;
  const counted = rows.filter(row => statusOf(row) !== null).length;
  return (
    <ChartCard
      title={title}
      summary={`${title}: ${counted} of ${rows.length} versions give it, ${STATUSES.filter(status =>
        hasStatus(rows, status)
      )
        .map(status => VALUE_STATUS_TEXT[status].toLowerCase())
        .join(', ')}. The table view lists each value.`}
      chart={
        <Plot
          model={model}
          axis={axis}
          rows={rows}
          tip={(row: ValueRow) =>
            STATUSES.flatMap(status => {
              const value = row[status];
              return value === null
                ? []
                : [
                    <span
                      key={status}
                    >{`${formatValue(value, series.unit)} · ${VALUE_STATUS_TEXT[status]}`}</span>,
                  ];
            })
          }
        >
          {drawn.map(status => (
            <Line
              key={status}
              className={`ec-line is-${status}`}
              type="linear"
              dataKey={status}
              name={VALUE_STATUS_TEXT[status]}
              stroke={status === 'unverified' ? 'none' : COLOR[status]}
              strokeWidth={status === 'unverified' ? 0 : 2}
              strokeDasharray={status === 'declared' ? '6 4' : undefined}
              dot={dotOf(status)}
              activeDot={{ r: 5, fill: COLOR[status], stroke: 'var(--color-tp-canvas)' }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </Plot>
      }
      table={
        <DataTable label={`${title} by version`} minWidth={0}>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Sealed</th>
              <th scope="col">Value</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const status = statusOf(row);
              const value = status ? row[status] : null;
              return (
                <tr key={row.ordinal}>
                  <th scope="row">
                    <code>{row.label}</code>
                  </th>
                  <td>{sealedCell(row)}</td>
                  <td>
                    {value === null ? (
                      <span className="text-tp-steel">No value in this unit</span>
                    ) : (
                      formatValue(value, series.unit)
                    )}
                  </td>
                  <td>
                    {status ? (
                      <ValueBadge status={status} />
                    ) : (
                      <span className="text-tp-steel">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      }
    />
  );
}

/** The legend swatch of a status: its line style and its mark, drawn as the charts draw them. */
function Swatch({ status }: { status: ValueStatus }) {
  return (
    <svg className="shrink-0" width="28" height="12" viewBox="0 0 28 12" aria-hidden="true">
      {status !== 'unverified' && (
        <line
          x1="1"
          y1="6"
          x2="27"
          y2="6"
          stroke={COLOR[status]}
          strokeWidth="2"
          strokeDasharray={status === 'declared' ? '5 3' : undefined}
        />
      )}
      <StatusMark status={status} x={14} y={6} />
    </svg>
  );
}

const OFFERING_TEXT = {
  yes: 'Offering named',
  no: 'No offering',
  unknown: 'Not recorded',
} as const;

/**
 * How a composition evolved: its structure (the counts each version stored at seal) and each global value (as each version's
 * evaluation gave it), version by version, by date or by version. Verified, declared and unverified values are separate series,
 * each value and unit has its own chart, and the versions where the linked problem or its compilation changed are marked. Every
 * chart has a table that says the same.
 */
export default function CompositionAnalyticsTab({
  org,
  composition,
  refresh = '',
}: EvolutionChartsProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const inverted = rangeInverted(from, to);
  const bounds = dateBounds(from, to);

  const versions = useResource<CompositionVersionView[]>(
    `composition-evolution:${org}/${composition}:${bounds.createdAfter ?? ''}..${bounds.createdBefore ?? ''}:${inverted ? 'inverted' : 'ok'}:${refresh}`,
    async () =>
      inverted
        ? []
        : compositionsApi.allVersions(org, composition, {
            include: ['analytics'],
            order: 'oldest',
            ...bounds,
          })
  );

  const choose = (next: Preferences) => {
    setPreferences(next);
    writePreferences(next);
  };
  const toggle = (status: ValueStatus) =>
    choose({
      ...preferences,
      hidden: preferences.hidden.includes(status)
        ? preferences.hidden.filter(item => item !== status)
        : [...preferences.hidden, status],
    });

  const rows = versions.data ?? (versions.status === 'loading' ? versions.stale : undefined);
  const model = rows ? evolutionModel(rows) : null;
  const filtered = Boolean(from || to);
  const headings = useId();
  const analysed = model ? model.hasOffering.length > 0 : false;

  return (
    <section
      className="flex flex-col gap-4"
      aria-label="Analytics"
      aria-busy={versions.status === 'loading' || undefined}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-sm font-medium text-tp-ink">Analytics</h3>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sealed between">
          <DatePicker
            dateFrom={from}
            dateTo={to}
            onDateFromChange={setFrom}
            onDateToChange={setTo}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <FilterPills
          options={AXES}
          value={preferences.axis}
          onChange={id => choose({ ...preferences, axis: id as Axis })}
          ariaLabel="Horizontal axis"
        />
      </div>

      {inverted && (
        <Notice tone="warning">
          The first day is after the last, so no version can be in that range.
        </Notice>
      )}
      {versions.status === 'error' && (
        <Notice
          tone="error"
          action={
            <Action size="sm" onClick={versions.reload}>
              Retry
            </Action>
          }
        >
          {`The versions couldn’t be read${authMarker(classifyAuthError(versions.error))}.`}
        </Notice>
      )}
      {!model && versions.status === 'loading' && (
        <p className="text-sm text-tp-steel" role="status">
          Reading the versions…
        </p>
      )}

      {model && !inverted && model.points.length === 0 && (
        <p
          className="rounded-xl border border-tp-hairline bg-tp-canvas py-16 text-center text-sm text-tp-steel"
          role="status"
        >
          {filtered
            ? 'No versions in this date range.'
            : 'No version yet. Seal the first one in the editor.'}
        </p>
      )}

      {model && model.points.length > 0 && (
        <>
          <p className="text-xs text-tp-steel" role="status">
            {`${model.points.length} ${model.points.length === 1 ? 'version' : 'versions'}${filtered ? ' in this date range' : ''}, oldest first.`}
          </p>

          {model.markers.length > 0 && (
            <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-4">
              <h2 className="mb-2 text-sm font-medium text-tp-ink">Marked on the charts</h2>
              <ul
                aria-label="Marked on the charts"
                className="flex flex-col gap-1 text-xs text-tp-slate [&_code]:font-mono [&_time]:text-tp-steel [&>li]:flex [&>li]:flex-wrap [&>li]:gap-x-2"
              >
                {model.markers.map(marker => {
                  const point = model.points.find(item => item.ordinal === marker.ordinal);
                  return (
                    <li key={`${marker.kind}-${marker.ordinal}`} className={`is-${marker.kind}`}>
                      <code>{markerVersion(model, marker)}</code>
                      {point && (
                        <time dateTime={new Date(point.t).toISOString()}>
                          {formatDate(new Date(point.t).toISOString())}
                        </time>
                      )}
                      <span>{`${marker.label} (“${markerShort(model, marker)}”)`}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <section className="flex flex-col gap-3" aria-labelledby={`${headings}-structure`}>
            <h2 className="text-sm font-medium text-tp-ink" id={`${headings}-structure`}>
              Structure
            </h2>
            {!analysed ? (
              <p className="text-sm text-tp-steel">These versions stored no structure counts.</p>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {STRUCTURE_METRICS.map(metric => (
                    <StructureChart
                      key={metric}
                      model={model}
                      metric={metric}
                      axis={preferences.axis}
                    />
                  ))}
                </div>
                <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-4">
                  <h3 className="mb-2 text-xs font-medium text-tp-ink">Offering</h3>
                  <ol
                    aria-label="Offering per version"
                    className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tp-slate [&_code]:font-mono [&>li]:flex [&>li]:items-center [&>li]:gap-1.5"
                  >
                    {model.hasOffering.map(point => {
                      const state =
                        point.value === true ? 'yes' : point.value === false ? 'no' : 'unknown';
                      return (
                        <li key={point.ordinal} className={`is-${state}`}>
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full ${
                              state === 'yes'
                                ? 'bg-tp-chart-1'
                                : state === 'no'
                                  ? 'border border-tp-steel bg-tp-canvas'
                                  : 'border border-dashed border-tp-steel bg-tp-canvas'
                            }`}
                            aria-hidden="true"
                          />
                          <code>
                            {model.points.find(item => item.ordinal === point.ordinal)?.label}
                          </code>
                          <span>{OFFERING_TEXT[state]}</span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby={`${headings}-values`}>
            <h2 className="text-sm font-medium text-tp-ink" id={`${headings}-values`}>
              Values
            </h2>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Value statuses shown">
              {STATUSES.map(status => (
                <button
                  key={status}
                  type="button"
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border border-tp-hairline-strong px-3 py-1 text-xs text-tp-ink transition-colors hover:bg-tp-surface aria-[pressed=false]:opacity-50"
                  aria-pressed={!preferences.hidden.includes(status)}
                  onClick={() => toggle(status)}
                >
                  <Swatch status={status} />
                  {VALUE_STATUS_TEXT[status]}
                </button>
              ))}
            </div>
            <p className="text-xs text-tp-steel">
              Verified: solid line, filled dots. Declared: dashed line, hollow squares. Unverified:
              hollow circles, no line. A gap is a version without that value in that unit; each unit
              has its own chart.
            </p>
            {model.values.length === 0 ? (
              <p className="text-sm text-tp-steel">These versions give no global values.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {model.values.map(series => (
                  <ValueChart
                    key={`${series.name}\u0000${series.unit}`}
                    model={model}
                    series={series}
                    axis={preferences.axis}
                    hidden={preferences.hidden}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
