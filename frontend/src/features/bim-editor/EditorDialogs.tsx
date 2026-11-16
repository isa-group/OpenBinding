import { useState } from 'react';
import { bimApi } from '../../api/bim';
import { problemsApi, type Problem, type ProblemRevision } from '../../api/problems';
import { Action } from '../../components/ui/Action';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { SLUG_PATTERN, slugFromName } from '../../shared/lib/slug';
import { useResource } from '../../utils/useResource';
import type { SaveTarget } from './useProblemEditor';

/** How many problems the pickers list: the gateway's ceiling for one page. */
const PICKER_LIMIT = 200;
const NO_REVISIONS: ProblemRevision[] = [];

export type OpenChoice = { kind: 'template'; template: string } | { kind: 'revision'; problem: string; revision: number } | { kind: 'blank' };

/** Open another package: a template, a version of one of the organization's problems, or the blank package. */
export function OpenDialog({ org, onOpen, onClose }: { org: string; onOpen: (choice: OpenChoice) => void; onClose: () => void }) {
  const templates = useResource(`pe-templates`, () => bimApi.templates());
  const problems = useResource(`pe-problems:${org}`, async () => (await problemsApi.list(org, { limit: PICKER_LIMIT })).problems);
  const [template, setTemplate] = useState('');
  const [problem, setProblem] = useState('');
  const [revision, setRevision] = useState('');
  const revisions = useResource<ProblemRevision[]>(`pe-revisions:${org}/${problem}`, () => (problem ? problemsApi.revisions(org, problem) : Promise.resolve(NO_REVISIONS)));
  const versions = [...(revisions.data ?? [])].sort((a, b) => b.revision - a.revision);
  const chosen = versions.find((item) => String(item.revision) === revision) ?? versions[0];

  return (
    <Modal title="Open a package" size="md" onClose={onClose}>
      <div className="pe-open">
        <section aria-labelledby="pe-open-template">
          <h3 id="pe-open-template">A template</h3>
          {templates.status === 'error' && <Notice tone="warning">The templates couldn’t be listed.</Notice>}
          <div className="pe-open-row">
            <label className="pe-field">
              <span>Template</span>
              <select value={template} onChange={(event) => setTemplate(event.target.value)}>
                <option value="">{templates.status === 'loading' ? 'Loading templates…' : 'Choose a template…'}</option>
                {(templates.data ?? []).map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
            </label>
            <Action variant="secondary" disabled={!template} onClick={() => onOpen({ kind: 'template', template })}>Open template</Action>
          </div>
        </section>
        <section aria-labelledby="pe-open-version">
          <h3 id="pe-open-version">A problem version</h3>
          {problems.status === 'error' && <Notice tone="warning">The organization’s problems couldn’t be listed.</Notice>}
          {problems.status === 'ready' && (problems.data ?? []).length === 0 && <p className="pe-muted">The organization has no problems yet.</p>}
          <div className="pe-open-row">
            <label className="pe-field">
              <span>Problem</span>
              <select value={problem} onChange={(event) => { setProblem(event.target.value); setRevision(''); }}>
                <option value="">{problems.status === 'loading' ? 'Loading problems…' : 'Choose a problem…'}</option>
                {(problems.data ?? []).map((item: Problem) => <option key={item.id} value={item.slug}>{item.name}</option>)}
              </select>
            </label>
            <label className="pe-field">
              <span>Version</span>
              <select value={chosen ? String(chosen.revision) : ''} disabled={!problem || versions.length === 0} onChange={(event) => setRevision(event.target.value)}>
                {versions.length === 0 && <option value="">{problem && revisions.status === 'loading' ? 'Loading versions…' : 'No version'}</option>}
                {versions.map((item) => <option key={item.id} value={String(item.revision)}>Version {item.revision}</option>)}
              </select>
            </label>
            <Action variant="secondary" disabled={!problem || !chosen} onClick={() => chosen && onOpen({ kind: 'revision', problem, revision: chosen.revision })}>Open version</Action>
          </div>
        </section>
        <section aria-labelledby="pe-open-blank">
          <h3 id="pe-open-blank">A blank package</h3>
          <div className="pe-open-row">
            <p className="pe-muted">One task, one candidate and one goal, to write a problem from the start.</p>
            <Action variant="secondary" onClick={() => onOpen({ kind: 'blank' })}>Start blank</Action>
          </div>
        </section>
      </div>
    </Modal>
  );
}

/** The value of the problem picker that saves the package as a new problem. */
const NEW_PROBLEM = '';

/** Save the package: as a new problem of the organization, or as a new version of one of its problems. */
export function SaveDialog({ org, packageName, initialProblem, busy, issue, onSave, onClose }: {
  org: string;
  /** The name the package's Instance gives itself: the default name of a new problem. */
  packageName: string;
  /** The problem the editor opened, the default target. */
  initialProblem: string | null;
  busy: boolean;
  /** Why the last save was refused. */
  issue: string | null;
  onSave: (target: SaveTarget) => void;
  onClose: () => void;
}) {
  const problems = useResource(`pe-problems:${org}`, async () => (await problemsApi.list(org, { limit: PICKER_LIMIT })).problems);
  const [target, setTarget] = useState(initialProblem ?? NEW_PROBLEM);
  const [name, setName] = useState('');
  const list = problems.data ?? [];
  const into = list.find((item) => item.slug === target);
  const shownName = name || packageName;
  const slug = slugFromName(shownName);

  const submit = () => onSave(into
    ? { kind: 'version', problem: into.slug }
    : { kind: 'new', name: shownName.trim() || undefined, slug: SLUG_PATTERN.test(slug) ? slug : undefined });

  return (
    <Modal title="Save the package" size="sm" onClose={onClose}>
      <div className="pe-save">
        <p className="pe-muted">A saved version runs from its problem page. The same package again is not a new version.</p>
        <label className="pe-field">
          <span>Save into</span>
          <select aria-label="Save into problem" value={into ? target : NEW_PROBLEM} onChange={(event) => setTarget(event.target.value)}>
            <option value={NEW_PROBLEM}>A new problem</option>
            {list.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
          </select>
        </label>
        {!into && (
          <label className="pe-field">
            <span>Name of the new problem</span>
            <input aria-label="Name of the new problem" value={shownName} placeholder="Problem name" onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        {issue && <Notice tone="error" title="The package wasn’t saved">{issue}</Notice>}
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose}>Cancel</Action>
          <Action variant="primary" busy={busy} onClick={submit}>{into ? `Save as a new version of ${into.name}` : 'Save as a new problem'}</Action>
        </div>
      </div>
    </Modal>
  );
}
