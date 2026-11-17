// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-view/index.tsx (feat/pricing-renderer,
// revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the configuration space view's frame (the compare tray at the top, the count chips, a search and a select, the
// focused item walked with Prev, Next and Surprise me) around a study run's Pareto front instead of a pricing's
// subscriptions: the gateway's front of each problem version as a table, whose points a member selects and derives one
// composition from each (the derive dialog's batch mode). Two points held in the compare tray are compared through the
// compositions derived from them, with the composition module's structured diff.

import { motion } from 'framer-motion';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../../../utils/useResource';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type { ParetoFront as Front } from '../../../core/api/types';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import CompareTray from '../../../composition/components/configuration-space-view/compare-tray';
import {
  captureLabel,
  nextSlot,
  type CompareSide,
  type CompareSlots,
} from '../../../composition/components/configuration-space-view/compare-slots';
import type { DerivedPoint } from '../../../run/components/derive/DeriveBatch';
import { DeriveCompositionDialog } from '../../../run/components/derive/DeriveCompositionDialog';
import type { FrontPoint } from '../../../run/components/derive/deriveModel';
import { compositionPath } from '../../../../routes/paths/compositions';
import { studiesApi, type StudyCell } from '../../api/studiesApi';
import type { StudyScopeValue } from '../../pages/card/hooks';
import {
  frontPointOf,
  frontTables,
  matchesSearch,
  objectivesText,
  type FrontRow,
  type FrontTable,
} from '../../utils/frontModel';
import { loadRun } from '../../utils/runData';
import { formatMeasure, measureLabel, studyPageHref } from '../../utils/studiesModel';
import { LINK, MUTED, SMALL_BUTTON } from '../../utils/ui';
import { FrontComparison } from '../front-comparison';
import { RunMissing } from '../study-run';

interface ParetoFrontProps {
  org: string;
  /** The organization's name, for the read-only note. */
  orgName: string;
  /** `analytics.pareto`: one front per problem version and set of objective names, as the gateway computed it. */
  fronts: readonly Front[];
  /** The run's cells, for each point's cell number and seed. */
  cells: readonly StudyCell[];
  cellHref: (cellId: string) => string;
  /** MEMBER: compositions can be derived from the points. */
  canDerive: boolean;
}

const ALL_ENGINES = '';

function CompositionLink({ org, derived }: { org: string; derived: DerivedPoint | undefined }) {
  if (!derived) return <span className="text-tp-steel">—</span>;
  return (
    <Link
      to={compositionPath(org, derived.slug, 'versions', { version: derived.version.label })}
      viewTransition
      className={LINK}
    >
      {`${derived.slug} ${derived.version.label}`}
    </Link>
  );
}

/**
 * The study front (J4): the gateway's Pareto front of each problem version, one table per front, with its points' objectives,
 * engine and seed, a search, an engine filter and a focused point walked with Prev and Next. A member selects points and
 * derives one new composition from each; two points that have compositions are held in the compare tray and compared.
 */
export function ParetoFront({
  org,
  orgName,
  fronts,
  cells,
  cellHref,
  canDerive,
}: ParetoFrontProps) {
  const ids = useId();
  const tables = useMemo(() => frontTables(fronts, cells), [fronts, cells]);
  const [search, setSearch] = useState('');
  const [engine, setEngine] = useState(ALL_ENGINES);
  const [focusChoice, setFocusChoice] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [derived, setDerived] = useState<Readonly<Record<string, DerivedPoint>>>({});
  const [deriving, setDeriving] = useState<readonly FrontPoint[] | null>(null);
  const [slots, setSlots] = useState<CompareSlots>({});

  const engines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const table of tables)
      for (const row of table.rows)
        if (!seen.has(row.point.engine)) seen.set(row.point.engine, row.engine);
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [tables]);

  const shown: FrontTable[] = tables.map(table => ({
    ...table,
    rows: table.rows.filter(
      row =>
        (engine === ALL_ENGINES || row.point.engine === engine) &&
        matchesSearch(row, table.objectives, search)
    ),
  }));
  const visible = shown.flatMap(table =>
    table.rows.map(row => ({ row, objectives: table.objectives }))
  );
  const total = tables.reduce((count, table) => count + table.rows.length, 0);
  const focusAt = Math.max(
    0,
    visible.findIndex(item => item.row.key === focusChoice)
  );
  const focused = visible[focusAt] ?? null;

  const allRows = tables.flatMap(table =>
    table.rows.map(row => ({ row, objectives: table.objectives }))
  );
  const rowOf = (key: string | undefined) => allRows.find(item => item.row.key === key)?.row;
  const pick = selected.flatMap(key => allRows.filter(item => item.row.key === key));
  // A point that already has a composition is not derived again; the batch is the selected points without one.
  const toDerive = pick.filter(item => !derived[item.row.key]);
  const toggle = (key: string) =>
    setSelected(now => (now.includes(key) ? now.filter(item => item !== key) : [...now, key]));

  const hold = (key: string) => setSlots(now => ({ ...now, [nextSlot(now)]: key }));
  const clearSlots = (side?: CompareSide) =>
    setSlots(now => (side ? { ...now, [side]: undefined } : {}));
  const swapSlots = () => setSlots(now => ({ a: now.b, b: now.a }));
  const heldA = rowOf(slots.a);
  const heldB = rowOf(slots.b);
  const identical = Boolean(slots.a && slots.a === slots.b);

  const compareSelected = () => {
    if (pick.length !== 2) return;
    setSlots({ a: pick[0].row.key, b: pick[1].row.key });
  };

  if (total === 0) {
    return (
      <section
        aria-labelledby={`${ids}-title`}
        className="flex flex-col items-center justify-center rounded-xl border border-tp-hairline bg-tp-canvas px-4 py-16 text-center"
      >
        <h2 id={`${ids}-title`} className="text-sm font-medium text-tp-ink">
          Pareto front
        </h2>
        <p className={`mt-1 max-w-125 ${MUTED}`}>
          The gateway found no front: no completed cell of this run reported a feasible solution
          with its objectives.
        </p>
      </section>
    );
  }

  const compareHint = pick.length !== 2 ? 'Select two points to compare them.' : '';
  const pending = heldA && heldB && !identical && (!derived[heldA.key] || !derived[heldB.key]);

  return (
    <div className="flex flex-col gap-4 max-sm:pb-28">
      <CompareTray
        slots={slots}
        describe={key => {
          const row = rowOf(key);
          return row ? `${row.label} · ${row.problem} version ${row.revision}` : key;
        }}
        onClear={clearSlots}
        onSwap={swapSlots}
        identical={identical}
      />
      {heldA && heldB && !identical && (
        <motion.section
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          aria-label="A compared with B"
          className="rounded-xl border border-tp-hairline bg-tp-canvas p-4"
        >
          <h2 className="mb-2 text-lg font-semibold text-tp-ink">A compared with B</h2>
          {pending ? (
            <p className={MUTED}>
              Both points need a composition to be compared: derive them first.
            </p>
          ) : (
            <FrontComparison
              org={org}
              before={{ label: heldA.label, derived: derived[heldA.key] }}
              after={{ label: heldB.label, derived: derived[heldB.key] }}
            />
          )}
        </motion.section>
      )}

      <section
        aria-labelledby={`${ids}-title`}
        className="flex min-w-0 flex-col gap-4 rounded-xl border border-tp-hairline bg-tp-canvas p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id={`${ids}-title`} className="text-lg font-semibold text-tp-ink">
              Pareto front
            </h2>
            <p className={MUTED}>
              The solutions no other solution of the same problem version beats on every objective.
              Each point is one run’s solution; a composition derived from it holds that solution as
              its version 1.0.0.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-tp-steel">
            <span className="rounded-full bg-tp-surface px-2 py-0.5">{`${total} ${total === 1 ? 'point' : 'points'} · computed by the gateway · lower is better`}</span>
            <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-tp-accent">{`Showing ${visible.length} of ${total}`}</span>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_220px]">
          <label className="rounded-lg border border-tp-hairline-strong bg-tp-canvas p-3">
            <span className="mb-1 block text-[10px] font-medium tracking-wider text-tp-steel uppercase">
              Search
            </span>
            <input
              type="search"
              aria-label="Search the front"
              value={search}
              placeholder="Point, cell, engine, value"
              autoComplete="off"
              spellCheck={false}
              onChange={event => setSearch(event.target.value)}
              className="w-full bg-transparent text-sm text-tp-ink placeholder-tp-muted outline-none"
            />
          </label>
          {engines.length > 1 && (
            <label className="rounded-lg border border-tp-hairline-strong bg-tp-canvas p-3">
              <span className="mb-1 block text-[10px] font-medium tracking-wider text-tp-steel uppercase">
                Engine
              </span>
              <select
                aria-label="Engine on the front"
                value={engine}
                onChange={event => setEngine(event.target.value)}
                className="w-full cursor-pointer bg-transparent text-sm text-tp-ink outline-none"
              >
                <option value={ALL_ENGINES}>All engines</option>
                {engines.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="rounded-xl border border-tp-hairline bg-tp-surface p-4">
          {focused ? (
            <motion.div
              key={focused.row.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              aria-label="Focused point"
              role="group"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium tracking-wider text-tp-steel uppercase">
                    Current selection
                  </p>
                  <h3 className="mt-0.5 font-mono text-base font-semibold text-tp-ink">
                    {focused.row.label}
                  </h3>
                </div>
                <span className="rounded-full border border-tp-hairline bg-tp-canvas px-2 py-0.5 text-[11px] text-tp-steel">{` ${focusAt + 1} of ${visible.length}`}</span>
              </div>
              <p className="mt-2 text-sm text-tp-slate">
                {`${focused.row.problem} version ${focused.row.revision} · `}
                {focused.row.cell ? (
                  <Link
                    to={cellHref(focused.row.cell.id)}
                    viewTransition
                    className={LINK}
                  >{`cell ${focused.row.cell.ordinal}`}</Link>
                ) : (
                  'cell not listed'
                )}
                {` · ${focused.row.engine}${focused.row.cell ? ` · seed ${focused.row.cell.seed}` : ''} · solution ${focused.row.point.solution_index + 1} of its run`}
              </p>
              <p className="mt-1 text-sm text-tp-ink">
                {objectivesText(focused.row, focused.objectives)}
              </p>
              <p className="mt-1 text-sm text-tp-slate">
                Composition: <CompositionLink org={org} derived={derived[focused.row.key]} />
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  disabled={focusAt <= 0}
                  onClick={() => setFocusChoice(visible[focusAt - 1].row.key)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  disabled={focusAt >= visible.length - 1}
                  onClick={() => setFocusChoice(visible[focusAt + 1].row.key)}
                >
                  Next
                </button>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  onClick={() => hold(focused.row.key)}
                >
                  {captureLabel(slots)}
                </button>
                {canDerive && !derived[focused.row.key] && (
                  <button
                    type="button"
                    className={SMALL_BUTTON}
                    onClick={() => setDeriving([frontPointOf(focused.row, focused.objectives)])}
                  >
                    Derive this point
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setFocusChoice(visible[Math.floor(Math.random() * visible.length)].row.key)
                  }
                  className="ml-auto flex cursor-pointer items-center gap-1 rounded-md bg-tp-accent px-3 py-1.5 text-xs font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
                >
                  <span aria-hidden="true">🎲</span> Surprise me
                </button>
              </div>
            </motion.div>
          ) : (
            <p className="rounded-lg border border-dashed border-tp-hairline-strong p-6 text-center text-xs text-tp-steel">
              No point matches this search.
            </p>
          )}
        </div>

        {shown.map(
          table =>
            table.rows.length > 0 && (
              <DataTable
                key={table.title}
                label={`Front of ${table.title}`}
                minWidth={560}
                caption={`${table.title} · ${table.objectives.map(measureLabel).join(', ')}`}
              >
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Selected</span>
                    </th>
                    <th scope="col">Point</th>
                    <th scope="col">Cell</th>
                    <th scope="col">Engine · seed</th>
                    {table.objectives.map(name => (
                      <th key={name} scope="col">
                        {measureLabel(name)}
                      </th>
                    ))}
                    <th scope="col">Composition</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row: FrontRow) => (
                    <tr
                      key={row.key}
                      aria-current={focused?.row.key === row.key ? 'true' : undefined}
                      className={focused?.row.key === row.key ? 'bg-tp-primary/5' : undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.label}`}
                          checked={selected.includes(row.key)}
                          onChange={() => toggle(row.key)}
                          className="h-3.5 w-3.5 cursor-pointer accent-tp-primary"
                        />
                      </td>
                      <th scope="row">
                        <button
                          type="button"
                          aria-label={`Focus ${row.label}`}
                          onClick={() => setFocusChoice(row.key)}
                          className="cursor-pointer font-mono font-semibold text-tp-accent hover:underline"
                        >
                          {row.label}
                        </button>
                      </th>
                      <td>
                        {row.cell ? (
                          <Link
                            to={cellHref(row.cell.id)}
                            viewTransition
                            className={LINK}
                          >{`#${row.cell.ordinal}`}</Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {row.engine}
                        {row.cell && (
                          <small className={`block ${MUTED}`}>{`seed ${row.cell.seed}`}</small>
                        )}
                      </td>
                      {table.objectives.map(name => (
                        <td key={name} className="tabular-nums">
                          {formatMeasure(row.point.objectives[name])}
                        </td>
                      ))}
                      <td>
                        <CompositionLink org={org} derived={derived[row.key]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-tp-steel" role="status">{`${pick.length} selected`}</span>
          {canDerive && (
            <Action
              variant="primary"
              size="sm"
              disabled={toDerive.length === 0}
              onClick={() =>
                setDeriving(toDerive.map(item => frontPointOf(item.row, item.objectives)))
              }
            >
              Derive compositions
            </Action>
          )}
          <Action
            variant="secondary"
            size="sm"
            disabled={compareHint !== ''}
            onClick={compareSelected}
          >
            Compare two
          </Action>
          {compareHint && <small className={MUTED}>{compareHint}</small>}
        </div>
        {!canDerive && (
          <p className={MUTED}>{`Read-only: deriving compositions needs MEMBER in ${orgName}.`}</p>
        )}
      </section>

      {deriving && (
        <DeriveCompositionDialog
          org={org}
          source={{ points: deriving }}
          onClose={() => setDeriving(null)}
          onDerived={(key, made) => setDerived(now => ({ ...now, [key]: made }))}
        />
      )}
    </div>
  );
}

/** The Front tab of the study page: the gateway's Pareto front of the study run `runId`. */
export function FrontTab({ scope, runId }: { scope: StudyScopeValue; runId: string }) {
  const { study, organization, studyPath, access } = scope;
  const org = organization.slug;
  const analytics = useResource(`analytics:${runId}`, () =>
    studiesApi.analytics(org, study.slug, runId)
  );
  const loaded = useResource(`analytics-run:${study.id}/${runId}`, () =>
    loadRun(org, study.slug, runId)
  );
  const summary = analytics.data ?? analytics.stale;
  const data = loaded.data ?? loaded.stale;
  const failed =
    analytics.status === 'error'
      ? analytics.error
      : loaded.status === 'error'
        ? loaded.error
        : null;
  if (failed && (!summary || !data)) {
    const problem = classifyAuthError(failed);
    if (problem.status === 404) return <RunMissing studyName={study.name} />;
    return (
      <Notice
        tone="error"
        action={
          <Action
            variant="secondary"
            size="sm"
            onClick={() => {
              analytics.reload();
              loaded.reload();
            }}
          >
            Retry
          </Action>
        }
      >
        The front couldn’t be loaded{marker(problem)}.
      </Notice>
    );
  }
  if (!summary || !data) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the front…</span>
        <Skeleton variant="panel" />
      </div>
    );
  }
  return (
    <ParetoFront
      org={org}
      orgName={organization.name}
      fronts={summary.pareto ?? []}
      cells={data.cells}
      cellHref={cellId => studyPageHref(studyPath, 'front', { run: runId, cell: cellId })}
      canDerive={access.canCreate}
    />
  );
}
