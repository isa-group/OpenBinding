// Starting a composition from a template (MEMBER): the composition's address and name and its problem's address, then one
// human action in which the gateway creates the problem, applies its recipes and seals the composition's first version. SPHERE
// has no templates of compositions; the dialog is OpenBinding's modal with the create form's fields. A taken address is said
// at its field; a template that stopped after its problem was made says so and links that problem.

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isRecord } from '../../../core/api/http';
import { readApiError } from '../../../core/api/errors';
import type { CompositionTemplateSummary } from '../../../core/api/types';
import { FormField } from '../../../core/components/form-field';
import { Modal } from '../../../core/components/modal';
import { useResource } from '../../../core/hooks/useResource';
import { compositionPath } from '../../../../routes/paths/compositions';
import { problemPath } from '../../../../routes/paths/problems';
import { useCompositionsApi } from '../../api/compositionsApi';

interface Props {
  /** The organization the composition goes to. */
  org: string;
  organizationName: string;
  template: CompositionTemplateSummary;
  onClose: () => void;
}

/** A field of a refusal's body (`field`, `problem`, `cause`…), wherever the gateway put it. */
function refusalField(caught: unknown, key: string): unknown {
  const body = (caught as { problem?: unknown } | null)?.problem;
  if (!isRecord(body)) return undefined;
  const detail = isRecord(body.detail) ? body.detail : {};
  return detail[key] ?? body[key];
}

export default function InstantiateTemplateDialog({
  org,
  organizationName,
  template,
  onClose,
}: Props) {
  const api = useCompositionsApi();
  const navigate = useNavigate();
  const view = useResource(`composition-template:${template.id}`, () =>
    api.getTemplate(template.id)
  );
  const defaults = view.data;
  const [slug, setSlug] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [problemSlug, setProblemSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ text: string; problem?: string } | null>(null);

  const shownSlug = slug ?? defaults?.composition.slug ?? '';
  const shownName = name ?? defaults?.composition.name ?? '';
  const shownProblem = problemSlug ?? defaults?.problem.slug ?? '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !shownSlug || !shownProblem) return;
    setBusy(true);
    setErrors({});
    setFailure(null);
    try {
      const made = await api.instantiateTemplate(org, {
        template: template.id,
        slug: shownSlug,
        name: shownName || null,
        problemSlug: shownProblem,
      });
      void navigate(compositionPath(org, made.composition.slug), {
        state: {
          toast: `${made.composition.name} started from the ${template.title} template, version ${made.version.label} sealed.`,
        },
      });
    } catch (caught) {
      setBusy(false);
      const refusal = readApiError(caught);
      const field = refusalField(caught, 'field');
      if (refusal.code === 'slug_taken' || refusal.code === 'slug_conflict') {
        if (field === 'problemSlug')
          setErrors({
            problemSlug: `${shownProblem} is already a problem of ${organizationName}.`,
          });
        else setErrors({ slug: `${shownSlug} is already a composition of ${organizationName}.` });
        return;
      }
      if (refusal.code === 'template_needs_sphere') {
        setFailure({ text: 'This template reads SPHERE, which this installation has turned off.' });
        return;
      }
      if (refusal.code === 'template_incomplete') {
        const made = refusalField(caught, 'problem');
        const madeSlug = isRecord(made) && typeof made.slug === 'string' ? made.slug : shownProblem;
        const cause = refusalField(caught, 'cause');
        setFailure({
          text: `The problem ${madeSlug} was created, but the template stopped before the composition${typeof cause === 'string' ? `: ${cause}.` : '.'} No composition was made; the problem is kept.`,
          problem: madeSlug,
        });
        return;
      }
      setFailure({
        text: `The composition couldn’t be started${refusal.code ? ` (${refusal.code})` : ''}${refusal.message ? `: ${refusal.message}` : '.'}`,
      });
    }
  };

  return (
    <Modal
      title={`Start from ${template.title}`}
      size="lg"
      onClose={() => !busy && onClose()}
      dismissible={!busy}
    >
      <form onSubmit={event => void submit(event)} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-tp-slate">
          {`In ${organizationName}: the problem${defaults ? ` ${defaults.problem.name} with its ${defaults.problem.revisions} versions` : ''} and a composition with version ${defaults?.composition.label ?? '1.0.0'}${template.hasOffering ? ', its offering read from SPHERE' : ''}.`}
        </p>
        <FormField
          label="Composition address"
          value={shownSlug}
          onChange={event => setSlug(event.target.value)}
          mono
          maxLength={64}
          error={errors.slug}
          disabled={busy}
        />
        <FormField
          label="Composition name"
          value={shownName}
          onChange={event => setName(event.target.value)}
          maxLength={160}
          disabled={busy}
        />
        <FormField
          label="Problem address"
          value={shownProblem}
          onChange={event => setProblemSlug(event.target.value)}
          mono
          maxLength={64}
          error={errors.problemSlug}
          disabled={busy}
        />
        <div aria-live="polite">
          {busy && (
            <p role="status" className="text-xs text-tp-steel">
              Creating the problem, applying its recipes and sealing the first version… this takes a
              moment.
            </p>
          )}
          {failure && (
            <p role="alert" className="text-xs text-red-700">
              {failure.text}{' '}
              {failure.problem && (
                <Link to={problemPath(org, failure.problem)} className="font-medium underline">
                  Open the problem
                </Link>
              )}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink hover:bg-tp-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !shownSlug || !shownProblem}
            className="cursor-pointer rounded-lg bg-tp-primary px-4 py-2 text-xs font-semibold text-white hover:bg-tp-primary/90 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Start the composition'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
