// Design follows SPHERE frontend/src/modules/pricing/components/pricing-version-diff/index.tsx (revision 73779a8a); no code copied
import { useId, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  CircleCheck,
  MinusCircle,
  Pencil,
  PlusCircle,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Action } from '../../../../components/ui/Action';
import { Notice } from '../../../../components/ui/Notice';
import { fieldPath, versionChanges } from '../../../../entities/composition/changes';
import type { CompositionViewModel } from '../../../../entities/composition/viewModel';
import type { Section } from '../../presets';
import { RendererSection } from '../../RendererSection';
import {
  activeFilter,
  CHANGE_KINDS,
  changeRow,
  filteredSections,
  KIND_LABELS,
  opensAtFirst,
  showsGeneral,
  type ChangeKind,
  type Diff,
  type DiffEntry,
  type FieldChange,
  type Loaded,
  type SideText,
} from './comparisonModel';
import { FileDiff } from './FileDiff';
import { GraphDiff } from './GraphDiff';
import './Comparison.css';

/** A version the pickers offer. */
export interface VersionOption {
  id: string;
  label: string;
}

/** The two texts of a file comparison. */
export interface Texts {
  before: string;
  after: string;
}

/** What the comparison mode is given: the pair, how to change it, and what the gateway answered for it. */
export interface ComparisonData {
  /** Newest first. */
  versions: readonly VersionOption[];
  /** The ids of the earlier and the later version. */
  from: string;
  to: string;
  onPair: (from: string, to: string) => void;
  /** The rows of the server diff and the workflow, or the two texts line by line. */
  view: 'compare' | 'file';
  diff: Loaded<Diff>;
  /** The two texts, for the file view. */
  files?: Loaded<Texts> | null;
  /** The earlier version's choice of candidates, once its evaluation is read (for the workflow and the matrix). */
  beforeSelection?: Loaded<Readonly<Record<string, string>> | null> | null;
}

const KIND_ICONS: Readonly<Record<ChangeKind, LucideIcon>> = {
  added: PlusCircle,
  removed: MinusCircle,
  changed: Pencil,
};

/** A count that doubles as a filter: pressing it keeps only that kind of change. */
function SummaryTile({
  kind,
  count,
  active,
  onToggle,
}: {
  kind: ChangeKind;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  const Icon = KIND_ICONS[kind];
  return (
    <button
      type="button"
      className={`cx-tile is-${kind}`}
      onClick={onToggle}
      disabled={count === 0}
      aria-pressed={active}
    >
      <Icon aria-hidden="true" />
      <span className="cx-tile-count">{count}</span>
      <span className="cx-tile-label">{KIND_LABELS[kind]}</span>
    </button>
  );
}

/** `from.version` → from › **version** */
function FieldPath({ path }: { path: string }) {
  const { parents, leaf } = fieldPath(path);
  return (
    <span className="cx-path" title={path}>
      {parents.map((parent, index) => (
        <span key={`${parent}-${index}`}>
          {parent}
          <span className="cx-path-sep" aria-hidden="true">
            {' '}
            ›{' '}
          </span>
        </span>
      ))}
      <strong>{leaf}</strong>
    </span>
  );
}

function Value({ value, which }: { value: SideText; which: 'before' | 'after' }) {
  return value.absent ? (
    <em className="cx-absent">{value.text}</em>
  ) : (
    <code className={`cx-value is-${which}`}>{value.text}</code>
  );
}

function ChangeRow({ change, kind }: { change: FieldChange; kind: ChangeKind }) {
  const row = changeRow(change, kind);
  return (
    <div className="cx-change">
      <FieldPath path={row.path} />
      <span className="cx-sides">
        {row.structure ? (
          <em className="cx-absent">changed; the file view shows how</em>
        ) : (
          <>
            {row.before && <Value value={row.before} which="before" />}
            {row.before && row.after && (
              <>
                <ArrowRight className="cx-arrow" aria-hidden="true" />
                <span className="sr-only"> to </span>
              </>
            )}
            {row.after && <Value value={row.after} which="after" />}
          </>
        )}
      </span>
    </div>
  );
}

function EntryItem({ entry }: { entry: DiffEntry }) {
  const [open, setOpen] = useState(() => opensAtFirst(entry));
  const details = entry.changes.length > 0;
  const fields = `${entry.changes.length} ${entry.changes.length === 1 ? 'field' : 'fields'}`;
  const head = (
    <>
      <span className={`cx-dot is-${entry.kind}`} aria-hidden="true" />
      <span className="cx-entry-name">{entry.name}</span>
      <span className={`cx-kind is-${entry.kind}`}>{KIND_LABELS[entry.kind]}</span>
      {details && <span className="cx-fields">{fields}</span>}
    </>
  );
  return (
    <li className="cx-entry">
      {details ? (
        <button
          type="button"
          className="cx-entry-head"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
        >
          {head}
          <ChevronDown className={`cx-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
        </button>
      ) : (
        <div className="cx-entry-head">{head}</div>
      )}
      {details && open && (
        <div className="cx-entry-body">
          {entry.changes.map(change => (
            <ChangeRow key={change.path} change={change} kind={entry.kind} />
          ))}
        </div>
      )}
    </li>
  );
}

function SectionList({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="cx-section" aria-labelledby={id}>
      <h3 id={id}>
        {title}
        {count !== undefined && <span className="cx-section-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/**
 * What the gateway's diff says changed: kind tiles that filter, the general changes and the sections of entries. The Versions tab shows
 * it for two versions of a composition; a study front shows it for the first versions of two compositions (the server's document
 * diff, named as a version diff).
 */
export function Changes({ diff }: { diff: Diff }) {
  const [chosen, setChosen] = useState<ChangeKind | null>(null);
  const filter = activeFilter(diff, chosen);
  const sections = filteredSections(diff, filter);
  const notComparable = versionChanges(diff).notComparable;

  return (
    <RendererSection title="Changes">
      {notComparable && (
        <Notice tone="warning" title="These versions’ values are not compared">
          {`${notComparable} The values section is left out.`}
        </Notice>
      )}
      {diff.isEmpty ? (
        <p className="cx-identical">
          <CircleCheck aria-hidden="true" />
          {`${diff.from.label} and ${diff.to.label} bind, value and offer the same.`}
        </p>
      ) : (
        <>
          <div className="cx-tiles" role="group" aria-label="Show one kind of change">
            {CHANGE_KINDS.map(kind => (
              <SummaryTile
                key={kind}
                kind={kind}
                count={diff.totals[kind]}
                active={filter === kind}
                onToggle={() => setChosen(filter === kind ? null : kind)}
              />
            ))}
          </div>
          {filter && (
            <p className="cx-filter">
              Showing only <strong>{KIND_LABELS[filter].toLowerCase()}</strong> items
              <button type="button" className="cx-clear" onClick={() => setChosen(null)}>
                <X aria-hidden="true" />
                Clear filter
              </button>
            </p>
          )}
          {showsGeneral(diff, filter) && (
            <SectionList title="General">
              <div className="cx-general">
                {diff.general.map(change => (
                  <ChangeRow key={change.path} change={change} kind="changed" />
                ))}
              </div>
            </SectionList>
          )}
          {sections.map(section => (
            <SectionList key={section.key} title={section.label} count={section.entries.length}>
              <ul className="cx-entries">
                {section.entries.map(entry => (
                  <EntryItem key={`${entry.kind}-${entry.name}`} entry={entry} />
                ))}
              </ul>
            </SectionList>
          ))}
        </>
      )}
    </RendererSection>
  );
}

function Pending({ what, state }: { what: string; state: Loaded<unknown> }) {
  if (state.status === 'loading')
    return <p className="cx-pending" role="status">{`Reading ${what}…`}</p>;
  if (state.status === 'error') {
    return (
      <Notice
        tone="error"
        action={
          <Action variant="secondary" size="sm" onClick={state.retry}>
            Retry
          </Action>
        }
      >
        {state.message}
      </Notice>
    );
  }
  return null;
}

function PairPicker({
  versions,
  from,
  to,
  onPair,
}: Pick<ComparisonData, 'versions' | 'from' | 'to' | 'onPair'>) {
  return (
    <div className="cx-pair">
      <label className="cx-pick">
        <span>Base version</span>
        <select
          className="cmp-select"
          value={from}
          onChange={event => onPair(event.target.value, to)}
        >
          {versions.map(version => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="cx-swap"
        aria-label="Swap versions"
        title="Swap versions"
        onClick={() => onPair(to, from)}
      >
        <ArrowLeftRight aria-hidden="true" />
      </button>
      <label className="cx-pick">
        <span>Compared with</span>
        <select
          className="cmp-select"
          value={to}
          onChange={event => onPair(from, event.target.value)}
        >
          {versions.map(version => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

interface ComparisonProps extends ComparisonData {
  /** The later version: its workflow, tasks and, for a member, its candidate matrix. */
  model: CompositionViewModel;
  sections: readonly Section[];
  /** Fold what did not change in the file view at first. */
  onlyDifferences: boolean;
}

/**
 * The comparison mode: two versions picked (and swapped), then what the gateway's diff says changed between them, as kind tiles
 * that filter, sections of entries and field rows (`before → after`, a missing side read as absent), with the workflow of the
 * later version marked; or the two texts line by line. Values that the gateway did not compare are left out, and the banner
 * says why.
 */
export function Comparison({
  versions,
  from,
  to,
  onPair,
  view,
  diff,
  files = null,
  beforeSelection = null,
  model,
  sections,
  onlyDifferences,
}: ComparisonProps) {
  const labelOf = (id: string) => versions.find(version => version.id === id)?.label ?? id;
  const shows = (section: Section) => sections.includes(section);
  return (
    <div className="cx">
      <PairPicker versions={versions} from={from} to={to} onPair={onPair} />
      {from === to && (
        <p className="cx-pending">Pick two different versions to see what changed between them.</p>
      )}
      {view === 'compare' &&
        from !== to &&
        (diff.status !== 'ready' ? (
          <Pending what="what changed" state={diff} />
        ) : (
          <>
            {shows('changes') && <Changes key={`${from}..${to}`} diff={diff.value} />}
            {beforeSelection && beforeSelection.status !== 'ready' && (
              <Pending what="the workflow" state={beforeSelection} />
            )}
            {beforeSelection?.status === 'ready' && model.version?.id === to && (
              <GraphDiff
                model={model}
                diff={diff.value}
                beforeSelection={beforeSelection.value}
                sections={sections}
              />
            )}
          </>
        ))}
      {view === 'file' &&
        from !== to &&
        files &&
        (files.status !== 'ready' ? (
          <Pending what="both texts" state={files} />
        ) : (
          <FileDiff
            key={`${from}..${to}`}
            before={files.value.before}
            after={files.value.after}
            beforeLabel={labelOf(from)}
            afterLabel={labelOf(to)}
            foldAtFirst={onlyDifferences}
          />
        ))}
    </div>
  );
}
