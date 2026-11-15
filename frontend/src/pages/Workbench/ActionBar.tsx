import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Problem } from '../../api/problems';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { problemPath } from '../../routes/paths/problems';
import { SLUG_PATTERN, slugFromName } from '../Cases/casesModel';
import type { Workbench } from './useWorkbench';

/** The value of the problem picker that saves the package as a new problem. */
export const NEW_PROBLEM = '';

interface ActionBarProps {
  wb: Workbench;
  /** MEMBER or above in the organization. */
  canSave: boolean;
  org: string;
  problems: Problem[];
  /** The problem to save into, or {@link NEW_PROBLEM}. */
  target: string;
  onTarget: (slug: string) => void;
  /** After a save: the problem it saved into, so the picker follows. */
  onSaved?: (problem: string) => void;
}

/**
 * What a valid package can become: a new problem of the organization, or a new version of one of its problems. Shown only once the gateway
 * has accepted the package. Nothing runs from here: a saved version runs from its problem page, which the notice after a save links to.
 */
export function ActionBar({ wb, canSave, org, problems, target, onTarget, onSaved }: ActionBarProps) {
  const [name, setName] = useState('');
  if (wb.status !== 'valid') return null;
  const targetProblem = problems.find((item) => item.slug === target);
  const packageName = typeof wb.root?.metadata?.name === 'string' ? wb.root.metadata.name : '';
  const shownName = name || packageName;
  const slug = slugFromName(shownName);
  const saved = wb.saved;

  const submit = async () => {
    const upload = await wb.save(targetProblem ? { kind: 'version', problem: targetProblem.slug } : { kind: 'new', name: shownName.trim() || undefined, slug: SLUG_PATTERN.test(slug) ? slug : undefined });
    if (upload) onSaved?.(upload.problem.slug);
  };

  return (
    <div className="wb-dock">
      {saved && (
        <Notice
          tone="success"
          action={(
            <Link to={problemPath(org, saved.upload.problem.slug, undefined, { version: saved.upload.revision.revision })} viewTransition>
              Open the problem
            </Link>
          )}
        >
          {saved.existing
            ? `Unchanged: this is version ${saved.upload.revision.revision} of ${saved.upload.problem.name}.`
            : `Saved as version ${saved.upload.revision.revision} of ${saved.upload.problem.name}. Run it from its page.`}
        </Notice>
      )}
      {wb.saveIssue && <Notice tone="error" title="The package wasn’t saved">{wb.saveIssue}</Notice>}
      <section className="wb-bar" aria-label="Package actions">
        <span className="wb-bar-note">
          {canSave
            ? 'Save a valid package as a new problem, or as a new version of one; it runs from its problem page.'
            : 'You can edit and check here; saving into the organization needs MEMBER.'}
        </span>
        {canSave && (
          <label className="wb-bar-case">
            <span className="sr-only">Save into problem</span>
            <select aria-label="Save into problem" value={target} onChange={(event) => onTarget(event.target.value)}>
              <option value={NEW_PROBLEM}>A new problem</option>
              {problems.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
        )}
        {canSave && !targetProblem && (
          <label className="wb-bar-case">
            <span className="sr-only">Name of the new problem</span>
            <input aria-label="Name of the new problem" value={shownName} placeholder="Problem name" onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        <Action
          variant="primary"
          busy={wb.saveBusy}
          disabled={!canSave}
          title={!canSave ? 'Saving into the organization needs MEMBER' : undefined}
          onClick={() => void submit()}
        >
          {targetProblem ? `Save as a new version of ${targetProblem.name}` : 'Save as a new problem'}
        </Action>
      </section>
    </div>
  );
}
