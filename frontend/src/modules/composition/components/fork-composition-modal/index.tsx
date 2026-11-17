// Adapted from SPHERE frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition's version forked through the gateway into an organization where the account is MEMBER, never the
// source's own; a version that links a problem asks first to fork it without that problem (`dropProblem`), which the
// target cannot read; a taken name asks for a different name and address (the gateway names the existing composition);
// every refusal is said in words (forkModel); drawn in OpenBinding's modal (a focus trap and Escape).

import { useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import type { CompositionVersionView, ForkNameTaken, ForkResult } from '../../../core/api/types';
import { Modal } from '../../../core/components/modal';
import OrganizationSelector from '../../../organization/components/organization-selector';
import type { Organization } from '../../../organization/api/organizationsApi';
import { compositionsApi } from '../../api/compositionsApi';
import {
  NAME_MAX,
  forkRefusal,
  forkRequest,
  forkSuggestion,
  linksProblem,
  nameProblem,
  slugProblem,
  targetReason,
  type ForkRefusal,
} from './forkModel';

interface ForkCompositionModalProps {
  org: string;
  composition: { slug: string; name: string };
  /** The version forked: the one the page shows. */
  version: Pick<CompositionVersionView, 'id' | 'label' | 'problem'>;
  onClose: () => void;
  onSuccess: (result: ForkResult) => void;
}

type Step = 'target' | 'problem' | 'name';

const secondary =
  'cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface';
const primary =
  'cursor-pointer rounded-lg bg-tp-accent px-4 py-2 text-xs font-semibold text-tp-on-primary transition-colors hover:bg-tp-primary-deep disabled:cursor-default disabled:opacity-40';
const field =
  'w-full rounded-md border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm text-tp-ink outline-none focus:border-tp-primary';

function Refusal({ refusal }: { refusal: ForkRefusal }) {
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800"
    >
      <p>{refusal.message}</p>
      {refusal.findings.length > 0 && (
        <ul className="mt-1 list-disc pl-5" aria-label="What the gateway found">
          {refusal.findings.map((finding, index) => (
            <li key={`${finding.code}-${index}`}>
              {finding.message} <code className="font-mono">{finding.code}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ForkCompositionModal({
  org,
  composition,
  version,
  onClose,
  onSuccess,
}: ForkCompositionModalProps) {
  const linked = linksProblem(version);
  const [step, setStep] = useState<Step>('target');
  const [target, setTarget] = useState<Organization | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<ForkRefusal | null>(null);
  const [taken, setTaken] = useState<ForkNameTaken['existingComposition'] | null>(null);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');

  const reason = target ? targetReason(target, org) : null;
  const nameError = taken ? nameProblem(newName, taken.name) : null;
  const slugError = taken && target ? slugProblem(newSlug, taken.slug, target.name) : null;

  const fork = async (rename?: { slug: string; name: string }) => {
    if (!target) return;
    setRefusal(null);
    setIsSubmitting(true);
    try {
      const answer = await compositionsApi.fork(
        org,
        composition.slug,
        forkRequest(version, target.slug, rename)
      );
      if (answer.status === 'forked') onSuccess(answer.result);
      else {
        const suggestion = forkSuggestion({
          slug: answer.existing.slug,
          name: answer.existing.name,
        });
        setTaken(answer.existing);
        setNewName(suggestion.name);
        setNewSlug(suggestion.slug);
        setStep('name');
      }
    } catch (caught) {
      setRefusal(forkRefusal(readApiError(caught), target.name, rename?.slug ?? composition.slug));
    } finally {
      setIsSubmitting(false);
    }
  };

  const title =
    step === 'target'
      ? 'Fork this composition'
      : step === 'problem'
        ? 'Fork it without its problem?'
        : 'Choose a different name';

  return (
    <Modal title={title} size="md" onClose={() => !isSubmitting && onClose()}>
      {step === 'target' && (
        <>
          <p className="mb-4 text-center text-sm text-tp-steel">
            Create your own copy of{' '}
            <span className="font-medium text-tp-ink">{composition.name}</span> (version{' '}
            {version.label}) in one of your organizations.
          </p>
          <OrganizationSelector
            value={target}
            onChange={chosen => {
              setTarget(chosen);
              setRefusal(null);
            }}
            minRole="MEMBER"
            label="Fork into"
          />
          {reason && <p className="mt-2 text-xs text-red-700">{reason}.</p>}
          {refusal && <Refusal refusal={refusal} />}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={secondary}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!target || reason !== null || isSubmitting}
              onClick={() => (linked ? setStep('problem') : void fork())}
              className={primary}
            >
              {linked ? 'Next' : isSubmitting ? 'Forking…' : 'Fork'}
            </button>
          </div>
        </>
      )}

      {step === 'problem' && (
        <>
          <p className="mb-4 text-sm text-tp-steel">
            Version {version.label} links a problem of this organization, which{' '}
            <span className="font-medium text-tp-ink">{target?.name}</span> cannot read. The fork
            keeps the document without its problem and its evidence, and its values are sealed as
            declared.
          </p>
          {refusal && <Refusal refusal={refusal} />}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setStep('target')} className={secondary}>
              Back
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => void fork()}
              className={primary}
            >
              {isSubmitting ? 'Forking…' : 'Fork without the problem'}
            </button>
          </div>
        </>
      )}

      {step === 'name' && taken && (
        <>
          <p className="mb-4 text-center text-sm text-tp-steel">
            {target?.name} already has a composition named{' '}
            <span className="font-medium text-tp-ink">“{taken.name}”</span>. A fork always creates a
            new composition and cannot be added to an existing one, so enter a different name for
            it.
          </p>
          <label className="mb-1 block text-sm text-tp-slate" htmlFor="fork-name">
            Composition name
          </label>
          <input
            id="fork-name"
            value={newName}
            maxLength={NAME_MAX}
            onChange={e => setNewName(e.target.value)}
            className={field}
          />
          {nameError && <p className="mt-1 text-xs text-red-700">{nameError}</p>}
          <label className="mt-3 mb-1 block text-sm text-tp-slate" htmlFor="fork-slug">
            Address
          </label>
          <input
            id="fork-slug"
            value={newSlug}
            onChange={e => setNewSlug(e.target.value.toLowerCase())}
            className={`${field} font-mono`}
          />
          {slugError && <p className="mt-1 text-xs text-red-700">{slugError}</p>}
          {refusal && <Refusal refusal={refusal} />}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setTaken(null);
                setStep('target');
              }}
              className={secondary}
            >
              Back
            </button>
            <button
              type="button"
              disabled={isSubmitting || nameError !== null || slugError !== null}
              onClick={() => void fork({ slug: newSlug, name: newName })}
              className={primary}
            >
              {isSubmitting ? 'Forking…' : 'Fork as new composition'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
