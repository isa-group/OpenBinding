// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-view/index.tsx (feat/pricing-renderer,
// revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition's configurations are its version's binding and the toolchain's one-task moves of it (the gateway's
// neighbourhood, at most 64), not a pricing's subscriptions. SPHERE's frame is kept: the count chips, a search and a task
// select, the focused configuration with Prev, Next and Surprise me, Quick Browse with infinite scroll, the details modal, and
// the compare tray whose two slots live in the address (`?cfgA=&cfgB=`) and drive an A/B comparison. Below it sits
// OpenBinding's configurator (choose a candidate per task, evaluated), and a configuration can be tried there, derived as a
// version or opened as a draft (MEMBER). pricing-renderer's picker and change review are not brought: a binding is not a
// pricing selection.

import { motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import type { CompositionNeighborhoodResponse, CompositionView } from '../../../core/api/types';
import { CompositionRenderer } from '../../../core/components/composition-renderer/CompositionRenderer';
import {
  analysisRefusal,
  NOT_LINKED,
  type AnalysisActions,
  type AnalysisRefusal,
  type BindingDerivation,
  type WrittenBinding,
} from '../../../core/components/composition-renderer/modes/analysis';
import {
  moveRows,
  rowChoices,
  signed,
  visibleRows,
  writtenBinding,
} from '../../../core/components/composition-renderer/modes/calculatorModel';
import BanterLoader from '../../../core/components/loaders/banter-loader';
import { comparisonText } from '../../../core/utils/binding/comparison';
import type { CompositionViewModel } from '../../../core/utils/composition/viewModel';
import { compositionFragment } from '../../../core/utils/sphere/composition-fragment';
import { DeriveCompositionDialog } from '../../../run/components/derive/DeriveCompositionDialog';
import { bindingDerivation, nextMinor } from '../../../run/components/derive/deriveModel';
import { editorPath } from '../../../../routes/paths/compositions';
import { compositionsApi } from '../../api/compositionsApi';
import ConfigurationDetailsModal from '../configuration-details-modal';
import ConfigurationSpaceItem from '../configuration-space-item';
import CompareTray from './compare-tray';
import { captureLabel, nextSlot, type CompareSide, type CompareSlots } from './compare-slots';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import ConfigurationComparison from './configuration-comparison';
import DemandControls from './demand-controls';
import { configurationsOf, type ExplorerConfiguration } from './configurations';

/** How many moves the toolchain evaluates at most for one look. */
export const NEIGHBOURHOOD_LIMIT = 64;
const BATCH = 40;

type Neighbourhood =
  | { state: 'loading' }
  | { state: 'ready'; response: CompositionNeighborhoodResponse }
  | { state: 'refused'; refusal: AnalysisRefusal };

interface Props {
  org: string;
  composition: CompositionView;
  model: CompositionViewModel;
  /** Derive versions and open drafts: MEMBER. Exploring is open to every reader of the organization. */
  canDerive: boolean;
  /** Where the candidates of the linked problem stand, while they are not ready. */
  candidates?: { status: 'loading' | 'error'; marker: string; retry: () => void } | null;
  /** The gateway says the shown version links no problem after all: the page hides the tab. */
  onNotLinked: () => void;
  /** The reader's role: after a seal, the derive dialog offers adopting where this role may (F4). */
  role?: OrgRole | null;
}

const smallButton =
  'flex cursor-pointer items-center gap-1 rounded-md border border-tp-hairline-strong bg-tp-canvas px-3 py-1.5 text-xs text-tp-slate transition-colors hover:bg-tp-surface disabled:cursor-default disabled:opacity-30';

export default function ConfigurationSpaceView({
  org,
  composition,
  model,
  canDerive,
  candidates = null,
  onNotLinked,
  role = null,
}: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const slug = composition.slug;
  const version = model.version?.id ?? '';
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: Neighbourhood } | null>(null);
  const [search, setSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const [details, setDetails] = useState<ExplorerConfiguration | null>(null);
  const [tried, setTried] = useState<{ binding: WrittenBinding; attempt: number } | null>(null);
  const [deriving, setDeriving] = useState<BindingDerivation | null>(null);
  const [draft, setDraft] = useState<{ busy: boolean; error: string }>({ busy: false, error: '' });
  // The calculator's demand (F4): users typed (asked after a pause) and a revision of the linked problem; nothing is saved.
  const [usersTyped, setUsersTyped] = useState('');
  const [usersAsked, setUsersAsked] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setUsersAsked(usersTyped), 500);
    return () => window.clearTimeout(timer);
  }, [usersTyped]);
  const [demandRevision, setDemandRevision] = useState<number | null>(null);
  const [demandRefusal, setDemandRefusal] = useState<string | null>(null);
  const configurator = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLLIElement>(null);
  const key = `${org}/${slug}/${version}/${attempt}`;
  // The page's answer to a version that links no problem after all; read when the gateway says so.
  const notLinked = useRef(onNotLinked);
  useEffect(() => {
    notLinked.current = onNotLinked;
  });

  const explorable = Boolean(model.version) && model.modes.includes('calculator');
  useEffect(() => {
    if (!version || !explorable) return;
    let active = true;
    compositionsApi.neighborhood(org, slug, { version, limit: NEIGHBOURHOOD_LIMIT }).then(
      response => {
        if (active) setLoaded({ key, value: { state: 'ready', response } });
      },
      (caught: unknown) => {
        if (!active) return;
        const refusal = analysisRefusal(caught, 'The moves couldn’t be evaluated');
        setLoaded({ key, value: { state: 'refused', refusal } });
        if (refusal.notLinked) notLinked.current?.();
      }
    );
    return () => {
      active = false;
    };
  }, [org, slug, version, key, explorable]);

  useEffect(() => {
    if (tried) configurator.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [tried]);

  const neighbourhood: Neighbourhood =
    loaded && loaded.key === key ? loaded.value : { state: 'loading' };
  const rows = useMemo(
    () => (neighbourhood.state === 'ready' ? moveRows(neighbourhood.response.moves, model) : []),
    [neighbourhood, model]
  );
  const base = useMemo(() => writtenBinding(model), [model]);
  const all = useMemo(() => configurationsOf(rows, base), [rows, base]);
  const tasks = useMemo(() => rowChoices(rows).tasks, [rows]);
  const filtered = useMemo(() => {
    const shown = new Set(
      visibleRows(rows, { query: search, task: taskFilter, comparison: '' }).map(
        row => `${row.task}:${row.to}`
      )
    );
    return all.filter(item => (item.move ? shown.has(item.key) : !search.trim() && !taskFilter));
  }, [all, rows, search, taskFilter]);
  const focused = filtered.find(item => item.key === focusedKey) ?? filtered[0] ?? null;
  const activeIdx = focused ? filtered.indexOf(focused) : -1;

  // --- holding configurations for comparison ------------------------------------------------
  // Both slots live in the query string, so a comparison is a link; `replace` keeps the back button leaving the tab.
  const slots: CompareSlots = {
    a: searchParams.get('cfgA') ?? undefined,
    b: searchParams.get('cfgB') ?? undefined,
  };
  const applySlots = useCallback(
    (next: CompareSlots) =>
      setSearchParams(
        previous => {
          const params = new URLSearchParams(previous);
          for (const side of ['a', 'b'] as const) {
            const name = `cfg${side.toUpperCase()}`;
            const held = next[side];
            if (held) params.set(name, held);
            else params.delete(name);
          }
          return params;
        },
        { replace: true }
      ),
    [setSearchParams]
  );
  const hold = (configuration: ExplorerConfiguration) =>
    applySlots({ ...slots, [nextSlot(slots)]: configuration.key });
  const clearSlots = (side?: CompareSide) =>
    applySlots(side ? { ...slots, [side]: undefined } : {});
  const swapSlots = () => applySlots({ a: slots.b, b: slots.a });
  const byKey = (held: string | undefined) => all.find(item => item.key === held) ?? null;
  const heldA = byKey(slots.a);
  const heldB = byKey(slots.b);
  const identical = Boolean(heldA && heldB && heldA.key === heldB.key);

  const quickItems = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;
  useEffect(() => {
    if (!loaderRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore) setVisibleCount(count => count + BATCH);
      },
      { rootMargin: '200px' }
    );
    observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [hasMore]);

  /** The binding as a draft in the Editor: the document `derive` writes for it, not sealed, under the next minor label. */
  const openDraft = async (source: BindingDerivation) => {
    if (draft.busy) return;
    setDraft({ busy: true, error: '' });
    try {
      const answer = await compositionsApi.derive(
        org,
        slug,
        bindingDerivation(source, nextMinor(composition.latest_version?.label), false)
      );
      if ('version' in answer.result) throw new Error('The gateway sealed a preview.');
      void navigate(
        `${editorPath({ source: { org, slug } })}${compositionFragment(answer.result.content)}`
      );
    } catch (caught) {
      const error = readApiError(caught);
      const code = error.status
        ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})`
        : '';
      setDraft({
        busy: false,
        error: `The draft couldn’t be written${code}${error.message ? `: ${error.message}` : '.'}`,
      });
    }
  };

  const revision = model.status.problemRevision;
  const actions: AnalysisActions = {
    onTry: binding => setTried(now => ({ binding, attempt: (now?.attempt ?? 0) + 1 })),
    onNotLinked,
    ...(canDerive
      ? {
          onDerive: setDeriving,
          onOpenDraft: (source: BindingDerivation) => void openDraft(source),
        }
      : {}),
  };

  if (!model.version || !model.modes.includes('calculator')) {
    return (
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-6 text-sm text-tp-steel">
        <p className="font-medium text-tp-ink">Nothing to explore here</p>
        <p className="mt-1">{NOT_LINKED}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full flex-col gap-4 max-sm:pb-28">
      {model.status.compilationDrift && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This version’s values were evaluated on a compilation of the problem other than the one it
          links.
        </p>
      )}

      {/* Kept at the top so the mechanism is visible before anyone scrolls. */}
      {neighbourhood.state === 'ready' && (
        <CompareTray
          slots={slots}
          describe={held => byKey(held)?.label ?? held}
          onClear={clearSlots}
          onSwap={swapSlots}
          identical={identical}
        />
      )}
      {heldA && heldB && !identical && (
        <motion.section
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          aria-label="A compared with B"
          className="rounded-xl border border-tp-hairline bg-tp-canvas p-4"
        >
          <h2 className="mb-2 text-lg font-semibold text-tp-ink">A compared with B</h2>
          <ConfigurationComparison
            org={org}
            slug={slug}
            version={version}
            a={heldA.binding}
            b={heldB.binding}
          />
        </motion.section>
      )}

      {neighbourhood.state === 'loading' && (
        <div className="mt-10 flex flex-col items-center gap-3" role="status">
          <BanterLoader />
          <p className="text-xs text-tp-steel">
            The toolchain is evaluating each candidate a task could take instead…
          </p>
        </div>
      )}
      {neighbourhood.state === 'refused' &&
        (neighbourhood.refusal.notLinked ? (
          <p className="text-sm text-tp-steel">{neighbourhood.refusal.message}</p>
        ) : (
          <div
            role="alert"
            className="flex flex-col items-center justify-center rounded-xl border border-tp-hairline bg-tp-canvas py-16 text-center"
          >
            <p className="text-sm font-medium text-tp-ink">Could not load the configurations</p>
            <p className="mt-1 w-full max-w-125 text-xs text-tp-steel">
              {neighbourhood.refusal.message}
            </p>
            <button
              type="button"
              onClick={() => setAttempt(n => n + 1)}
              className={`${smallButton} mt-3`}
            >
              Retry
            </button>
          </div>
        ))}

      {neighbourhood.state === 'ready' && (
        <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
          {/* Explorer */}
          <motion.section
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
            aria-label="Configuration explorer"
            className="min-w-0 rounded-xl border border-tp-hairline bg-tp-canvas p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-tp-ink">Configuration explorer</h2>
                <p className="text-xs text-tp-steel">{neighbourhood.response.conclusion}</p>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-tp-steel">
                <span className="rounded-full bg-tp-surface px-2 py-0.5">
                  Loaded {all.length.toLocaleString('en')}
                </span>
                <span className="rounded-full bg-tp-surface px-2 py-0.5">
                  Total {(neighbourhood.response.coverage.total + 1).toLocaleString('en')}
                </span>
                <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-tp-accent">
                  Visible {filtered.length.toLocaleString('en')}
                </span>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[1fr_200px]">
              <label className="rounded-lg border border-tp-hairline-strong bg-tp-canvas p-3">
                <span className="mb-1 block text-[10px] font-medium tracking-wider text-tp-steel uppercase">
                  Search
                </span>
                <input
                  type="search"
                  className="w-full bg-transparent text-sm text-tp-ink placeholder-tp-muted outline-none"
                  value={search}
                  onChange={event => {
                    setSearch(event.target.value);
                    setFocusedKey(null);
                  }}
                  placeholder="Candidate or provider"
                />
              </label>
              <label className="rounded-lg border border-tp-hairline-strong bg-tp-canvas p-3">
                <span className="mb-1 block text-[10px] font-medium tracking-wider text-tp-steel uppercase">
                  Task
                </span>
                <select
                  value={taskFilter}
                  onChange={event => {
                    setTaskFilter(event.target.value);
                    setFocusedKey(null);
                  }}
                  className="w-full cursor-pointer bg-transparent text-sm text-tp-ink outline-none"
                >
                  <option value="">All tasks</option>
                  {tasks.map(task => (
                    <option key={task} value={task}>
                      {task}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-4 rounded-xl border border-tp-hairline bg-tp-surface p-4">
              {focused ? (
                <motion.div
                  key={focused.key}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  aria-label="Current selection"
                  role="group"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium tracking-wider text-tp-steel uppercase">
                        Current selection
                      </p>
                      <h3 className="mt-0.5 font-mono text-base font-semibold break-all text-tp-ink">
                        {focused.label}
                      </h3>
                    </div>
                    <span className="rounded-full border border-tp-hairline bg-tp-canvas px-2 py-0.5 text-[11px] text-tp-steel">
                      #{Math.max(activeIdx + 1, 0)} of {filtered.length.toLocaleString('en')}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {(
                      [
                        [
                          'Comparison',
                          focused.move
                            ? comparisonText(focused.move.comparisonSent).label
                            : 'As sealed',
                        ],
                        [
                          'Holds',
                          focused.move ? (focused.move.feasible ? 'Yes' : 'No') : 'As evaluated',
                        ],
                        ['Penalty change', focused.move ? signed(focused.move.penaltyDelta) : '0'],
                      ] as const
                    ).map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2"
                      >
                        <p className="text-[11px] text-tp-steel">{label}</p>
                        <p className="text-sm font-semibold text-tp-ink">{value}</p>
                      </div>
                    ))}
                  </div>
                  {focused.move && focused.move.violations.length > 0 && (
                    <ul
                      className="mt-2 list-disc pl-5 text-xs text-red-800"
                      aria-label="Rules it breaks"
                    >
                      {focused.move.violations.map(violation => (
                        <li key={violation}>{violation}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => hold(focused)} className={smallButton}>
                      {captureLabel(slots)}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetails(focused)}
                      className={smallButton}
                    >
                      Details
                    </button>
                    {focused.move && (
                      <button
                        type="button"
                        onClick={() => actions.onTry?.(focused.binding)}
                        className={smallButton}
                      >
                        Try in the configurator
                      </button>
                    )}
                    {focused.move && actions.onDerive && revision && (
                      <button
                        type="button"
                        onClick={() => actions.onDerive?.({ revision, binding: focused.binding })}
                        className={smallButton}
                      >
                        Derive as a version
                      </button>
                    )}
                    {focused.move && actions.onOpenDraft && revision && (
                      <button
                        type="button"
                        onClick={() =>
                          actions.onOpenDraft?.({ revision, binding: focused.binding })
                        }
                        className={smallButton}
                      >
                        Open as a draft
                      </button>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="rounded-lg border border-dashed border-tp-hairline-strong p-6 text-center text-xs text-tp-steel"
                >
                  No configurations match this search.
                </motion.div>
              )}
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => activeIdx > 0 && setFocusedKey(filtered[activeIdx - 1].key)}
                  disabled={activeIdx <= 0}
                  className={smallButton}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  onClick={() =>
                    activeIdx < filtered.length - 1 && setFocusedKey(filtered[activeIdx + 1].key)
                  }
                  disabled={activeIdx < 0 || activeIdx >= filtered.length - 1}
                  className={smallButton}
                >
                  Next →
                </button>
                <button
                  type="button"
                  onClick={() =>
                    filtered.length > 0 &&
                    setFocusedKey(filtered[Math.floor(Math.random() * filtered.length)].key)
                  }
                  disabled={filtered.length === 0}
                  className="ml-auto flex cursor-pointer items-center gap-1 rounded-md bg-tp-accent px-3 py-1.5 text-xs font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:opacity-50"
                >
                  <span aria-hidden="true">🎲</span> Surprise me
                </button>
              </div>
              {draft.busy && (
                <p className="mt-2 text-xs text-tp-steel" role="status">
                  Writing the draft…
                </p>
              )}
              {draft.error && (
                <p className="mt-2 text-xs text-red-800" role="alert">
                  {draft.error}
                </p>
              )}
            </div>
          </motion.section>

          {/* Quick browse */}
          <motion.section
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
            aria-label="Quick browse"
            className="rounded-xl border border-tp-hairline bg-tp-canvas p-3"
          >
            <h3 className="text-xs font-medium text-tp-steel">Quick Browse</h3>
            <p className="mt-0.5 text-[11px] text-tp-steel">Scroll to load more configurations.</p>
            <p className="mt-2 text-[11px] text-tp-steel">
              {`Evaluated ${neighbourhood.response.coverage.evaluated} of ${neighbourhood.response.coverage.total} moves (up to ${neighbourhood.response.coverage.limit}) on the installed toolchain.`}
              {neighbourhood.response.coverage.complete
                ? ''
                : ' Coverage is incomplete: moves left unchecked may change the picture.'}
              {neighbourhood.response.failures.length > 0
                ? ` ${neighbourhood.response.failures.length} could not be evaluated.`
                : ''}
            </p>
            <ul className="mt-3 max-h-[66vh] space-y-1.5 overflow-y-auto overscroll-contain pr-1">
              {quickItems.map((item, index) => (
                <ConfigurationSpaceItem
                  key={item.key}
                  configuration={item}
                  index={index + 1}
                  active={focused?.key === item.key}
                  onFocus={() => setFocusedKey(item.key)}
                  onDetails={() => setDetails(item)}
                  onCapture={() => hold(item)}
                  captureText={captureLabel(slots)}
                />
              ))}
              {filtered.length === 0 && (
                <li className="rounded-lg border border-dashed border-tp-hairline-strong p-4 text-center text-[11px] text-tp-steel">
                  No results.
                </li>
              )}
              <li ref={loaderRef} className="mt-4 flex min-h-8 items-center justify-center">
                <p className="text-[11px] text-tp-steel">
                  {hasMore ? 'Scroll to load more' : 'All visible'}
                </p>
              </li>
            </ul>
          </motion.section>
        </div>
      )}

      {model.status.problemRevision && (
        <DemandControls
          org={org}
          problemRef={model.status.problemRevision}
          users={usersTyped}
          onUsers={setUsersTyped}
          revision={demandRevision}
          onRevision={value => {
            setDemandRevision(value);
            setDemandRefusal(null);
          }}
          refusal={demandRefusal}
        />
      )}

      <div ref={configurator} className="rounded-xl border border-tp-hairline bg-tp-canvas p-4">
        {candidates?.status === 'loading' && (
          <p className="text-xs text-tp-steel" role="status">
            Loading the candidates of the linked problem…
          </p>
        )}
        {candidates?.status === 'error' && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {`The candidates of the linked problem couldn’t be loaded${candidates.marker}.`}
            <button type="button" onClick={candidates.retry} className={smallButton}>
              Retry
            </button>
          </div>
        )}
        <CompositionRenderer
          key={tried?.attempt ?? 0}
          model={model}
          mode="configurator"
          analysis={{
            ...actions,
            start: tried?.binding,
            demand: {
              ...(/^[1-9]\d{0,9}$/.test(usersAsked) ? { users: Math.trunc(+usersAsked) } : {}),
              ...(demandRevision !== null ? { revision: demandRevision } : {}),
            },
            onDemandRefused: message => {
              setDemandRevision(null);
              setDemandRefusal(message);
            },
          }}
        />
      </div>

      {details && (
        <ConfigurationDetailsModal configuration={details} onClose={() => setDetails(null)} />
      )}
      {deriving && (
        <DeriveCompositionDialog
          org={org}
          source={{ ...deriving, composition }}
          onClose={() => setDeriving(null)}
          role={role}
        />
      )}
    </div>
  );
}
