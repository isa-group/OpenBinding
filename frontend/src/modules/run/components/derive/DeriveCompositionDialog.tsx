// Pattern only, after SPHERE frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's derivation (where the version goes, which solution under which label, the previewed document
// sealed as previewed) drawn on SPHERE's fork modal recipe: the steps, labelled fields, a red refusal box and the
// right-aligned secondary and primary buttons, in OpenBinding's modal (a focus trap and Escape). Into a composition with an
// environment the reader may adopt in, the preview also offers "Adopt in <environment> in the same step": a
// `derive_and_adopt` proposal (F6), shown on its proposal card in the same modal and applied only when confirmed.

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { MdWarningAmber } from 'react-icons/md';
import { SourceView } from '../rendering/SourceView';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { FormField } from '../../../core/components/form-field';
import { Modal } from '../../../core/components/modal';
import { Notice } from '../../../core/components/notice';
import { compositionsApi } from '../../../core/utils/composition/api';
import type { Kind } from '../../../core/utils/composition/document';
import { KIND_OPTIONS } from '../../../core/utils/composition/kinds';
import { formatValue } from '../../../core/utils/composition/values';
import { COMPOSITION_FILE } from '../../../core/utils/composition/viewModel';
import { compositionPath, editorPath } from '../../../../routes/paths/compositions';
import { readApiError } from '../../../core/api/errors';
import { latestOffering, OfferingUnreadable, offeringUnreadableText } from './latestOffering';
import type {
  CompositionDerive,
  CompositionEnvironmentView,
  CompositionView,
  DeriveDraft,
  DeriveResult,
  ProposalView,
} from '../../../core/api/types';
import { fromC2y } from '../../../core/diagnostics/located';
import { SLUG_PATTERN, slugFromName } from '../../../core/utils/slug';
import { compositionFragment } from '../../../core/utils/sphere/composition-fragment';
import { formatNumber } from '../../../core/utils/format';
import ProblemsPanel from '../../../core/components/problems-panel';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { DeriveBatch, type DerivedPoint } from './DeriveBatch';
import {
  FIRST_LABEL,
  LABEL_PATTERN,
  bindingDerivation,
  criteriaOf,
  isPointsSource,
  isRunSource,
  nextMinor,
  pointsOf,
  previewValues,
  runDerivation,
  type BindingSource,
  type DeriveSource,
  type Point,
  type SingleSource,
} from './deriveModel';
import { refusalOf, type Refusal } from './refusal';
import { useProposalsApi } from '../../../composition/api/proposalsApi';
import ProposalPanel from '../../../composition/components/proposals-section/ProposalPanel';
import { roleAtLeast } from '../../../composition/hooks/useCompositionRole';
import { useResource } from '../../../core/hooks/useResource';
import type { OrgRole } from '../../../organization/api/organizationsApi';

type Step = 'where' | 'what' | 'preview';

const STEPS: ReadonlyArray<{ id: Step; label: string }> = [
  { id: 'where', label: 'Where' },
  { id: 'what', label: 'What' },
  { id: 'preview', label: 'Preview and seal' },
];

const NAME_MAX = 160;

const FORM = 'flex min-w-0 flex-col gap-3';
const MUTED = 'm-0 text-[13px] [overflow-wrap:anywhere] text-tp-steel';
const RADIO = 'inline-flex min-h-6 cursor-pointer items-center gap-2 text-sm';
const ACTIONS = 'mt-1 flex flex-wrap justify-end gap-2';

type Compositions =
  | { status: 'loading' }
  | { status: 'ready'; list: CompositionView[] }
  | { status: 'failed'; message: string };

const isSealed = (result: DeriveResult | DeriveDraft): result is DeriveResult =>
  'version' in result;

function scoreText(score: Point['score']): string {
  if (score === null) return '—';
  if (Array.isArray(score))
    return score.map(item => (item === null ? '—' : formatNumber(item, 4))).join(', ');
  return formatNumber(score, 4);
}

/** The solutions of the run as its result gives them, one radio each: no order but the result's, no ranking. */
function PointTable({
  points,
  chosen,
  onChoose,
}: {
  points: Point[];
  chosen: number;
  onChoose: (point: number) => void;
}) {
  const criteria = criteriaOf(points);
  return (
    <DataTable label="Solutions of the run" minWidth={360}>
      <thead>
        <tr>
          <th scope="col">Solution</th>
          {criteria.map(criterion => (
            <th key={criterion} scope="col">
              {criterion}
            </th>
          ))}
          <th scope="col">Score</th>
        </tr>
      </thead>
      <tbody>
        {points.map(point => (
          <tr key={point.point} aria-current={point.point === chosen ? 'true' : undefined}>
            <th scope="row">
              <label className="inline-flex min-h-6 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="dc-point"
                  checked={point.point === chosen}
                  onChange={() => onChoose(point.point)}
                />
                {point.label}
              </label>
            </th>
            {criteria.map(criterion => {
              const value =
                point.objectives.find(objective => objective.criterion === criterion)?.value ??
                null;
              return (
                <td key={criterion} className="whitespace-nowrap tabular-nums">
                  {value === null ? '—' : formatNumber(value, 4)}
                </td>
              );
            })}
            <td className="whitespace-nowrap tabular-nums">{scoreText(point.score)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function RefusalNotice({ refusal }: { refusal: Refusal }) {
  return (
    <div
      className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800"
      role="alert"
    >
      <MdWarningAmber aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="m-0">{refusal.message}</p>
        {refusal.findings.length > 0 && (
          <ul
            aria-label="What the gateway found"
            className="mt-1 list-disc pl-5 [overflow-wrap:anywhere]"
          >
            {refusal.findings.map((finding, index) => (
              <li key={`${finding.code}-${finding.pointer ?? ''}-${index}`}>
                {finding.message}
                {finding.pointer && (
                  <>
                    {' '}
                    <code className="font-mono">{finding.pointer}</code>
                  </>
                )}{' '}
                <code className="font-mono">{finding.code}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The binding a derivation writes, task by task, as the calculator or the configurator chose it. */
function BindingTable({ source }: { source: BindingSource }) {
  const tasks = Object.entries(source.binding);
  return (
    <DataTable
      label="Binding to derive"
      minWidth={0}
      caption={
        <>
          On problem version <code className="font-mono">{source.revision}</code>. Local tasks stay
          local.
        </>
      }
    >
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Candidate</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map(([task, candidate]) => (
          <tr key={task}>
            <th scope="row">
              <code className="font-mono text-xs">{task}</code>
            </th>
            <td>
              <code className="font-mono text-xs">{candidate}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

export interface DeriveCompositionDialogProps {
  /** The organization of the run or of the problem version; the compositions are its own. */
  org: string;
  /**
   * What is derived: a run and its solutions, or a binding of a problem version (with the composition it goes to by default,
   * which then opens on the label step), or the points of a study front, one new composition each (batch mode).
   */
  source: DeriveSource;
  onClose: () => void;
  /** Batch mode: called each time a point's composition holds the point as its version 1.0.0. */
  onDerived?: (key: string, derived: DerivedPoint) => void;
  /**
   * The reader's role in the organization: given, a derivation into a composition with an environment it may adopt in
   * offers "Adopt in <environment> in the same step", a proposal the reader confirms here (F6); sealing alone opens the
   * versions, as without it.
   */
  role?: OrgRole | null;
}

/**
 * Derive compositions: one from a run or a binding of a problem version, previewed before it is sealed; or, for the points of a
 * study front, one new composition per point, each sealed as 1.0.0 in turn (batch mode).
 */
export function DeriveCompositionDialog({
  org,
  source,
  onClose,
  onDerived,
  role,
}: DeriveCompositionDialogProps) {
  if (isPointsSource(source))
    return <DeriveBatch org={org} points={source.points} onClose={onClose} onDerived={onDerived} />;
  return <DeriveOne org={org} source={source} onClose={onClose} role={role} />;
}

/** Derive and adopt in one step: a `derive_and_adopt` proposal of the previewed request, for the reader to confirm. */
function ProposeButton({
  org,
  slug,
  request,
  environment,
  disabled,
  onBusy,
  onRefused,
  onProposed,
}: {
  org: string;
  slug: string;
  request: CompositionDerive;
  environment: CompositionEnvironmentView;
  disabled: boolean;
  onBusy: (working: boolean) => void;
  onRefused: (caught: unknown) => void;
  onProposed: (proposal: ProposalView) => void;
}) {
  const api = useProposalsApi();
  const [working, setWorking] = useState(false);
  const propose = async () => {
    if (working) return;
    setWorking(true);
    onBusy(true);
    try {
      onProposed(
        await api.create(org, slug, {
          kind: 'derive_and_adopt',
          source:
            request.run !== undefined && request.run !== null
              ? { run: request.run, point: request.point ?? 0 }
              : { revision: request.revision ?? '', binding: { ...(request.binding ?? {}) } },
          label: request.version,
          environment: environment.slug,
          note: '',
          ...(request.offering ? { offering: request.offering } : {}),
        })
      );
    } catch (caught) {
      onRefused(caught);
    } finally {
      setWorking(false);
      onBusy(false);
    }
  };
  return (
    <Action variant="primary" busy={working} disabled={disabled} onClick={() => void propose()}>
      {`Propose sealing and adopting ${request.version}`}
    </Action>
  );
}

/**
 * Derive a composition from a run or from a binding of a problem version (§4 derive): where the version goes (a composition of the
 * organization, or a new one, created when the preview is asked for), which solution (of a run) and under which label, then the
 * document the gateway writes, previewed before it is sealed. A preview and a seal send the same request but `seal`, so the sealed
 * bytes are the previewed ones (F1 D15). The preview can also open in the Editor as a draft. A binding derived into a given
 * composition starts at the label step, with the next minor of that composition's latest label. Deriving and adopting in one
 * step is a proposal whose seal step stores the same document, checked again when the reader confirms it.
 */
function DeriveOne({
  org,
  source,
  onClose,
  role,
}: {
  org: string;
  source: SingleSource;
  onClose: () => void;
  role?: OrgRole | null;
}) {
  const navigate = useNavigate();
  const ids = useId();
  const run = isRunSource(source) ? source : null;
  const bound = isRunSource(source) ? null : source;
  const from = run ? 'run' : 'binding';
  const into = bound?.composition ?? null;
  const points = run ? pointsOf(run.solutions) : [];

  const [step, setStep] = useState<Step>(into ? 'what' : 'where');
  // Seal only (''), or seal and adopt in this environment (its slug) in one proposal the reader confirms here.
  const [adoptIn, setAdoptIn] = useState('');
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [compositions, setCompositions] = useState<Compositions>({ status: 'loading' });
  const [mode, setMode] = useState<'new' | 'existing'>(into ? 'existing' : 'new');
  const [chosen, setChosen] = useState(into?.slug ?? '');
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('application');
  const [slugTaken, setSlugTaken] = useState(false);
  const [whereError, setWhereError] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const [point, setPoint] = useState(points[0]?.point ?? 0);
  const [label, setLabel] = useState<{ value: string; target: string } | null>(null);
  const [labelError, setLabelError] = useState('');

  const [busy, setBusy] = useState<'preview' | 'seal' | 'draft' | 'propose' | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [preview, setPreview] = useState<{
    request: CompositionDerive;
    slug: string;
    draft: DeriveDraft;
  } | null>(null);

  // The environments of the composition previewed into where the reader may adopt (one read, as the adopt dialog makes).
  const adoptable = useResource<CompositionEnvironmentView[]>(
    `derive-environments:${org}/${preview?.slug ?? 'none'}/${role ?? 'none'}`,
    async () =>
      preview && role
        ? (await compositionsApi.environments(org, preview.slug).catch(() => [])).filter(
            environment => roleAtLeast(role, environment.adoptRole)
          )
        : []
  );
  const adoptEnvironments = adoptable.data ?? [];
  const adoptTarget = adoptEnvironments.find(environment => environment.slug === adoptIn) ?? null;

  useEffect(() => {
    let active = true;
    compositionsApi.list(org, { archived: false, sort: 'updated', limit: 200 }).then(
      page => {
        if (!active) return;
        // A composition this dialog created before the list arrived stays in it.
        setCompositions(now => ({
          status: 'ready',
          list: [
            ...(now.status === 'ready'
              ? now.list.filter(made => !page.compositions.some(item => item.slug === made.slug))
              : []),
            ...page.compositions,
          ],
        }));
      },
      (caught: unknown) => {
        if (active) setCompositions({ status: 'failed', message: readApiError(caught).message });
      }
    );
    return () => {
      active = false;
    };
  }, [org]);

  const listed = compositions.status === 'ready' ? compositions.list : [];
  // The composition the binding is derived into is a choice even before (or without) the organization's list.
  const list = into && !listed.some(item => item.slug === into.slug) ? [into, ...listed] : listed;
  const target = mode === 'existing' ? (list.find(item => item.slug === chosen) ?? null) : null;
  const slug = mode === 'existing' ? chosen : (address ?? slugFromName(name));
  const targetKey = `${mode}:${slug}`;
  const suggested = target ? nextMinor(target.latest_version?.label) : FIRST_LABEL;
  // The label follows the target until the person writes one for it.
  const labelValue = label && label.target === targetKey ? label.value : suggested;

  const toWhat = (event: FormEvent) => {
    event.preventDefault();
    setWhereError('');
    if (mode === 'existing') {
      if (!target) {
        setWhereError('Choose a composition.');
        return;
      }
    } else {
      if (!name.trim()) {
        setWhereError('Give the new composition a name.');
        return;
      }
      if (!slug || !SLUG_PATTERN.test(slug)) {
        setWhereError('The address can only have lowercase letters, numbers and hyphens.');
        return;
      }
    }
    setStep('what');
  };

  /** The composition the version goes to: the chosen one, or the new one, created now (once). */
  const ensureTarget = async (): Promise<string | null> => {
    if (mode === 'existing') return chosen;
    try {
      const made = await compositionsApi.create(org, {
        slug,
        name: name.trim(),
        kind,
        description: '',
      });
      setCompositions(now =>
        now.status === 'ready'
          ? { status: 'ready', list: [made, ...now.list] }
          : { status: 'ready', list: [made] }
      );
      setMode('existing');
      setChosen(made.slug);
      setCreated(made.slug);
      setLabel({ value: labelValue, target: `existing:${made.slug}` });
      return made.slug;
    } catch (caught) {
      const error = readApiError(caught);
      if (error.code === 'slug_conflict') {
        setSlugTaken(true);
        setStep('where');
      } else {
        setRefusal(refusalOf(caught, 'create', from));
      }
      return null;
    }
  };

  const toPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setLabelError('');
    setRefusal(null);
    const version = labelValue.trim();
    if (!LABEL_PATTERN.test(version)) {
      setLabelError('A label is a Semantic Versioning number, such as 1.0.0.');
      return;
    }
    setBusy('preview');
    const into = await ensureTarget();
    if (!into) {
      setBusy(null);
      return;
    }
    // Into a composition whose latest version states an offering, the new version states the same one (its margins and
    // its offering's upstream changes go on); a new composition has none. A failed read stops here rather than drop it.
    const latest = target?.slug === into ? target.latest_version : null;
    let offering: Record<string, unknown> | null;
    try {
      offering = await latestOffering(org, into, latest);
    } catch (caught) {
      if (!(caught instanceof OfferingUnreadable)) throw caught;
      setRefusal({ message: offeringUnreadableText(caught), findings: [] });
      setBusy(null);
      return;
    }
    const derived = run
      ? runDerivation(run, point, version, false)
      : bindingDerivation(bound as BindingSource, version, false);
    const request = offering ? { ...derived, offering } : derived;
    try {
      const answer = await compositionsApi.derive(org, into, request);
      if (isSealed(answer.result)) throw new Error('The gateway sealed a preview.');
      setPreview({ request, slug: into, draft: answer.result });
      setStep('preview');
    } catch (caught) {
      setRefusal(refusalOf(caught, 'derive', from));
    } finally {
      setBusy(null);
    }
  };

  const seal = async () => {
    if (!preview || busy) return;
    setBusy('seal');
    setRefusal(null);
    const request = { ...preview.request, seal: true };
    try {
      const answer = await compositionsApi.derive(org, preview.slug, request);
      const label = isSealed(answer.result) ? answer.result.version.label : request.version;
      const toast = answer.created
        ? `Version ${label} sealed.`
        : `Version ${label} already holds this document.`;
      void navigate(compositionPath(org, preview.slug, 'versions', { version: label }), {
        state: { toast },
        viewTransition: true,
      });
    } catch (caught) {
      const error = readApiError(caught);
      setBusy(null);
      if (error.code === 'version_label_taken') {
        setLabelError(`${request.version} already holds another document. Choose another label.`);
        setStep('what');
        return;
      }
      setRefusal(refusalOf(caught, 'derive', from));
    }
  };

  const openDraft = () => {
    if (!preview) return;
    setBusy('draft');
    void navigate(
      `${editorPath({ source: { org, slug: preview.slug } })}${compositionFragment(preview.draft.content)}`,
      { viewTransition: true }
    );
  };

  const back = (to: Step) => {
    setRefusal(null);
    setStep(to);
  };

  const close = () => {
    if (!busy) onClose();
  };
  const values = preview ? previewValues(preview.draft) : [];
  const findings = preview
    ? preview.draft.diagnostics.map(item => fromC2y(item, preview.draft.content, COMPOSITION_FILE))
    : [];
  const slugError = slugTaken
    ? `${slug} is in use in this organization. Choose another address.`
    : slug && !SLUG_PATTERN.test(slug)
      ? 'Lowercase letters, numbers and hyphens.'
      : undefined;

  if (proposal && preview) {
    const settled = proposal.status !== 'pending' && proposal.status !== 'executing';
    const adopted = proposal.status === 'completed' || proposal.status === 'partial';
    return (
      // A modal of its own (keyed): it takes focus as it opens, since the button that made the proposal is gone.
      <Modal
        key="proposal"
        title="Derive and adopt"
        size="lg"
        onClose={() => {
          if (busy) return;
          onClose();
        }}
      >
        <div className={FORM}>
          <p className={MUTED} role="status">
            {settled
              ? 'The proposal was decided. The Operation tab keeps it with the composition’s other proposals.'
              : `Nothing is sealed or adopted until you confirm. The proposal waits on the Operation tab of ${preview.slug} until you confirm or cancel it, or until you make another one on this composition, which replaces it.`}
          </p>
          <ProposalPanel
            proposal={proposal}
            context={{
              org,
              composition: preview.slug,
              environments: adoptEnvironments,
            }}
            onChanged={changed => {
              if (changed) setProposal(changed);
            }}
          />
          <div className={ACTIONS}>
            {adopted && adoptTarget ? (
              <Action
                variant="primary"
                onClick={() =>
                  void navigate(
                    compositionPath(org, preview.slug, 'operation', {
                      environment: adoptTarget.slug,
                    }),
                    { viewTransition: true }
                  )
                }
              >
                {`Open ${adoptTarget.name}`}
              </Action>
            ) : (
              <Action variant="secondary" onClick={onClose}>
                Close
              </Action>
            )}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Derive a composition" size="lg" onClose={close}>
      <div className="flex min-w-0 flex-col gap-4">
        <ol className="m-0 flex list-none flex-wrap gap-3 p-0 text-[13px]" aria-label="Steps">
          {STEPS.map((item, index) => {
            const current = item.id === step;
            return (
              <li
                key={item.id}
                aria-current={current ? 'step' : undefined}
                className={`inline-flex items-center gap-1.5 ${current ? 'font-semibold text-tp-ink' : 'text-tp-steel'}`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs ${current ? 'border-tp-accent text-tp-accent' : 'border-tp-hairline'}`}
                >
                  {index + 1}
                </span>
                {item.label}
              </li>
            );
          })}
        </ol>

        {step === 'where' && (
          <form className={FORM} onSubmit={toWhat} noValidate>
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1 p-0 text-[13px] font-semibold text-tp-slate">
                Where the version goes
              </legend>
              <label className={RADIO}>
                <input
                  type="radio"
                  name="dc-target"
                  checked={mode === 'new'}
                  onChange={() => {
                    setMode('new');
                    setWhereError('');
                  }}
                />
                A new composition
              </label>
              <label className={RADIO}>
                <input
                  type="radio"
                  name="dc-target"
                  checked={mode === 'existing'}
                  disabled={list.length === 0}
                  onChange={() => {
                    setMode('existing');
                    setWhereError('');
                    if (!chosen && list[0]) setChosen(list[0].slug);
                  }}
                />
                A composition of this organization
              </label>
            </fieldset>
            {compositions.status === 'loading' && (
              <p className={MUTED} role="status">
                Reading the compositions of the organization…
              </p>
            )}
            {compositions.status === 'failed' && (
              <Notice tone="warning">{`The compositions of the organization couldn’t be read${compositions.message ? `: ${compositions.message}` : '.'} A new one can still be made.`}</Notice>
            )}
            {mode === 'new' ? (
              <>
                <FormField
                  label="Name"
                  value={name}
                  maxLength={NAME_MAX}
                  onChange={event => {
                    setName(event.target.value);
                    setSlugTaken(false);
                    setWhereError('');
                  }}
                />
                <FormField
                  label="Address"
                  value={slug}
                  onChange={event => {
                    setAddress(event.target.value);
                    setSlugTaken(false);
                    setWhereError('');
                  }}
                  spellCheck={false}
                  mono
                  error={slugError}
                  hint="Used in the address; can’t be changed later. Taken from the name unless you write one."
                />
                <div>
                  <label htmlFor={`${ids}-kind`} className="mb-1 block text-sm text-tp-slate">
                    Kind
                  </label>
                  <select
                    id={`${ids}-kind`}
                    className="h-10 w-full cursor-pointer rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink outline-none focus:border-tp-primary"
                    value={kind}
                    onChange={event => setKind(event.target.value as Kind)}
                  >
                    {KIND_OPTIONS.map(option => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className={MUTED}>The composition is created when you ask for the preview.</p>
              </>
            ) : (
              <div>
                <label htmlFor={`${ids}-composition`} className="mb-1 block text-sm text-tp-slate">
                  Composition
                </label>
                <select
                  id={`${ids}-composition`}
                  className="h-10 w-full cursor-pointer rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink outline-none focus:border-tp-primary"
                  value={chosen}
                  onChange={event => setChosen(event.target.value)}
                >
                  {list.map(item => (
                    <option key={item.slug} value={item.slug}>
                      {`${item.name} (${item.slug}) · ${item.latest_version ? `latest ${item.latest_version.label}` : 'no version yet'}`}
                    </option>
                  ))}
                </select>
                {created && created === chosen && (
                  <span className="mt-1 block text-xs text-tp-steel">{`${created} was created for this derivation.`}</span>
                )}
              </div>
            )}
            {whereError && (
              <p className="m-0 text-[13px] text-red-700" role="alert">
                {whereError}
              </p>
            )}
            <div className={ACTIONS}>
              <Action variant="secondary" onClick={close}>
                Cancel
              </Action>
              <Action type="submit" variant="primary">
                Next
              </Action>
            </div>
          </form>
        )}

        {step === 'what' && (
          <form className={FORM} onSubmit={event => void toPreview(event)} noValidate>
            <p className={MUTED}>
              {`Into ${mode === 'existing' ? (target?.name ?? chosen) : name.trim()} (${slug}).`}
            </p>
            {bound ? (
              <BindingTable source={bound} />
            ) : points.length > 1 ? (
              <>
                <p className={MUTED}>
                  The run found {points.length} solutions. Their objectives are as the run’s result
                  gives them.
                </p>
                <PointTable points={points} chosen={point} onChoose={setPoint} />
              </>
            ) : (
              <p className={MUTED}>The run’s solution is derived.</p>
            )}
            <FormField
              label="Version label"
              value={labelValue}
              onChange={event => {
                setLabel({ value: event.target.value, target: targetKey });
                setLabelError('');
              }}
              spellCheck={false}
              mono
              error={labelError || undefined}
              hint="Semantic Versioning. It is written in the document as its version."
            />
            {refusal && <RefusalNotice refusal={refusal} />}
            <div className={ACTIONS}>
              <Action variant="secondary" onClick={() => back('where')} disabled={busy !== null}>
                Back
              </Action>
              <Action type="submit" variant="primary" busy={busy === 'preview'}>
                Preview
              </Action>
            </div>
          </form>
        )}

        {step === 'preview' && preview && (
          <div className={FORM}>
            <p className={MUTED}>
              {`${bound ? 'The binding' : (points.find(item => item.point === preview.request.point)?.label ?? 'The solution')} as version ${preview.request.version} of ${preview.slug}. Nothing is stored until you seal it.`}
            </p>
            <SourceView
              source={preview.draft.content}
              label="Derived composition.yaml"
              language="yaml"
              maxHeight="16rem"
            />
            <section className="flex flex-col gap-1.5" aria-labelledby={`${ids}-values`}>
              <h3
                id={`${ids}-values`}
                className="m-0 text-[11px] font-bold tracking-[0.12em] text-tp-slate uppercase"
              >
                Values
              </h3>
              <p className={MUTED}>
                These values will be verified: <ValueBadge status="verified" />
              </p>
              {values.length > 0 ? (
                <dl className="m-0 flex flex-wrap gap-4">
                  {values.map(value => (
                    <div key={value.name}>
                      <dt className="text-xs text-tp-steel">{value.name}</dt>
                      <dd className="m-0 tabular-nums">{formatValue(value.value, value.unit)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className={MUTED}>The document states no values.</p>
              )}
            </section>
            <ProblemsPanel diagnostics={findings} title="Findings" />
            {adoptEnvironments.length > 0 && (
              <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1 p-0 text-[13px] font-semibold text-tp-slate">
                  After sealing
                </legend>
                <label className={RADIO}>
                  <input
                    type="radio"
                    name="dc-adopt"
                    checked={adoptTarget === null}
                    onChange={() => setAdoptIn('')}
                  />
                  Seal only; adopt it later
                </label>
                {adoptEnvironments.map(environment => (
                  <label key={environment.slug} className={RADIO}>
                    <input
                      type="radio"
                      name="dc-adopt"
                      checked={adoptTarget?.slug === environment.slug}
                      onChange={() => setAdoptIn(environment.slug)}
                    />
                    {`Adopt in ${environment.name} in the same step`}
                  </label>
                ))}
                {adoptTarget && (
                  <p className={MUTED}>
                    {`Both steps become one proposal: you see what it seals and what changes in ${adoptTarget.name}, then confirm it. ${adoptTarget.name}’s feed changes only when you do.`}
                  </p>
                )}
              </fieldset>
            )}
            {refusal && <RefusalNotice refusal={refusal} />}
            <div className={ACTIONS}>
              <Action variant="secondary" onClick={() => back('what')} disabled={busy !== null}>
                Back
              </Action>
              <Action variant="secondary" onClick={openDraft} disabled={busy !== null}>
                Open as draft
              </Action>
              {adoptTarget ? (
                <ProposeButton
                  org={org}
                  slug={preview.slug}
                  request={preview.request}
                  environment={adoptTarget}
                  disabled={busy !== null && busy !== 'propose'}
                  onBusy={working => setBusy(working ? 'propose' : null)}
                  onRefused={caught => setRefusal(refusalOf(caught, 'derive', from))}
                  onProposed={made => {
                    setRefusal(null);
                    setProposal(made);
                  }}
                />
              ) : (
                <Action
                  variant="primary"
                  busy={busy === 'seal'}
                  disabled={busy !== null && busy !== 'seal'}
                  onClick={() => void seal()}
                >
                  {`Seal ${preview.request.version}`}
                </Action>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
