// Design follows SPHERE frontend/src/modules/pricing/components/configuration-space-view/index.tsx (revision 73779a8a); no code copied
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StudyCell } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import type { DerivedPoint } from '../../features/derive/DeriveBatch';
import { DeriveCompositionDialog } from '../../features/derive/DeriveCompositionDialog';
import type { FrontPoint } from '../../features/derive/deriveModel';
import { compositionPath } from '../../routes/paths/compositions';
import type { ParetoFront as Front } from '../../modules/core/api/types';
import { FrontComparison, type ComparedPoint } from './FrontComparison';
import {
  frontPointOf,
  frontTables,
  matchesSearch,
  objectivesText,
  type FrontRow,
  type FrontTable,
} from './frontModel';
import { formatMeasure, measureLabel } from './studiesModel';

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
  if (!derived) return <span className="org-muted">—</span>;
  return (
    <Link
      to={compositionPath(org, derived.slug, 'versions', { version: derived.version.label })}
      viewTransition
    >
      {`${derived.slug} ${derived.version.label}`}
    </Link>
  );
}

/**
 * The study front (J4): the gateway's Pareto front of each problem version, one table per front, with its points' objectives,
 * engine and seed. Ideas from SPHERE's configuration space: a search, an engine filter and a focused point walked with Prev and
 * Next. A member selects points and derives one new composition from each (the derive dialog's batch mode); two points that have
 * compositions can be compared through them.
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
  const [comparing, setComparing] = useState<{
    before: ComparedPoint;
    after: ComparedPoint;
  } | null>(null);

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
  const pick = selected.flatMap(key => allRows.filter(item => item.row.key === key));
  const comparable = pick.filter(item => derived[item.row.key]);
  // A point that already has a composition is not derived again; the batch is the selected points without one.
  const toDerive = pick.filter(item => !derived[item.row.key]);
  const toggle = (key: string) =>
    setSelected(now => (now.includes(key) ? now.filter(item => item !== key) : [...now, key]));

  const compare = () => {
    if (pick.length !== 2 || comparable.length !== 2) return;
    const [first, second] = pick;
    setComparing({
      before: { label: first.row.label, derived: derived[first.row.key] },
      after: { label: second.row.label, derived: derived[second.row.key] },
    });
  };

  if (total === 0) {
    return (
      <section className="st-card st-wide" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Pareto front</h2>
        <p className="org-muted">
          The gateway found no front: no completed cell of this run reported a feasible solution
          with its objectives.
        </p>
      </section>
    );
  }

  const compareHint =
    pick.length !== 2
      ? 'Select two points to compare them.'
      : comparable.length !== 2
        ? 'Both points need a composition to be compared: derive them first.'
        : '';

  return (
    <section className="st-card st-wide st-front" aria-labelledby={`${ids}-title`}>
      <div className="st-card-head">
        <h2 id={`${ids}-title`}>Pareto front</h2>
        <small className="org-muted">{`${total} ${total === 1 ? 'point' : 'points'} · computed by the gateway · lower is better`}</small>
      </div>
      <p className="org-muted">
        The solutions no other solution of the same problem version beats on every objective. Each
        point is one run’s solution; a composition derived from it holds that solution as its
        version 1.0.0.
      </p>

      <div className="st-card-tools">
        <label className="job-select st-front-search">
          <span>Search</span>
          <input
            type="search"
            aria-label="Search the front"
            value={search}
            placeholder="Point, cell, engine, value"
            autoComplete="off"
            spellCheck={false}
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        {engines.length > 1 && (
          <label className="job-select">
            <span>Engine</span>
            <select
              aria-label="Engine on the front"
              value={engine}
              onChange={event => setEngine(event.target.value)}
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
        <small className="org-muted">{`Showing ${visible.length} of ${total}`}</small>
      </div>

      {focused ? (
        <div className="st-front-focus" aria-label="Focused point" role="group">
          <div>
            <strong>{focused.row.label}</strong>
            <span className="org-muted">{` ${focusAt + 1} of ${visible.length}`}</span>
          </div>
          <p>
            {`${focused.row.problem} version ${focused.row.revision} · `}
            {focused.row.cell ? (
              <Link
                to={cellHref(focused.row.cell.id)}
                viewTransition
              >{`cell ${focused.row.cell.ordinal}`}</Link>
            ) : (
              'cell not listed'
            )}
            {` · ${focused.row.engine}${focused.row.cell ? ` · seed ${focused.row.cell.seed}` : ''} · solution ${focused.row.point.solution_index + 1} of its run`}
          </p>
          <p>{objectivesText(focused.row, focused.objectives)}</p>
          <p>
            Composition: <CompositionLink org={org} derived={derived[focused.row.key]} />
          </p>
          <div className="st-front-nav">
            <Action
              variant="secondary"
              size="sm"
              disabled={focusAt <= 0}
              onClick={() => setFocusChoice(visible[focusAt - 1].row.key)}
            >
              Prev
            </Action>
            <Action
              variant="secondary"
              size="sm"
              disabled={focusAt >= visible.length - 1}
              onClick={() => setFocusChoice(visible[focusAt + 1].row.key)}
            >
              Next
            </Action>
            {canDerive && !derived[focused.row.key] && (
              <Action
                variant="secondary"
                size="sm"
                onClick={() => setDeriving([frontPointOf(focused.row, focused.objectives)])}
              >
                Derive this point
              </Action>
            )}
          </div>
        </div>
      ) : (
        <p className="org-muted">No point matches this search.</p>
      )}

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
                    className={focused?.row.key === row.key ? 'is-focused' : undefined}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.label}`}
                        checked={selected.includes(row.key)}
                        onChange={() => toggle(row.key)}
                      />
                    </td>
                    <th scope="row">
                      <button
                        type="button"
                        className="st-front-point"
                        aria-label={`Focus ${row.label}`}
                        onClick={() => setFocusChoice(row.key)}
                      >
                        {row.label}
                      </button>
                    </th>
                    <td>
                      {row.cell ? (
                        <Link
                          to={cellHref(row.cell.id)}
                          viewTransition
                        >{`#${row.cell.ordinal}`}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {row.engine}
                      {row.cell && <small className="org-muted">{`seed ${row.cell.seed}`}</small>}
                    </td>
                    {table.objectives.map(name => (
                      <td key={name} className="st-number">
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

      <div className="st-front-actions">
        <span className="org-muted" role="status">{`${pick.length} selected`}</span>
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
        <Action variant="secondary" size="sm" disabled={compareHint !== ''} onClick={compare}>
          Compare two
        </Action>
        {compareHint && <small className="org-muted">{compareHint}</small>}
      </div>
      {!canDerive && (
        <p className="org-muted">{`Read-only: deriving compositions needs MEMBER in ${orgName}.`}</p>
      )}

      {deriving && (
        <DeriveCompositionDialog
          org={org}
          source={{ points: deriving }}
          onClose={() => setDeriving(null)}
          onDerived={(key, made) => setDerived(now => ({ ...now, [key]: made }))}
        />
      )}
      {comparing && (
        <FrontComparison
          org={org}
          before={comparing.before}
          after={comparing.after}
          onClose={() => setComparing(null)}
        />
      )}
    </section>
  );
}
