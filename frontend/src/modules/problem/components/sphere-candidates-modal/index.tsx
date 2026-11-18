// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: through OpenBinding's adapted twin (composition-editor/layouts/editor-layout/publish-modal.tsx), the dialog frame
// only (the dimmed layer, the header with its icon and close, the scrolling body and the footer with Cancel and the primary
// action), widened to 64 rem and made a full-screen sheet below 640 px, with a stepper. Its content is OpenBinding's: the six
// steps that turn SPHERE pricings into candidates of a problem (search, version, task and plans, mapping, preview, generate),
// over the gateway's search, version, preview and apply routes. The step and the pricing and version being added are in the
// address (`?sphereStep=&sphere=&sphereVersion=`), as SPHERE keeps a compare in `?cfgA=&cfgB=`; the rest of the form is kept
// for the session. Escape asks before discarding what was entered.

import { motion } from 'framer-motion';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { FiArrowLeft, FiArrowRight, FiCheck, FiX } from 'react-icons/fi';
import { MdCloudDownload } from 'react-icons/md';
import { useSearchParams } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import { isAbortError } from '../../../core/api/http';
import FocusTrapLayer from '../../../core/components/focus-trap-layer';
import { Notice } from '../../../core/components/notice';
import customConfirm from '../../../core/utils/custom-confirm';
import { snapshotYaml, snapshotYamlHref } from '../../../core/utils/sphere/snapshotYaml';
import { useResource } from '../../../core/hooks/useResource';
import { loadModel } from '../../utils/modelLoader';
import {
  useSphereApi,
  type SphereApplied,
  type SphereExpandView,
  type SphereRecipeView,
} from '../../api/sphereApi';
import {
  SPHERE_PARAMS,
  STEP_LABELS,
  STEPS,
  isStep,
  readKept,
  writeKept,
  manualCells,
  type Base,
  type Draft,
  type LoadedVersion,
  type ManualCell,
  type PlanReview,
  type Step,
} from './model';
import PricingSearch from './pricing-search';
import {
  demandProblems,
  emptyForm,
  emptyProperty,
  fromRecipe,
  providerKey,
  serviceOf,
  toRecipe,
  type SourceForm,
  type WizardForm,
} from './recipe';
import { importablePlans, readSummary, type VersionSummary } from './summary';
import MappingStep from './steps/MappingStep';
import PlansStep from './steps/PlansStep';
import PreviewStep from './steps/PreviewStep';
import VersionStep from './steps/VersionStep';

export interface SphereCandidatesModalProps {
  org: string;
  /** The problem the import adds to (its slug, name and latest version); null for a new problem. */
  problem: { slug: string; name: string; latest: number } | null;
  /** Open on the problem's pinned recipe, to update its pricings ("Update from SPHERE"). */
  update?: boolean;
  onClose: () => void;
  /** The import was stored (or was already a version): the problem page takes it from here. */
  onApplied: (applied: SphereApplied) => void;
}

/** A new problem starts with the two features a SPHERE pricing usually fills: its price, and an availability set by hand. */
function newProblemForm(): WizardForm {
  const form = emptyForm();
  return {
    ...form,
    problem: { name: '', slug: '' },
    features: [
      { id: 'subscription', direction: 'minimize', unit: 'USD/month', domain: 'real' },
      { id: 'availability', direction: 'maximize', unit: '', domain: 'ratio' },
    ],
    properties: { subscription: emptyProperty('price'), availability: emptyProperty('manual') },
  };
}

/** An existing problem's features and first service task, from its latest version's facts. */
function formFromFacts(base: Base): WizardForm {
  const form = emptyForm();
  const facts = base.facts;
  if (!facts) return form;
  const task = facts.tasks.find(entry => entry.kind === 'service')?.id ?? '';
  return {
    ...form,
    task,
    capability: task ? `service/${task}` : '',
    service: task ? serviceOf(`service/${task}`) : '',
    features: facts.features.map(feature => ({
      id: feature.id,
      direction: feature.direction === 'max' ? 'maximize' : 'minimize',
      unit: feature.unit === '1' ? '' : feature.unit,
      domain: 'real',
    })),
    properties: Object.fromEntries(
      facts.features.map(feature => [
        feature.id,
        emptyProperty(feature.unit.endsWith('/month') ? 'price' : 'manual'),
      ])
    ),
  };
}

const sheet =
  'flex w-full flex-col overflow-hidden border-tp-hairline bg-tp-canvas shadow-elevation-4 max-sm:h-dvh max-sm:max-h-none sm:max-h-[calc(92dvh-1rem)] sm:max-w-[64rem] sm:rounded-2xl sm:border';

/**
 * "Add candidates from SPHERE": six steps from a SPHERE pricing to a new version of a problem, or to a new problem. The
 * browser never calls SPHERE: the gateway searches it, snapshots each version, previews the recipe and stores what was
 * previewed. Nothing here prices, normalises or decides an eligibility.
 */
export default function SphereCandidatesModal({
  org,
  problem,
  update = false,
  onClose,
  onApplied,
}: SphereCandidatesModalProps) {
  const api = useSphereApi();
  const titleId = useId();
  const [params, setParams] = useSearchParams();
  const scope = `${org}/${problem?.slug ?? '(new)'}${update ? '/update' : ''}`;
  const kept = useRef(readKept(scope));
  // The form as edited; null until the first edit, while it is still what the problem or its recipe seeds.
  const [edited, setForm] = useState<WizardForm | null>(() => kept.current?.form ?? null);
  const [draft, setDraft] = useState<Draft | null>(() => kept.current?.draft ?? null);
  // The source step 3 edits, keyed by the pricing and version it was made for.
  const [edits, setEdits] = useState<{ key: string; source: SourceForm } | null>(null);
  const step: Step = isStep(params.get('sphereStep'))
    ? (params.get('sphereStep') as Step)
    : 'pricing';

  // The problem's latest version and its facts: the tasks and features an import adds to.
  const base = useResource<Base | null>(
    `sphere-base:${org}/${problem?.slug ?? ''}@${problem?.latest ?? 0}`,
    async () => {
      if (!problem) return null;
      const model = await loadModel(org, problem.slug, problem.latest);
      return { revision: problem.latest, facts: model.state === 'ready' ? model.facts : null };
    }
  );
  // The recipe the latest SPHERE import pinned, for an update.
  const pinned = useResource<SphereRecipeView | null>(
    `sphere-recipe:${org}/${problem?.slug ?? ''}@${problem?.latest ?? 0}:${update}`,
    async () => (problem && update ? api.recipe(org, problem.slug) : null)
  );

  // Until it is edited, the form is what the pinned recipe (an update) or the problem's facts say.
  const seed = useMemo<WizardForm>(() => {
    if (!problem) return newProblemForm();
    if (update) return pinned.data ? fromRecipe(pinned.data.recipe) : emptyForm();
    return base.data ? formFromFacts(base.data) : emptyForm();
  }, [problem, update, pinned.data, base.data]);
  const form = edited ?? seed;

  useEffect(() => {
    writeKept(scope, { form, draft });
  }, [scope, form, draft]);

  const go = useCallback(
    (next: Step, extra: Partial<Record<(typeof SPHERE_PARAMS)[number], string | null>> = {}) =>
      setParams(
        current => {
          const out = new URLSearchParams(current);
          out.set('sphereStep', next);
          for (const [key, value] of Object.entries(extra)) {
            if (value) out.set(key, value);
            else out.delete(key);
          }
          return out;
        },
        { replace: true }
      ),
    [setParams]
  );

  // The pricing and version being added follow the address, so a reload lands on the same step.
  const pricingId = params.get('sphere') ?? draft?.pricingId ?? null;
  const registry = draft?.pricingId === pricingId ? (draft?.registry ?? null) : null;
  const manifest = useResource(
    `sphere-manifest:${org}/${registry ?? ''}/${pricingId ?? 'none'}`,
    async () => (pricingId ? api.manifest(org, pricingId, registry) : null)
  );
  const versionId = params.get('sphereVersion') ?? manifest.data?.latestVersionId ?? null;
  const wantsVersion = step === 'plans' && pricingId !== null && versionId !== null;
  const loaded = useResource<LoadedVersion | null>(
    `sphere-version:${org}/${registry ?? ''}/${pricingId ?? ''}/${versionId ?? 'none'}:${wantsVersion}`,
    async () => {
      if (!wantsVersion || !pricingId || !versionId) return null;
      const view = await api.version(org, pricingId, versionId, registry);
      const yaml = await snapshotYaml(
        view.snapshot.yamlHref ?? snapshotYamlHref(org, view.snapshot.id)
      );
      return { view, summary: readSummary(view), yaml };
    }
  );

  // The source step 3 edits: as edited for this pricing and version, else the recipe's own when the pricing is already in it,
  // else a new one with every plan it can import.
  const pendingKey = `${pricingId ?? ''}/${loaded.data?.view.snapshot.versionId ?? ''}`;
  const derived = useMemo<SourceForm | null>(() => {
    if (!loaded.data || !pricingId) return null;
    const { view, summary } = loaded.data;
    const existing = form.sources.find(source => source.pricingId === pricingId);
    const importable = importablePlans(summary);
    return {
      pricingId,
      versionId: view.snapshot.versionId ?? versionId ?? '',
      registry,
      title: view.snapshot.title,
      owner: view.snapshot.owner ?? null,
      versionLabel: view.snapshot.versionLabel ?? summary.version,
      provider: existing?.provider ?? providerKey(manifest.data?.name ?? view.snapshot.title),
      plans: (existing?.plans.length ? existing.plans : importable).filter(plan =>
        importable.includes(plan)
      ),
      addons: existing?.addons ?? [],
      billing: existing?.billing ?? null,
      seats: existing?.seats ?? (summary.plans.some(plan => plan.perSeat) ? 1 : null),
      names: existing?.names ?? {},
      assume: existing?.assume ?? {},
    };
  }, [loaded.data, pricingId, versionId, registry, form.sources, manifest.data]);
  const pending = edits?.key === pendingKey ? edits.source : derived;
  const setPending = (source: SourceForm) => setEdits({ key: pendingKey, source });

  // The summaries of every pricing of the recipe, for the mapping's names and the update's review.
  const summaryKey = form.sources
    .map(source => `${source.registry ?? ''}/${source.pricingId}/${source.versionId}`)
    .join(',');
  const summaries = useResource<Record<string, VersionSummary>>(
    `sphere-summaries:${org}/${summaryKey}`,
    async () => {
      const entries = await Promise.all(
        form.sources.map(async source => {
          const view = await api.version(org, source.pricingId, source.versionId, source.registry);
          return [source.versionId, readSummary(view)] as const;
        })
      );
      return Object.fromEntries(entries);
    }
  );

  // The preview, asked whenever the recipe it previews changes; a newer recipe reads as loading until its answer comes.
  const recipe = useMemo(() => toRecipe(form), [form]);
  const recipeKey = JSON.stringify(recipe);
  const target = problem?.slug ?? form.problem?.slug ?? '';
  const [preview, setPreview] = useState<{ key: string; view: SphereExpandView } | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{ key: string; message: string } | null>(
    null
  );
  const [attempt, setAttempt] = useState(0);
  const baseRevision = base.data?.revision ?? null;
  useEffect(() => {
    if ((step !== 'preview' && step !== 'generate') || !target) return;
    if (preview?.key === recipeKey && attempt === 0) return;
    const controller = new AbortController();
    api
      .expand(
        org,
        target,
        { recipe, base: baseRevision !== null ? { revision: baseRevision } : null },
        controller.signal
      )
      .then(view => {
        setPreview({ key: recipeKey, view });
        setPreviewFailure(null);
        setAttempt(0);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        const read = readApiError(error);
        setPreviewFailure({
          key: recipeKey,
          message:
            read.status === 429 || read.code === 'sphere_busy'
              ? `SPHERE is busy; preview again in ${Math.ceil(read.retryAfter ?? 5)} s.`
              : `The preview couldn’t be made${read.message ? `: ${read.message}` : '.'}`,
        });
      });
    return () => controller.abort();
    // `recipe` is named by `recipeKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, org, target, recipeKey, baseRevision, step, attempt]);
  const expanded = preview?.view ?? null;
  const previewing = preview?.key !== recipeKey && previewFailure?.key !== recipeKey;

  // An update draws, for each provider whose pinned version changes, every plan it keeps before and after.
  const [reviews, setReviews] = useState<PlanReview[]>([]);
  useEffect(() => {
    if (!update || !pinned.data || (step !== 'preview' && step !== 'generate')) return;
    let active = true;
    const before = fromRecipe(pinned.data.recipe).sources;
    void (async () => {
      const found: PlanReview[] = [];
      for (const source of form.sources) {
        const old = before.find(entry => entry.provider === source.provider);
        if (!old || old.versionId === source.versionId) continue;
        try {
          const [oldView, newView] = await Promise.all([
            api.version(org, old.pricingId, old.versionId, old.registry),
            api.version(org, source.pricingId, source.versionId, source.registry),
          ]);
          const [beforeYaml, afterYaml] = await Promise.all([
            snapshotYaml(oldView.snapshot.yamlHref ?? snapshotYamlHref(org, oldView.snapshot.id)),
            snapshotYaml(newView.snapshot.yamlHref ?? snapshotYamlHref(org, newView.snapshot.id)),
          ]);
          const kept = source.plans.length ? source.plans : importablePlans(readSummary(newView));
          const had = new Set(readSummary(oldView).plans.map(plan => plan.id));
          for (const plan of kept.filter(entry => had.has(entry)))
            found.push({
              provider: source.provider,
              title: newView.snapshot.title,
              plan,
              addOns: [],
              beforeLabel: oldView.snapshot.versionLabel ?? '',
              afterLabel: newView.snapshot.versionLabel ?? '',
              before: beforeYaml,
              after: afterYaml,
            });
        } catch {
          // Without both snapshots there is nothing to draw; the Changes above still say what moves.
        }
      }
      if (active) setReviews(found);
    })();
    return () => {
      active = false;
    };
  }, [update, pinned.data, step, form.sources, api, org]);

  const [applying, setApplying] = useState(false);
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);

  const dirty = form.sources.length > 0 || draft !== null;
  const close = () => {
    writeKept(scope, null);
    setParams(
      current => {
        const out = new URLSearchParams(current);
        for (const key of SPHERE_PARAMS) out.delete(key);
        return out;
      },
      { replace: true }
    );
    onClose();
  };
  const askClose = () => {
    if (!dirty) return close();
    void customConfirm('Discard the pricings and choices of this import?', {
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    }).then(close, () => undefined);
  };

  const addPending = () => {
    if (!pending) return;
    const sources = form.sources.some(source => source.pricingId === pending.pricingId)
      ? form.sources.map(source => (source.pricingId === pending.pricingId ? pending : source))
      : [...form.sources, pending];
    setForm({ ...form, sources });
    setDraft(null);
    setEdits(null);
    go('mapping', { sphere: null, sphereVersion: null });
  };

  const fill = (cell: ManualCell, value: number) => {
    const property = form.properties[cell.target] ?? emptyProperty();
    setForm({
      ...form,
      properties: {
        ...form.properties,
        [cell.target]: { ...property, manual: { ...property.manual, [cell.key]: value } },
      },
    });
  };

  const apply = async () => {
    if (!expanded?.packageDigest || !target) return;
    setApplying(true);
    setRefusal(null);
    try {
      const applied = await api.apply(org, target, {
        recipe: expanded.recipe ?? recipe,
        base: baseRevision !== null ? { revision: baseRevision } : null,
        ...(form.problem ? { name: form.problem.name } : {}),
        expect: { packageDigest: expanded.packageDigest },
      });
      writeKept(scope, null);
      onApplied(applied);
    } catch (error) {
      const read = readApiError(error);
      setRefusal({ code: read.code, message: read.message });
    } finally {
      setApplying(false);
    }
  };

  // What each step needs before the next one.
  const plansReady =
    pending !== null &&
    pending.plans.length > 0 &&
    pending.provider !== '' &&
    form.task !== '' &&
    form.capability !== '' &&
    (!form.problem || (form.problem.name.trim() !== '' && form.problem.slug !== '')) &&
    (loaded.data?.summary.billing.some(entry => entry.id === (pending.billing ?? form.billing)) ??
      false);
  const mappingReady =
    form.sources.length > 0 &&
    form.features.length > 0 &&
    demandProblems(form).length === 0 &&
    form.features.every(feature => {
      const property = form.properties[feature.id];
      if (!property) return false;
      if (property.kind === 'limit' || property.kind === 'feature' || property.kind === 'guarantee')
        return property.name !== '';
      if (property.kind === 'constant') return property.constant !== null;
      return true;
    });
  const errors = expanded?.diagnostics.filter(finding => finding.severity === 'error').length ?? 0;
  const manualLeft = expanded ? manualCells(expanded).length : 0;
  const generateReady =
    expanded !== null && !previewing && expanded.valid && errors === 0 && manualLeft === 0;

  const index = STEPS.indexOf(step);
  const back = () => {
    if (index === 0) return;
    if (step === 'mapping' && !draft) return go('pricing');
    go(STEPS[index - 1]);
  };

  const primary: { label: string; enabled: boolean; run: () => void } | null =
    step === 'pricing'
      ? form.sources.length > 0
        ? { label: 'Continue with the recipe', enabled: true, run: () => go('mapping') }
        : null
      : step === 'version'
        ? {
            label: 'Use this version',
            enabled: versionId !== null,
            run: () => go('plans', { sphereVersion: versionId }),
          }
        : step === 'plans'
          ? { label: 'Add to the recipe', enabled: plansReady, run: addPending }
          : step === 'mapping'
            ? { label: 'Preview', enabled: mappingReady, run: () => go('preview') }
            : step === 'preview'
              ? { label: 'Continue', enabled: generateReady, run: () => go('generate') }
              : {
                  label: applying
                    ? 'Generating…'
                    : problem
                      ? 'Generate revision'
                      : 'Create problem',
                  enabled: generateReady && !applying,
                  run: () => void apply(),
                };

  return (
    <FocusTrapLayer onEscape={askClose}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm sm:p-4 sm:pt-[6dvh]"
        role="presentation"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={sheet}
          data-sphere-wizard
        >
          <header className="relative shrink-0 overflow-hidden border-b border-tp-hairline bg-tp-surface px-4 py-3 sm:px-6">
            <div className="relative flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-tp-accent text-tp-on-primary shadow-sm">
                  <MdCloudDownload className="h-[18px] w-[18px]" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2
                    id={titleId}
                    className="font-display text-lg leading-tight font-semibold text-tp-ink"
                  >
                    {update
                      ? 'Update from SPHERE'
                      : problem
                        ? 'Add candidates from SPHERE'
                        : 'New problem from SPHERE'}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-tp-steel">
                    {problem
                      ? `${problem.name} · adds to version ${problem.latest}`
                      : 'The candidates of a new problem, from SPHERE pricings'}
                  </p>
                </div>
              </div>
              <button
                data-autofocus
                type="button"
                onClick={askClose}
                aria-label="Close the SPHERE import"
                className="cursor-pointer rounded-lg p-2 text-tp-steel transition-colors hover:bg-tp-canvas hover:text-tp-ink"
              >
                <FiX className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <ol className="relative mt-3 flex gap-1 overflow-x-auto text-[11px]" aria-label="Steps">
              {STEPS.map((entry, at) => (
                <li
                  key={entry}
                  aria-current={entry === step ? 'step' : undefined}
                  className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 ${entry === step ? 'bg-tp-accent font-semibold text-tp-on-primary' : at < index ? 'bg-tp-primary/10 text-tp-accent' : 'text-tp-steel'}`}
                >
                  <span aria-hidden="true">
                    {at < index ? <FiCheck className="h-3 w-3" /> : at + 1}
                  </span>
                  {STEP_LABELS[entry]}
                </li>
              ))}
            </ol>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            {step === 'pricing' && (
              <div className="flex min-w-0 flex-col gap-4">
                {form.sources.length > 0 && (
                  <section aria-label="Pricings in the recipe" className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-tp-ink">Pricings in the recipe</h3>
                    {form.sources.map(source => (
                      <div
                        key={source.pricingId}
                        className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-tp-hairline px-3 py-2 text-xs"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold [overflow-wrap:anywhere] text-tp-ink">
                            {summaries.data?.[source.versionId]?.title ?? source.title}
                          </span>
                          <span className="text-tp-steel">
                            {`${source.provider} · version ${summaries.data?.[source.versionId]?.version ?? source.versionLabel} · ${source.plans.length ? `${source.plans.length} plans` : 'every plan'}`}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="cursor-pointer rounded-md px-2 py-1 font-medium text-tp-link hover:bg-tp-surface"
                          onClick={() => {
                            setDraft({
                              pricingId: source.pricingId,
                              name: source.title,
                              owner: source.owner,
                              registry: source.registry,
                              versionId: source.versionId,
                            });
                            go('version', {
                              sphere: source.pricingId,
                              sphereVersion: source.versionId,
                            });
                          }}
                        >
                          Change version
                        </button>
                        <button
                          type="button"
                          className="cursor-pointer rounded-md px-2 py-1 font-medium text-tp-link hover:bg-tp-surface"
                          onClick={() =>
                            setForm({
                              ...form,
                              sources: form.sources.filter(entry => entry !== source),
                            })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </section>
                )}
                <PricingSearch
                  org={org}
                  api={api}
                  chosen={null}
                  taken={form.sources.map(source => source.pricingId)}
                  onChoose={chosen => {
                    if (!chosen) return;
                    setDraft({
                      pricingId: chosen.row.pricingId,
                      name: chosen.row.name,
                      owner: chosen.row.owner?.name ?? null,
                      registry: chosen.registry,
                      versionId: null,
                    });
                    setEdits(null);
                    go('version', { sphere: chosen.row.pricingId, sphereVersion: null });
                  }}
                />
              </div>
            )}

            {step === 'version' &&
              (manifest.status === 'error' ? (
                <Notice tone="error">{`The pricing’s versions couldn’t be read${readApiError(manifest.error).message ? `: ${readApiError(manifest.error).message}` : '.'}`}</Notice>
              ) : manifest.data ? (
                <VersionStep
                  manifest={manifest.data}
                  value={versionId}
                  onChange={next => go('version', { sphereVersion: next })}
                />
              ) : (
                <p role="status" className="text-sm text-tp-steel">
                  Reading the pricing’s versions…
                </p>
              ))}

            {step === 'plans' &&
              (loaded.status === 'error' ? (
                <Notice tone="error">{`The version couldn’t be read${readApiError(loaded.error).message ? `: ${readApiError(loaded.error).message}` : '.'}`}</Notice>
              ) : loaded.data && pending ? (
                <PlansStep
                  form={form}
                  onForm={setForm}
                  source={pending}
                  onSource={setPending}
                  loaded={loaded.data}
                  base={base.data ?? null}
                />
              ) : (
                <p role="status" className="text-sm text-tp-steel">
                  Reading the version from the gateway…
                </p>
              ))}

            {step === 'mapping' && (
              <MappingStep
                form={form}
                onForm={setForm}
                summaries={summaries.data ?? {}}
                editableFeatures={problem === null}
              />
            )}

            {step === 'preview' && (
              <div className="flex min-w-0 flex-col gap-3">
                <PreviewStep
                  task={form.task}
                  currency={form.currency}
                  expanded={expanded}
                  loading={previewing}
                  failure={previewFailure?.key === recipeKey ? previewFailure.message : null}
                  onFill={fill}
                  reviews={reviews}
                />
                <button
                  type="button"
                  className="w-fit cursor-pointer text-xs font-medium text-tp-link"
                  onClick={() => go('pricing')}
                >
                  Add another pricing
                </button>
              </div>
            )}

            {step === 'generate' && (
              <div className="flex min-w-0 flex-col gap-3">
                <p className="text-sm text-tp-ink">
                  {problem
                    ? `The previewed package becomes version ${(baseRevision ?? 0) + 1} of ${problem.name}, with every value’s source.`
                    : `The previewed package becomes the first version of the new problem ${form.problem?.name ?? ''}.`}
                </p>
                {expanded && (
                  <ul className="flex flex-col gap-0.5 text-xs text-tp-steel">
                    {expanded.snapshots.map(snapshot => (
                      <li
                        key={snapshot.id}
                      >{`${snapshot.title}, version ${snapshot.versionName ?? '—'}`}</li>
                    ))}
                  </ul>
                )}
                {refusal && (
                  <Notice
                    tone="error"
                    action={
                      refusal.code === 'problem_exists' ? (
                        <button
                          type="button"
                          className="cursor-pointer text-xs font-medium underline"
                          onClick={() => go('plans')}
                        >
                          Choose another name
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cursor-pointer text-xs font-medium underline"
                          onClick={() => {
                            setRefusal(null);
                            if (refusal.code === 'revision_moved') base.reload();
                            setAttempt(value => value + 1);
                          }}
                        >
                          {refusal.code === 'revision_moved'
                            ? 'Reload and preview again'
                            : 'Preview again'}
                        </button>
                      )
                    }
                  >
                    {refusal.code === 'revision_moved'
                      ? 'Another version was added since the preview, so this one would not follow the latest. Reload to preview on it.'
                      : refusal.code === 'sphere_preview_stale'
                        ? 'The pricings no longer generate what the preview showed. Preview again before generating.'
                        : refusal.code === 'problem_exists'
                          ? 'A problem with this address already exists in the organization.'
                          : `The import was refused${refusal.message ? `: ${refusal.message}` : '.'}`}
                  </Notice>
                )}
              </div>
            )}
          </main>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-tp-hairline bg-tp-surface px-4 py-3 sm:px-6">
            <button
              type="button"
              onClick={back}
              disabled={index === 0}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-tp-slate transition-colors hover:bg-tp-canvas hover:text-tp-ink disabled:invisible"
            >
              <FiArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={askClose}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium text-tp-slate transition-colors hover:bg-tp-canvas hover:text-tp-ink"
              >
                Cancel
              </button>
              {primary && (
                <button
                  type="button"
                  onClick={primary.run}
                  disabled={!primary.enabled}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-tp-accent px-4 py-2 text-sm font-semibold text-tp-on-primary transition-all hover:bg-tp-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {primary.label}
                  <FiArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </footer>
        </motion.div>
      </motion.div>
    </FocusTrapLayer>
  );
}
