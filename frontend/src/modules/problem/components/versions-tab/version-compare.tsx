// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-version-diff/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: two problem versions instead of two pricings. The Base / Compared with selects, the swap and the Structured |
// File toggle are SPHERE's. Structured: OpenBinding's categories (Providers, Tasks, Rules, Goal) are the summary tiles that
// count the changes and filter them, then the sizes of the two binding spaces and the rows side by side, from the facts of
// each version's compilation (`diffRevisions`). File: SPHERE's file view (the composition module's) over a file of the two
// packages, `instance.json` first. The pair, the view, the category and the file live in the address.

import type { IconType } from 'react-icons';
import { FiCode, FiList, FiRepeat } from 'react-icons/fi';
import { Link, useSearchParams } from 'react-router-dom';
import { problemsApi } from '../../api/problemsApi';
import { parseBindingSpace } from '../../../core/components/binding-space-badge/bindingSpace';
import FileDiffView from '../../../composition/components/version-diff/file-diff-view';
import { readApiError } from '../../../core/api/errors';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { useCopy } from '../../../core/hooks/useCopy';
import { problemPath } from '../../../../routes/paths/problems';
import { useResource } from '../../../core/hooks/useResource';
import { useLoadedMap } from '../../hooks/useLoadedMap';
import type { ProblemContent } from '../../types';
import { loadModel } from '../../utils/modelLoader';
import {
  DIFF_CATEGORIES,
  diffRevisions,
  diffSummary,
  powerText,
  type DiffCategory,
  type DiffRow,
  type RevisionView,
} from '../../utils/problemsModel';
import { readZipArchive } from '../../utils/zipExplorer';

const numberOf = (value: string | null): number | null => {
  const parsed = value === null ? NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

type ViewMode = 'structured' | 'file';

const ROOT_FILE = 'instance.json';

/** The files of a package, by path, with their text read on demand. */
async function packageTexts(
  org: string,
  problem: string,
  revision: number
): Promise<Map<string, () => Promise<string>>> {
  const archive = await readZipArchive(await problemsApi.source(org, problem, revision));
  return new Map(
    archive.entries
      .filter(entry => !entry.dir)
      .map(entry => [entry.path, () => entry.readText()] as const)
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

/** A count that doubles as a filter: pressing it keeps only that category's rows (SPHERE's SummaryTile). */
function SummaryTile({
  label,
  count,
  unknown,
  active,
  onToggle,
}: {
  label: string;
  count: number;
  unknown: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  const changed = count > 0;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border px-4 py-3 text-left transition-all hover:shadow-sm focus-visible:ring-2 focus-visible:ring-tp-primary focus-visible:outline-none ${
        changed ? 'border-amber-200 bg-amber-50' : 'border-tp-hairline bg-tp-canvas'
      } ${active ? 'ring-2 ring-tp-primary ring-offset-2' : ''}`}
    >
      <span className="text-sm text-tp-slate">{label}</span>
      <b
        className={`text-2xl leading-none font-semibold tabular-nums ${changed ? 'text-amber-800' : 'text-tp-ink'}`}
      >
        {unknown ? '—' : count}
      </b>
      <em className="text-[11px] text-tp-steel not-italic">
        {unknown ? 'not compared' : changed ? 'changed' : 'no change'}
      </em>
    </button>
  );
}

/** The comparison of two problem versions: the pair is `from` and `to` in the address (the previous version and the latest by default). */
export default function VersionCompare({ org, content }: { org: string; content: ProblemContent }) {
  const { item, revisions } = content;
  const [params, setParams] = useSearchParams();
  const { copy, status } = useCopy();
  const latest = revisions[0]?.revision;
  const older = revisions[1]?.revision;
  const fromNumber = numberOf(params.get('from')) ?? older ?? latest;
  const toNumber = numberOf(params.get('to')) ?? latest;
  const category = (params.get('only') ?? '') as DiffCategory | '';
  const view: ViewMode = params.get('diff') === 'file' ? 'file' : 'structured';
  const from = revisions.find(revision => revision.revision === fromNumber);
  const to = revisions.find(revision => revision.revision === toNumber);

  const update = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setParams(merged, { replace: true });
  };

  const pair = [from, to]
    .filter(revision => revision !== undefined)
    .map(revision => String(revision.revision));
  const models = useLoadedMap(view === 'structured' ? pair : [], key =>
    loadModel(org, item.slug, key)
  );
  const modelOf = (revision: typeof from): RevisionView | null => {
    if (!revision) return null;
    const answer = models[String(revision.revision)];
    if (!answer || answer.status === 'loading') return null;
    const state = answer.status === 'ready' ? answer.value : undefined;
    return {
      revision: revision.revision,
      digest: revision.package_digest,
      facts: state?.state === 'ready' ? state.facts : null,
    };
  };
  const left = modelOf(from);
  const right = modelOf(to);

  const same = fromNumber !== undefined && fromNumber === toNumber;
  const missingSide = fromNumber !== undefined && toNumber !== undefined && (!from || !to);
  const rows: DiffRow[] = left && right && !same ? diffRevisions(left, right) : [];
  const changedIn = (name: DiffCategory | '') =>
    rows.filter(row => (!name || row.category === name) && row.changed).length;
  const hasRowsIn = (name: DiffCategory) => rows.some(row => row.category === name);
  const visible = rows.filter(row => !category || row.category === category);
  const waitingModels =
    !missingSide && !same && from !== undefined && to !== undefined && (!left || !right);
  const modelsMissing = left && right && (!left.facts || !right.facts);

  // The file view reads both packages, then the file chosen (instance.json first) from each.
  const filePair =
    view === 'file' && from && to && !same ? `${from.revision}..${to.revision}` : 'none';
  const packages = useResource(`problem-packages:${org}/${item.slug}/${filePair}`, async () =>
    from && to && filePair !== 'none'
      ? Promise.all([
          packageTexts(org, item.slug, from.revision),
          packageTexts(org, item.slug, to.revision),
        ])
      : null
  );
  const files = packages.data
    ? [...new Set([...packages.data[0].keys(), ...packages.data[1].keys()])].sort((a, b) =>
        a === ROOT_FILE ? -1 : b === ROOT_FILE ? 1 : a.localeCompare(b)
      )
    : [];
  const file = files.includes(params.get('file') ?? '') ? params.get('file')! : files[0];
  const texts = useResource(
    `problem-package-texts:${org}/${item.slug}/${filePair}/${file ?? ''}:${packages.data ? 'read' : 'wait'}`,
    async () => {
      if (!packages.data || !file) return null;
      const [before, after] = await Promise.all([
        packages.data[0].get(file)?.() ?? Promise.resolve(''),
        packages.data[1].get(file)?.() ?? Promise.resolve(''),
      ]);
      return { before, after };
    }
  );

  const selectClass =
    'h-10 w-full cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 text-sm font-medium text-tp-ink outline-none transition-colors focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/10';
  const labelClass = 'mb-1.5 block text-sm font-medium text-tp-slate';
  const options = revisions.map(revision => revision.revision).sort((a, b) => b - a);
  const bar = (space: string | null | undefined) =>
    `${Math.min(100, Math.round((parseBindingSpace(space ?? '1').log10 / 20) * 100))}%`;

  return (
    <section
      aria-labelledby="cc-title"
      className="space-y-6 rounded-2xl border border-tp-hairline bg-tp-canvas p-5 shadow-sm sm:p-6"
    >
      <h2 id="cc-title" className="sr-only">
        Compare versions
      </h2>
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <label className="block">
          <span className={labelClass}>Base version</span>
          <select
            value={fromNumber ?? ''}
            onChange={event => update({ from: event.target.value })}
            className={selectClass}
          >
            {options.map(number => (
              <option key={number} value={number}>
                Version {number}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          title="Swap versions"
          aria-label="Swap versions"
          onClick={() => update({ from: String(toNumber ?? ''), to: String(fromNumber ?? '') })}
          className="mx-auto flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-tp-hairline-strong bg-tp-canvas text-tp-slate transition-colors hover:border-tp-primary/40 hover:text-tp-accent"
        >
          <FiRepeat className="h-4 w-4" aria-hidden="true" />
        </button>
        <label className="block">
          <span className={labelClass}>Compared with</span>
          <select
            value={toNumber ?? ''}
            onChange={event => update({ to: event.target.value })}
            className={selectClass}
          >
            {options.map(number => (
              <option key={number} value={number}>
                Version {number}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-6 border-t border-tp-hairline pt-6">
        <ViewToggle
          value={view}
          onChange={mode => update({ diff: mode === 'file' ? 'file' : '' })}
        />

        {missingSide && (
          <Notice tone="error">
            One of these versions doesn’t exist (404). Pick another pair.
          </Notice>
        )}
        {same && (
          <p className="rounded-xl border border-dashed border-tp-hairline-strong px-4 py-10 text-center text-sm text-tp-slate">
            Both sides are the same version, so there’s nothing to compare. Choose two different
            versions.
          </p>
        )}

        {view === 'structured' && waitingModels && (
          <div role="status" aria-busy="true">
            <span className="sr-only">Reading both versions…</span>
            <Skeleton variant="card" />
          </div>
        )}

        {view === 'structured' && left && right && !same && !missingSide && (
          <>
            {modelsMissing && (
              <Notice tone="info">
                Providers, tasks, rules and goal are compared from the compilation of each version,
                and {!left.facts ? `version ${left.revision}` : `version ${right.revision}`} has
                none that can be read.
                {left.digest === right.digest
                  ? ' Both versions are the same package.'
                  : ' The two packages differ.'}
              </Notice>
            )}
            <section aria-label="Summary" className="grid gap-3 sm:grid-cols-5">
              {(['', ...DIFF_CATEGORIES] as const).map(name => (
                <SummaryTile
                  key={name || 'all'}
                  label={name === '' ? 'All changes' : name}
                  count={changedIn(name)}
                  unknown={name !== '' && !hasRowsIn(name)}
                  active={category === name}
                  onToggle={() => update({ only: name })}
                />
              ))}
            </section>

            {left.facts && right.facts && (
              <section aria-labelledby="cc-size" className="flex flex-col gap-2">
                <h3 id="cc-size" className="text-base font-semibold text-tp-ink">
                  Possible combinations
                </h3>
                {[left, right].map((side, index) => (
                  <div
                    key={side.revision}
                    className="grid grid-cols-[6rem_minmax(0,1fr)_5rem] items-center gap-3 text-xs text-tp-slate"
                  >
                    <span>Version {side.revision}</span>
                    <span
                      className="block h-1.5 overflow-hidden rounded-full bg-tp-hairline-soft"
                      aria-hidden="true"
                    >
                      <i
                        className={`block h-full rounded-full ${index === 0 ? 'bg-tp-steel' : 'bg-tp-primary'}`}
                        style={{ width: bar(side.facts?.binding_space) }}
                      />
                    </span>
                    <span>≈ {powerText(side.facts?.binding_space)}</span>
                  </div>
                ))}
                <span className="text-xs text-tp-steel">
                  {powerText(left.facts.binding_space)} → {powerText(right.facts.binding_space)}
                </span>
              </section>
            )}

            <section aria-labelledby="cc-table" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="cc-table" className="text-base font-semibold text-tp-ink">
                  Side by side
                </h3>
                <Action
                  variant="secondary"
                  size="sm"
                  onClick={() => void copy(diffSummary(item.slug, left, right, rows), 'summary')}
                >
                  {status('summary') === 'copied'
                    ? 'Summary copied'
                    : status('summary') === 'failed'
                      ? 'Copy failed'
                      : 'Copy summary'}
                </Action>
              </div>
              <DataTable label="Side by side" minWidth={560}>
                <thead>
                  <tr>
                    <th scope="col">What</th>
                    <th scope="col">Version {left.revision}</th>
                    <th scope="col">Version {right.revision}</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(row => (
                    <tr
                      key={`${row.category}/${row.what}`}
                      className={row.changed ? 'bg-amber-50/60' : undefined}
                    >
                      <th scope="row" className="normal-case">
                        <small className="block text-[10px] text-tp-steel">{row.category}</small>
                        <span className="text-sm font-normal tracking-normal text-tp-ink">
                          {row.what}
                        </span>
                      </th>
                      <td>{row.a}</td>
                      <td>{row.b}</td>
                      <td>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${row.changed ? 'bg-amber-100 text-amber-900' : 'bg-tp-surface text-tp-slate'}`}
                        >
                          {row.changed ? 'Changed' : 'Same'}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={4}>Nothing to compare in this category.</td>
                    </tr>
                  )}
                </tbody>
              </DataTable>
              <Link
                to={problemPath(org, item.slug, undefined, { version: right.revision })}
                className="cursor-pointer self-start text-xs font-medium text-tp-accent hover:underline"
              >
                Open version {right.revision}
              </Link>
            </section>
          </>
        )}

        {view === 'file' && !same && !missingSide && (
          <>
            {packages.status === 'loading' && (
              <p className="rounded-xl border border-dashed border-tp-hairline-strong px-4 py-10 text-center text-sm text-tp-slate">
                Reading the two packages…
              </p>
            )}
            {packages.status === 'error' && (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              >
                The packages could not be read: {readApiError(packages.error).message}
              </p>
            )}
            {files.length > 0 && (
              <label className="block max-w-[24rem]">
                <span className={labelClass}>File</span>
                <select
                  aria-label="File"
                  value={file}
                  onChange={event => update({ file: event.target.value })}
                  className={selectClass}
                >
                  {files.map(path => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {texts.data && from && to && (
              <section
                aria-label={`${file} of version ${from.revision} and version ${to.revision}`}
              >
                <FileDiffView
                  key={`${filePair}/${file}`}
                  before={texts.data.before}
                  after={texts.data.after}
                  beforeLabel={`Version ${from.revision} · ${file}`}
                  afterLabel={`Version ${to.revision} · ${file}`}
                />
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
