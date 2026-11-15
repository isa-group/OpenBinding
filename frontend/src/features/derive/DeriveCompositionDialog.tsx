import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { SourceView } from '../../components/rendering/SourceView';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { compositionsApi } from '../../entities/composition/api';
import type { Kind } from '../../entities/composition/document';
import { KIND_OPTIONS } from '../../entities/composition/kinds';
import { formatValue } from '../../entities/composition/values';
import { COMPOSITION_FILE } from '../../entities/composition/viewModel';
import { compositionPath } from '../../routes/paths/compositions';
import { readApiError, type ApiError } from '../../shared/api/errors';
import type { CompositionDerive, CompositionView, DeriveDraft, DeriveResult } from '../../shared/api/types';
import { fromC2y } from '../../shared/diagnostics/located';
import { SLUG_PATTERN, slugFromName } from '../../shared/lib/slug';
import { compositionFragment } from '../../shared/sphere/composition-fragment';
import { formatNumber } from '../../utils/format';
import { ProblemsPanel } from '../../widgets/problems-panel/ProblemsPanel';
import { ValueBadge } from '../../widgets/value-badge/ValueBadge';
import {
  FIRST_LABEL, LABEL_PATTERN, criteriaOf, nextMinor, pointsOf, previewValues, runDerivation, type Point, type RunSource,
} from './deriveModel';
import './DeriveCompositionDialog.css';

type Step = 'where' | 'what' | 'preview';

const STEPS: ReadonlyArray<{ id: Step; label: string }> = [
  { id: 'where', label: 'Where' },
  { id: 'what', label: 'What' },
  { id: 'preview', label: 'Preview and seal' },
];

const NAME_MAX = 160;

/** A refusal of the gateway, in words, with the findings a 422 carries. */
interface Refusal {
  message: string;
  findings: ApiError['diagnostics'];
}

type Compositions = { status: 'loading' } | { status: 'ready'; list: CompositionView[] } | { status: 'failed'; message: string };

const isSealed = (result: DeriveResult | DeriveDraft): result is DeriveResult => 'version' in result;

/** What a refusal of a derivation says, for the cases the dialog does not answer at a field. */
function refusalOf(caught: unknown, what: 'create' | 'derive'): Refusal {
  const error = readApiError(caught);
  const code = error.status ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})` : '';
  if (error.status === 403) {
    return { message: `Deriving a composition needs MEMBER in this organization${code}.`, findings: [] };
  }
  if (error.status === 404) {
    return { message: `The run or the composition is not there any more, or you can’t read it${code}.`, findings: [] };
  }
  if (error.status === 422 && error.code === 'derivation_invalid') {
    return { message: `This solution can’t be written as a composition${code}. The gateway found:`, findings: error.diagnostics };
  }
  if (error.status === 429) {
    const wait = error.retryAfter ? ` Try again in ${error.retryAfter} s.` : ' Try again in a moment.';
    return { message: `The toolchain is busy${code}.${wait}`, findings: [] };
  }
  const subject = what === 'create' ? 'The composition couldn’t be created' : 'The composition couldn’t be derived';
  return { message: `${subject}${code}${error.message ? `: ${error.message}` : '.'}`, findings: error.diagnostics };
}

function scoreText(score: Point['score']): string {
  if (score === null) return '—';
  if (Array.isArray(score)) return score.map((item) => (item === null ? '—' : formatNumber(item, 4))).join(', ');
  return formatNumber(score, 4);
}

/** The solutions of the run as its result gives them, one radio each: no order but the result's, no ranking. */
function PointTable({ points, chosen, onChoose }: { points: Point[]; chosen: number; onChoose: (point: number) => void }) {
  const criteria = criteriaOf(points);
  return (
    <DataTable label="Solutions of the run" minWidth={360}>
      <thead>
        <tr>
          <th scope="col">Solution</th>
          {criteria.map((criterion) => <th key={criterion} scope="col">{criterion}</th>)}
          <th scope="col">Score</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point) => (
          <tr key={point.point} aria-current={point.point === chosen ? 'true' : undefined}>
            <th scope="row">
              <label className="dc-point">
                <input type="radio" name="dc-point" checked={point.point === chosen} onChange={() => onChoose(point.point)} />
                {point.label}
              </label>
            </th>
            {criteria.map((criterion) => {
              const value = point.objectives.find((objective) => objective.criterion === criterion)?.value ?? null;
              return <td key={criterion} className="dc-number">{value === null ? '—' : formatNumber(value, 4)}</td>;
            })}
            <td className="dc-number">{scoreText(point.score)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function RefusalNotice({ refusal }: { refusal: Refusal }) {
  return (
    <div className="dc-refusal" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div>
        <p>{refusal.message}</p>
        {refusal.findings.length > 0 && (
          <ul aria-label="What the gateway found">
            {refusal.findings.map((finding, index) => (
              <li key={`${finding.code}-${finding.pointer ?? ''}-${index}`}>
                {finding.message}
                {finding.pointer && <> <code>{finding.pointer}</code></>}
                {' '}<code>{finding.code}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export interface DeriveCompositionDialogProps {
  /** The organization of the run; the composition is one of its own. */
  org: string;
  /** The run and its solutions. */
  source: RunSource;
  onClose: () => void;
}

/**
 * Derive a composition from a run (§4 derive): where the version goes (a composition of the organization, or a new one, created
 * when the preview is asked for), which solution and under which label, then the document the gateway writes, previewed before it
 * is sealed. A preview and a seal send the same request but `seal`, so the sealed bytes are the previewed ones (F1 D15). The
 * preview can also open in the Editor as a draft.
 */
export function DeriveCompositionDialog({ org, source, onClose }: DeriveCompositionDialogProps) {
  const navigate = useNavigate();
  const ids = useId();
  const points = pointsOf(source.solutions);

  const [step, setStep] = useState<Step>('where');
  const [compositions, setCompositions] = useState<Compositions>({ status: 'loading' });
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('application');
  const [slugTaken, setSlugTaken] = useState(false);
  const [whereError, setWhereError] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const [point, setPoint] = useState(points[0]?.point ?? 0);
  const [label, setLabel] = useState<{ value: string; target: string } | null>(null);
  const [labelError, setLabelError] = useState('');

  const [busy, setBusy] = useState<'preview' | 'seal' | 'draft' | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [preview, setPreview] = useState<{ request: CompositionDerive; slug: string; draft: DeriveDraft } | null>(null);

  useEffect(() => {
    let active = true;
    compositionsApi.list(org, { archived: false, sort: 'updated', limit: 200 }).then(
      (page) => {
        if (!active) return;
        // A composition this dialog created before the list arrived stays in it.
        setCompositions((now) => ({
          status: 'ready',
          list: [...(now.status === 'ready' ? now.list.filter((made) => !page.compositions.some((item) => item.slug === made.slug)) : []), ...page.compositions],
        }));
      },
      (caught: unknown) => {
        if (active) setCompositions({ status: 'failed', message: readApiError(caught).message });
      },
    );
    return () => { active = false; };
  }, [org]);

  const list = compositions.status === 'ready' ? compositions.list : [];
  const target = mode === 'existing' ? list.find((item) => item.slug === chosen) ?? null : null;
  const slug = mode === 'existing' ? chosen : address ?? slugFromName(name);
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
      const made = await compositionsApi.create(org, { slug, name: name.trim(), kind, description: '' });
      setCompositions((now) => (now.status === 'ready' ? { status: 'ready', list: [made, ...now.list] } : { status: 'ready', list: [made] }));
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
        setRefusal(refusalOf(caught, 'create'));
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
    const request = runDerivation(source, point, version, false);
    try {
      const answer = await compositionsApi.derive(org, into, request);
      if (isSealed(answer.result)) throw new Error('The gateway sealed a preview.');
      setPreview({ request, slug: into, draft: answer.result });
      setStep('preview');
    } catch (caught) {
      setRefusal(refusalOf(caught, 'derive'));
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
      const sealed = isSealed(answer.result) ? answer.result.version.label : request.version;
      void navigate(compositionPath(org, preview.slug, 'versions', { version: sealed }), {
        state: { toast: answer.created ? `Version ${sealed} sealed.` : `Version ${sealed} already holds this document.` },
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
      setRefusal(refusalOf(caught, 'derive'));
    }
  };

  const openDraft = () => {
    if (!preview) return;
    setBusy('draft');
    void navigate(`${compositionPath(org, preview.slug, 'editor')}${compositionFragment(preview.draft.content)}`, { viewTransition: true });
  };

  const back = (to: Step) => {
    setRefusal(null);
    setStep(to);
  };

  const close = () => { if (!busy) onClose(); };
  const values = preview ? previewValues(preview.draft) : [];
  const findings = preview ? preview.draft.diagnostics.map((item) => fromC2y(item, preview.draft.content, COMPOSITION_FILE)) : [];
  const slugError = slugTaken ? `${slug} is in use in this organization. Choose another address.`
    : slug && !SLUG_PATTERN.test(slug) ? 'Lowercase letters, numbers and hyphens.' : undefined;

  return (
    <Modal title="Derive a composition" size="lg" onClose={close}>
      <div className="dc">
        <ol className="dc-steps" aria-label="Steps">
          {STEPS.map((item, index) => (
            <li key={item.id} aria-current={item.id === step ? 'step' : undefined} className={item.id === step ? 'is-current' : undefined}>
              <span aria-hidden="true">{index + 1}</span>
              {item.label}
            </li>
          ))}
        </ol>

        {step === 'where' && (
          <form className="dc-form" onSubmit={toWhat} noValidate>
            <fieldset className="dc-choice">
              <legend>Where the version goes</legend>
              <label>
                <input type="radio" name="dc-target" checked={mode === 'new'} onChange={() => { setMode('new'); setWhereError(''); }} />
                A new composition
              </label>
              <label>
                <input
                  type="radio"
                  name="dc-target"
                  checked={mode === 'existing'}
                  disabled={list.length === 0}
                  onChange={() => { setMode('existing'); setWhereError(''); if (!chosen && list[0]) setChosen(list[0].slug); }}
                />
                A composition of this organization
              </label>
            </fieldset>
            {compositions.status === 'loading' && <p className="dc-muted" role="status">Reading the compositions of the organization…</p>}
            {compositions.status === 'failed' && (
              <Notice tone="warning">{`The compositions of the organization couldn’t be read${compositions.message ? `: ${compositions.message}` : '.'} A new one can still be made.`}</Notice>
            )}
            {mode === 'new' ? (
              <>
                <FormField label="Name" value={name} maxLength={NAME_MAX} onChange={(event) => { setName(event.target.value); setSlugTaken(false); setWhereError(''); }} />
                <FormField
                  label="Address"
                  value={slug}
                  onChange={(event) => { setAddress(event.target.value); setSlugTaken(false); setWhereError(''); }}
                  spellCheck={false}
                  mono
                  error={slugError}
                  hint="Used in the address; can’t be changed later. Taken from the name unless you write one."
                />
                <div className="ui-field">
                  <label htmlFor={`${ids}-kind`}>Kind</label>
                  <select id={`${ids}-kind`} className="dc-select" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                    {KIND_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </div>
                <p className="dc-muted">The composition is created when you ask for the preview.</p>
              </>
            ) : (
              <div className="ui-field">
                <label htmlFor={`${ids}-composition`}>Composition</label>
                <select id={`${ids}-composition`} className="dc-select" value={chosen} onChange={(event) => setChosen(event.target.value)}>
                  {list.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {`${item.name} (${item.slug}) · ${item.latest_version ? `latest ${item.latest_version.label}` : 'no version yet'}`}
                    </option>
                  ))}
                </select>
                {created && created === chosen && <span className="ui-field-note">{`${created} was created for this derivation.`}</span>}
              </div>
            )}
            {whereError && <p className="dc-error" role="alert">{whereError}</p>}
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={close}>Cancel</Action>
              <Action type="submit" variant="primary">Next</Action>
            </div>
          </form>
        )}

        {step === 'what' && (
          <form className="dc-form" onSubmit={(event) => void toPreview(event)} noValidate>
            <p className="dc-muted">
              {`Into ${mode === 'existing' ? (target?.name ?? chosen) : name.trim()} (${slug}).`}
            </p>
            {points.length > 1 ? (
              <>
                <p className="dc-muted">The run found {points.length} solutions. Their objectives are as the run’s result gives them.</p>
                <PointTable points={points} chosen={point} onChoose={setPoint} />
              </>
            ) : (
              <p className="dc-muted">The run’s solution is derived.</p>
            )}
            <FormField
              label="Version label"
              value={labelValue}
              onChange={(event) => { setLabel({ value: event.target.value, target: targetKey }); setLabelError(''); }}
              spellCheck={false}
              mono
              error={labelError || undefined}
              hint="Semantic Versioning. It is written in the document as its version."
            />
            {refusal && <RefusalNotice refusal={refusal} />}
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => back('where')} disabled={busy !== null}>Back</Action>
              <Action type="submit" variant="primary" busy={busy === 'preview'}>Preview</Action>
            </div>
          </form>
        )}

        {step === 'preview' && preview && (
          <div className="dc-form">
            <p className="dc-muted">
              {`${points.find((item) => item.point === preview.request.point)?.label ?? 'The solution'} as version ${preview.request.version} of ${preview.slug}. Nothing is stored until you seal it.`}
            </p>
            <SourceView source={preview.draft.content} label="Derived composition.yaml" language="yaml" maxHeight="16rem" />
            <section className="dc-values" aria-labelledby={`${ids}-values`}>
              <h3 id={`${ids}-values`}>Values</h3>
              <p className="dc-muted">These values will be verified: <ValueBadge status="verified" /></p>
              {values.length > 0 ? (
                <dl>
                  {values.map((value) => (
                    <div key={value.name}>
                      <dt>{value.name}</dt>
                      <dd>{formatValue(value.value, value.unit)}</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="dc-muted">The document states no values.</p>}
            </section>
            <ProblemsPanel diagnostics={findings} title="Findings" />
            {refusal && <RefusalNotice refusal={refusal} />}
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={() => back('what')} disabled={busy !== null}>Back</Action>
              <Action variant="secondary" onClick={openDraft} disabled={busy !== null}>Open as draft</Action>
              <Action variant="primary" busy={busy === 'seal'} disabled={busy !== null && busy !== 'seal'} onClick={() => void seal()}>
                {`Seal ${preview.request.version}`}
              </Action>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
