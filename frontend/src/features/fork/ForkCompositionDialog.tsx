// Design follows SPHERE frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx (revision 73779a8a); no code copied
import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { Action } from '../../modules/core/components/action-button';
import { FormField } from '../../modules/core/components/form-field';
import { Modal } from '../../modules/core/components/modal';
import { OrganizationPicker } from '../../components/ui/OrganizationPicker';
import { compositionsApi } from '../../entities/composition/api';
import { compositionPath } from '../../routes/paths/compositions';
import { readApiError } from '../../modules/core/api/errors';
import type {
  CompositionVersionView,
  CompositionView,
  ForkNameTaken,
} from '../../modules/core/api/types';
import {
  NAME_MAX,
  forkRefusal,
  forkRequest,
  forkSuggestion,
  linksProblem,
  nameProblem,
  slugProblem,
  stepsOf,
  targetReason,
  type ForkRefusal,
  type ForkStep,
} from './forkModel';
import './ForkCompositionDialog.css';

const STEP_LABELS: Record<ForkStep, string> = {
  target: 'Where',
  problem: 'Its problem',
  name: 'A different name',
};

function RefusalNotice({ refusal }: { refusal: ForkRefusal }) {
  return (
    <div className="fk-refusal" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div>
        <p>{refusal.message}</p>
        {refusal.findings.length > 0 && (
          <ul aria-label="What the gateway found">
            {refusal.findings.map((finding, index) => (
              <li key={`${finding.code}-${finding.pointer ?? ''}-${index}`}>
                {finding.message}
                {finding.pointer && (
                  <>
                    {' '}
                    <code>{finding.pointer}</code>
                  </>
                )}{' '}
                <code>{finding.code}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export interface ForkCompositionDialogProps {
  /** The composition forked, with its organization. */
  composition: CompositionView;
  /** The version forked: the one shown. */
  version: CompositionVersionView;
  onClose: () => void;
}

/**
 * Fork the shown version of a composition into another organization, as SPHERE forks a pricing: the target (one of the account's
 * organizations where it is MEMBER, never the source's own), then, for a version that links a problem, the explicit choice to drop
 * that link, which the target cannot read. When the target already has a composition at the source's address, nothing is forked
 * and the dialog asks for a different name and address. The fork is a new, private composition, which opens once it is made.
 */
export function ForkCompositionDialog({
  composition,
  version,
  onClose,
}: ForkCompositionDialogProps) {
  const navigate = useNavigate();
  const ids = useId();
  const source = composition.organization;
  const linked = linksProblem(version);

  const [step, setStep] = useState<ForkStep>('target');
  const [target, setTarget] = useState<Organization | null>(null);
  const [dropProblem, setDropProblem] = useState(false);
  const [taken, setTaken] = useState<ForkNameTaken['existingComposition'] | null>(null);
  const [rename, setRename] = useState<{ slug: string; name: string }>({ slug: '', name: '' });
  const [shown, setShown] = useState<{ slug: boolean; name: boolean }>({
    slug: false,
    name: false,
  });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ForkRefusal | null>(null);

  const steps = taken ? [...stepsOf(linked), 'name' as const] : stepsOf(linked);
  const targetName = target?.name ?? '';
  const nameError = taken ? nameProblem(rename.name, taken.name) : null;
  const slugError = taken ? slugProblem(rename.slug, taken.slug, targetName) : null;
  const slugRefused = refusal?.field === 'slug' ? refusal.message : undefined;

  const close = () => {
    if (!busy) onClose();
  };

  const fork = async (named: boolean) => {
    if (!target || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await compositionsApi.fork(
        source.slug,
        composition.slug,
        forkRequest(version, target.slug, named ? rename : undefined)
      );
      if (answer.status === 'nameTaken') {
        setTaken(answer.existing);
        setRename(forkSuggestion(composition));
        setShown({ slug: false, name: false });
        setStep('name');
        setBusy(false);
        return;
      }
      const { result } = answer;
      const toast = `Forked. The copy is private.${result.droppedProblem ? ' Values are declared.' : ''}`;
      void navigate(compositionPath(target.slug, result.composition.slug), {
        state: { toast },
        viewTransition: true,
      });
    } catch (caught) {
      setRefusal(
        forkRefusal(readApiError(caught), target.name, named ? rename.slug : composition.slug)
      );
      setBusy(false);
    }
  };

  const submitTarget = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    if (linked) {
      setRefusal(null);
      setStep('problem');
      return;
    }
    void fork(false);
  };

  const submitProblem = (event: FormEvent) => {
    event.preventDefault();
    if (dropProblem) void fork(false);
  };

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    setShown({ slug: true, name: true });
    if (!nameError && !slugError) void fork(true);
  };

  const back = () => {
    setRefusal(null);
    setTaken(null);
    setStep(step === 'name' && linked ? 'problem' : 'target');
  };

  return (
    <Modal title="Fork this composition" size="lg" onClose={close} dismissible={!busy}>
      <div className="fk">
        <ol className="fk-steps" aria-label="Steps">
          {steps.map((id, index) => (
            <li
              key={id}
              className={id === step ? 'is-current' : undefined}
              aria-current={id === step ? 'step' : undefined}
            >
              <span aria-hidden="true">{index + 1}</span>
              {STEP_LABELS[id]}
            </li>
          ))}
        </ol>

        {step === 'target' && (
          <form className="fk-form" onSubmit={submitTarget} noValidate>
            <p className="fk-muted">
              Create your own copy of <strong>{composition.name}</strong> at version{' '}
              <strong>{version.label}</strong> in another of your organizations. The copy is a new,
              private composition.
            </p>
            <OrganizationPicker
              mode="select"
              label="Fork into"
              value={target?.slug ?? null}
              onChange={organization => {
                setTarget(organization);
                setRefusal(null);
              }}
              disabledReason={organization => targetReason(organization, source.slug)}
            />
            {refusal && <RefusalNotice refusal={refusal} />}
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={close} disabled={busy}>
                Cancel
              </Action>
              <Action type="submit" variant="primary" disabled={!target} busy={busy}>
                {linked ? 'Next' : 'Fork'}
              </Action>
            </div>
          </form>
        )}

        {step === 'problem' && (
          <form className="fk-form" onSubmit={submitProblem} noValidate>
            <p id={`${ids}-problem`}>
              This version links a problem of {source.name}, which {targetName} cannot read. Forking
              removes the link and the evidence, and seals the copy with declared values.
            </p>
            <label className="fk-check">
              <input
                type="checkbox"
                checked={dropProblem}
                required
                aria-describedby={`${ids}-problem`}
                onChange={event => {
                  setDropProblem(event.target.checked);
                  setRefusal(null);
                }}
              />
              Fork without the problem: remove the link and the evidence, and declare the values
            </label>
            {refusal && <RefusalNotice refusal={refusal} />}
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={back} disabled={busy}>
                Back
              </Action>
              <Action type="submit" variant="primary" disabled={!dropProblem} busy={busy}>
                Fork
              </Action>
            </div>
          </form>
        )}

        {step === 'name' && taken && (
          <form className="fk-form" onSubmit={submitName} noValidate>
            <p>
              {targetName} already has a composition at <code>{taken.slug}</code>, named “
              {taken.name}”. A fork always creates a new composition and cannot be added to an
              existing one, so choose a different name and address for it.
            </p>
            <FormField
              label="Name"
              value={rename.name}
              maxLength={NAME_MAX}
              onChange={event => {
                setRename({ ...rename, name: event.target.value });
                setShown({ ...shown, name: true });
              }}
              error={shown.name && nameError ? nameError : undefined}
            />
            <FormField
              label="Address"
              value={rename.slug}
              spellCheck={false}
              mono
              onChange={event => {
                setRename({ ...rename, slug: event.target.value });
                setShown({ ...shown, slug: true });
                setRefusal(null);
              }}
              error={slugRefused ?? (shown.slug && slugError ? slugError : undefined)}
              hint="Used in the address; can’t be changed later."
            />
            {refusal && refusal.field !== 'slug' && <RefusalNotice refusal={refusal} />}
            <div className="ui-modal-actions">
              <Action variant="secondary" onClick={back} disabled={busy}>
                Back
              </Action>
              <Action
                type="submit"
                variant="primary"
                disabled={nameError !== null || slugError !== null}
                busy={busy}
              >
                Fork as a new composition
              </Action>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
