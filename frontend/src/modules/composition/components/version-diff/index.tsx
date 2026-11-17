// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-version-diff/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the gateway compares the two versions (`GET …/diff`, already in SPHERE's PricingDiff shape) instead of the
// browser parsing both YAML files; a field absent on one side is read from the gateway's null, and a whole structure that
// changed (the workflow) is named rather than printed (diffModel); OpenBinding's workflow section follows the entries (the
// later workflow with each changed task marked, and the candidates each version chose for a member who reads the problem);
// a pair the values cannot be compared on says why; the pair lives in the address (`from`, `to`) through `onPair`.

import { useState, type ReactNode } from 'react';
import type { IconType } from 'react-icons';
import {
  FiArrowRight,
  FiCheckCircle,
  FiChevronDown,
  FiCode,
  FiEdit3,
  FiList,
  FiMinusCircle,
  FiPlusCircle,
  FiRepeat,
  FiX,
} from 'react-icons/fi';
import { useResource } from '../../../../utils/useResource';
import { readApiError } from '../../../core/api/errors';
import type {
  CompositionVersionDiff,
  CompositionVersionView,
  CompositionView,
  ProblemFacts,
} from '../../../core/api/types';
import { GraphDiff } from '../../../core/components/composition-renderer/modes/comparison/GraphDiff';
import {
  activeFilter,
  changeRow,
  filteredSections,
  opensAtFirst,
  showsGeneral,
  type ChangeKind,
  type DiffEntry,
  type DiffSection,
  type FieldChange,
} from '../../../core/components/composition-renderer/modes/comparison/diffModel';
import { notComparableShort } from '../../../core/utils/composition/changes';
import { factsSource } from '../../../core/utils/composition/factsSource';
import { compositionViewModel } from '../../../core/utils/composition/viewModel';
import { problemFactsApi } from '../../../core/utils/problem/facts';
import { compositionsApi } from '../../api/compositionsApi';
import FileDiffView from './file-diff-view';

type ViewMode = 'structured' | 'file';

const KIND_STYLES: Record<
  ChangeKind,
  {
    label: string;
    icon: IconType;
    badge: string;
    dot: string;
    tile: string;
    number: string;
    ring: string;
  }
> = {
  added: {
    label: 'Added',
    icon: FiPlusCircle,
    badge: 'bg-emerald-100 text-emerald-800',
    dot: 'bg-emerald-500',
    tile: 'border-emerald-200 bg-emerald-50',
    number: 'text-emerald-700',
    ring: 'ring-emerald-500',
  },
  removed: {
    label: 'Removed',
    icon: FiMinusCircle,
    badge: 'bg-red-100 text-red-800',
    dot: 'bg-red-500',
    tile: 'border-red-200 bg-red-50',
    number: 'text-red-700',
    ring: 'ring-red-500',
  },
  changed: {
    label: 'Changed',
    icon: FiEdit3,
    badge: 'bg-amber-100 text-amber-900',
    dot: 'bg-amber-500',
    tile: 'border-amber-200 bg-amber-50',
    number: 'text-amber-800',
    ring: 'ring-amber-500',
  },
};

function KindBadge({ kind }: { kind: ChangeKind }) {
  const style = KIND_STYLES[kind];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.badge}`}
    >
      {style.label}
    </span>
  );
}

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
  const style = KIND_STYLES[kind];
  const Icon = style.icon;
  const disabled = count === 0;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={active}
      title={active ? 'Show all changes' : `Show only ${style.label.toLowerCase()}`}
      className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all ${style.tile} ${
        disabled
          ? 'cursor-default opacity-50'
          : 'cursor-pointer hover:shadow-sm focus-visible:ring-2 focus-visible:outline-none'
      } ${active ? `ring-2 ring-offset-2 ${style.ring}` : ''} ${disabled ? '' : style.ring}`}
    >
      <Icon className={`h-5 w-5 shrink-0 ${style.number}`} aria-hidden="true" />
      <div>
        <p className={`text-2xl leading-none font-semibold tabular-nums ${style.number}`}>
          {count}
        </p>
        <p className="mt-1 text-sm text-tp-slate">{style.label}</p>
      </div>
    </button>
  );
}

/** `binding.t1.candidate` → binding › t1 › **candidate** */
function FieldPath({ path }: { path: string }) {
  const segments = path.split('.');
  const last = segments.pop();
  return (
    <span className="min-w-0 text-[13px] leading-5 break-words text-tp-steel" title={path}>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`}>
          {segment}
          <span className="mx-1 text-tp-steel" aria-hidden="true">
            ›
          </span>
        </span>
      ))}
      <span className="font-medium text-tp-ink">{last}</span>
    </span>
  );
}

const valuePill = 'max-w-full break-words rounded-md px-2 py-0.5 font-mono text-[13px] leading-5';

function ChangeRow({ change, kind }: { change: FieldChange; kind: ChangeKind }) {
  const row = changeRow(change, kind);
  return (
    <div className="grid gap-1.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] sm:items-start sm:gap-4">
      <FieldPath path={row.path} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {row.structure ? (
          <span className="text-[13px] text-tp-slate">Changed: the file view shows how.</span>
        ) : (
          <>
            {row.before &&
              (row.before.absent ? (
                <span className="text-[13px] text-tp-steel italic">not set</span>
              ) : (
                <span className={`${valuePill} bg-red-100 text-red-800`}>{row.before.text}</span>
              ))}
            {row.before && row.after && (
              <FiArrowRight className="h-3.5 w-3.5 shrink-0 text-tp-steel" aria-label="becomes" />
            )}
            {row.after &&
              (row.after.absent ? (
                <span className="text-[13px] text-tp-steel italic">removed</span>
              ) : (
                <span className={`${valuePill} bg-emerald-100 text-emerald-900`}>
                  {row.after.text}
                </span>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

function EntryItem({ entry }: { entry: DiffEntry }) {
  const [open, setOpen] = useState(opensAtFirst(entry));
  const style = KIND_STYLES[entry.kind];
  const hasDetails = entry.changes.length > 0;
  return (
    <div className="overflow-hidden rounded-xl border border-tp-hairline-strong bg-tp-canvas">
      <button
        type="button"
        onClick={() => hasDetails && setOpen(current => !current)}
        aria-expanded={hasDetails ? open : undefined}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${hasDetails ? 'cursor-pointer hover:bg-tp-surface' : 'cursor-default'}`}
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-[15px] font-semibold text-tp-ink">
          {entry.name}
        </span>
        <KindBadge kind={entry.kind} />
        {hasDetails ? (
          <>
            <span className="hidden text-sm text-tp-slate sm:inline">
              {entry.changes.length} {entry.changes.length === 1 ? 'field' : 'fields'}
            </span>
            <FiChevronDown
              className={`h-4 w-4 shrink-0 text-tp-steel transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </>
        ) : null}
      </button>
      {hasDetails && open ? (
        <div className="divide-y divide-tp-hairline border-t border-tp-hairline bg-tp-surface/60 px-4">
          {entry.changes.map(change => (
            <ChangeRow key={change.path} change={change} kind={entry.kind} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h4 className="flex items-center gap-2 text-base font-semibold text-tp-ink">
      {children}
      {count !== undefined ? (
        <span className="rounded-full bg-tp-surface px-2 py-0.5 text-xs font-medium text-tp-slate ring-1 ring-tp-hairline">
          {count}
        </span>
      ) : null}
    </h4>
  );
}

function Section({ section }: { section: DiffSection }) {
  if (section.entries.length === 0) return null;
  return (
    <section className="space-y-3" aria-label={section.label}>
      <SectionTitle count={section.entries.length}>{section.label}</SectionTitle>
      <div className="space-y-2">
        {section.entries.map(entry => (
          <EntryItem key={`${entry.kind}-${entry.name}`} entry={entry} />
        ))}
      </div>
    </section>
  );
}

/** The structured comparison of two documents: the summary tiles, the general changes and the sections. */
export function DiffResult({
  diff,
  filter,
  onFilterChange,
  workflow,
}: {
  diff: CompositionVersionDiff;
  filter: ChangeKind | null;
  onFilterChange: (filter: ChangeKind | null) => void;
  workflow: ReactNode;
}) {
  const shown = activeFilter(diff, filter);
  const sections = filteredSections(diff, shown);
  const toggle = (kind: ChangeKind) => onFilterChange(shown === kind ? null : kind);
  const notComparable = !diff.comparison.comparable;

  if (diff.isEmpty) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-tp-hairline-strong px-4 py-10 text-center">
        <FiCheckCircle className="h-6 w-6 text-emerald-600" aria-hidden="true" />
        <p className="text-sm font-medium text-tp-ink">These two versions are identical</p>
        <p className="text-sm text-tp-slate">The binding, the values and the offering all match.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {(['added', 'removed', 'changed'] as const).map(kind => (
          <SummaryTile
            key={kind}
            kind={kind}
            count={diff.totals[kind]}
            active={shown === kind}
            onToggle={() => toggle(kind)}
          />
        ))}
      </div>

      {notComparable && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Values not compared: {notComparableShort(diff.comparison)}
        </p>
      )}

      {shown ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-tp-surface px-3 py-2 text-sm text-tp-slate">
          <span>
            Showing only{' '}
            <strong className="text-tp-ink">{KIND_STYLES[shown].label.toLowerCase()}</strong> items
          </span>
          <button
            type="button"
            onClick={() => onFilterChange(null)}
            className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-tp-accent hover:underline"
          >
            <FiX className="h-3.5 w-3.5" aria-hidden="true" />
            Clear filter
          </button>
        </div>
      ) : null}

      {showsGeneral(diff, shown) ? (
        <section className="space-y-3" aria-label="General">
          <SectionTitle>General</SectionTitle>
          <div className="divide-y divide-tp-hairline rounded-xl border border-tp-hairline-strong bg-tp-canvas px-4">
            {diff.general.map(change => (
              <ChangeRow key={change.path} change={change} kind="changed" />
            ))}
          </div>
        </section>
      ) : null}

      {sections.map(section => (
        <Section key={section.key} section={section} />
      ))}

      {!shown && workflow}
    </div>
  );
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  const options: { mode: ViewMode; label: string; icon: IconType }[] = [
    { mode: 'structured', label: 'Structured', icon: FiList },
    { mode: 'file', label: 'File', icon: FiCode },
  ];
  return (
    <div
      role="group"
      aria-label="Comparison view"
      className="inline-grid grid-cols-2 gap-1 rounded-xl bg-tp-surface p-1"
    >
      {options.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-4 py-1.5 text-sm font-medium transition-all ${
            value === mode
              ? 'border-tp-primary/30 bg-tp-canvas text-tp-ink shadow-sm'
              : 'border-transparent text-tp-steel hover:text-tp-ink'
          }`}
        >
          <Icon
            className={`h-4 w-4 ${value === mode ? 'text-tp-accent' : ''}`}
            aria-hidden="true"
          />
          {label}
        </button>
      ))}
    </div>
  );
}

const currentBinding = (version: CompositionVersionView): Record<string, string> | null =>
  version.evaluations.find(evaluation => evaluation.current)?.binding ?? null;

interface CompositionVersionDiffProps {
  org: string;
  composition: CompositionView;
  /** Newest first. */
  versions: CompositionVersionView[];
  /** The base (older) and compared versions, by id. */
  from: string;
  to: string;
  onPair: (from: string, to: string) => void;
  /** A member reads the linked problem's candidates beside the workflow. */
  member: boolean;
  view: ViewMode;
  onView: (view: ViewMode) => void;
}

export default function CompositionVersionDiffView({
  org,
  composition,
  versions,
  from,
  to,
  onPair,
  member,
  view,
  onView,
}: CompositionVersionDiffProps) {
  const [filter, setFilter] = useState<ChangeKind | null>(null);
  const slug = composition.slug;
  const pairKey = `${org}/${slug}/${from}..${to}`;
  const fromVersion = versions.find(version => version.id === from);
  const toVersion = versions.find(version => version.id === to);

  const diff = useResource<CompositionVersionDiff>(`composition-diff:${pairKey}`, () =>
    compositionsApi.diff(org, slug, from, to)
  );
  const texts = useResource<{ before: string; after: string } | null>(
    `composition-texts:${view === 'file' ? pairKey : 'none'}`,
    async () => {
      if (view !== 'file') return null;
      const [before, after] = await Promise.all([
        compositionsApi.content(org, slug, from),
        compositionsApi.content(org, slug, to),
      ]);
      return { before, after };
    }
  );
  const documents = useResource<[CompositionVersionView, CompositionVersionView] | null>(
    `composition-pair:${view === 'structured' ? pairKey : 'none'}`,
    async () =>
      view === 'structured'
        ? Promise.all([
            compositionsApi.version(org, slug, from, { document: true }),
            compositionsApi.version(org, slug, to, { document: true }),
          ])
        : null
  );
  const later = documents.data?.[1] ?? null;
  const source = member ? factsSource(later) : null;
  const facts = useResource<ProblemFacts | null>(
    `composition-facts:${org}/${source ? `${source.problem}@${source.revision}/${source.compilation}` : 'none'}`,
    async () =>
      source
        ? problemFactsApi
            .get(org, source.problem, source.revision, source.compilation)
            .catch(() => null)
        : null
  );

  const swap = () => onPair(to, from);

  const selectClass =
    'h-10 w-full cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 text-sm font-medium text-tp-ink outline-none transition-colors focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/10';
  const labelClass = 'mb-1.5 block text-sm font-medium text-tp-slate';

  const workflow =
    documents.data && diff.data && (!source || facts.status !== 'loading') ? (
      <div className="space-y-3">
        <GraphDiff
          model={compositionViewModel({
            composition,
            version: later,
            facts: facts.data ?? null,
            reader: member ? 'member' : 'public',
          })}
          diff={diff.data}
          beforeSelection={currentBinding(documents.data[0])}
          sections={['graph', 'candidates']}
        />
      </div>
    ) : null;

  return (
    <div className="space-y-6 rounded-2xl border border-tp-hairline bg-tp-canvas p-5 shadow-sm sm:p-6">
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <label className="block">
          <span className={labelClass}>Base version</span>
          <select
            value={from}
            onChange={event => onPair(event.target.value, to)}
            className={selectClass}
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
          onClick={swap}
          title="Swap versions"
          aria-label="Swap versions"
          className="mx-auto flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-tp-hairline-strong bg-tp-canvas text-tp-slate transition-colors hover:border-tp-primary/40 hover:text-tp-accent"
        >
          <FiRepeat className="h-4 w-4" aria-hidden="true" />
        </button>
        <label className="block">
          <span className={labelClass}>Compared with</span>
          <select
            value={to}
            onChange={event => onPair(from, event.target.value)}
            className={selectClass}
          >
            {versions.map(version => (
              <option key={version.id} value={version.id}>
                {version.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-6 border-t border-tp-hairline pt-6">
        <ViewToggle value={view} onChange={onView} />
        {view === 'structured' ? (
          diff.status === 'loading' ? (
            <div className="rounded-xl border border-dashed border-tp-hairline-strong px-4 py-10 text-center text-sm text-tp-slate">
              Comparing versions…
            </div>
          ) : diff.status === 'error' ? (
            <div
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              role="alert"
            >
              The comparison failed: {readApiError(diff.error).message}
            </div>
          ) : diff.data ? (
            <DiffResult
              diff={diff.data}
              filter={filter}
              onFilterChange={setFilter}
              workflow={workflow}
            />
          ) : null
        ) : texts.status === 'loading' ? (
          <div className="rounded-xl border border-dashed border-tp-hairline-strong px-4 py-10 text-center text-sm text-tp-slate">
            Reading the two texts…
          </div>
        ) : texts.status === 'error' ? (
          <div
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            role="alert"
          >
            The texts could not be read: {readApiError(texts.error).message}
          </div>
        ) : texts.data && fromVersion && toVersion ? (
          <section aria-label={`The text of ${fromVersion.label} and ${toVersion.label}`}>
            <FileDiffView
              key={pairKey}
              before={texts.data.before}
              after={texts.data.after}
              beforeLabel={fromVersion.label}
              afterLabel={toVersion.label}
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
