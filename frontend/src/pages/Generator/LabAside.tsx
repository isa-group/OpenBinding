import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { shortDigest } from '../../utils/digest';
import { outputFacts, workspaceFilesOf, type Output, type ProjectChoice } from './generatorModel';

/** The files of a result, one at a time, as the text they hold. Behind a control: the preview does not need them. */
function SourceOfFiles({ files }: { files: Record<string, unknown> }) {
  const text = workspaceFilesOf(files);
  const names = Object.keys(text);
  const [picked, setPicked] = useState(names[0] ?? '');
  const shown = names.includes(picked) ? picked : names[0];
  if (names.length === 0) return null;
  return (
    <details className="gl-details">
      <summary>View source</summary>
      <label className="gl-field">
        <span>File</span>
        <select value={shown} onChange={(event) => setPicked(event.target.value)}>
          {names.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <pre>{text[shown]}</pre>
    </details>
  );
}

/** What was generated: the shape of the workflow, its figures and whether it is labelled synthetic. */
export function Preview({ generating, output }: { generating: boolean; output: Output | null }) {
  const facts = output ? outputFacts(output) : [];
  const tasks = output && output.kind !== 'convert' ? output.params.tasks ?? 0 : 0;
  const shown = Math.min(tasks, 12);
  const digest = output ? (output.kind === 'corpus' ? '' : output.response.package_digest) : '';
  return (
    <section className="gl-card" aria-label="Preview" aria-live="polite">
      <span className="gl-eyebrow">Preview</span>
      {generating && <span className="gl-generating"><span className="gl-spinner" aria-hidden="true" />Generating…</span>}
      {!generating && !output && <span className="gl-muted">Default settings shown. Generate to see the structure.</span>}
      {!generating && output && (
        <>
          {shown > 0 && (
            <ol className="gl-chain" aria-label={`Workflow of ${tasks} tasks, in sequence`}>
              {Array.from({ length: shown }, (_, index) => (
                <li key={index}><span>t{index + 1}</span>{index < shown - 1 && <i aria-hidden="true">→</i>}</li>
              ))}
              {tasks > shown && <li className="gl-more">+{tasks - shown} more</li>}
            </ol>
          )}
          <dl className="gl-facts">
            {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          </dl>
          {output.kind === 'corpus' && output.response.instances.length > 0 && (
            <ul className="gl-instances" aria-label="Instances of the batch">
              {output.response.instances.slice(0, 8).map((instance) => <li key={instance.name}><code>{instance.name}</code><span>{shortDigest(instance.package_digest)}</span></li>)}
              {output.response.instances.length > 8 && <li className="gl-more">+{output.response.instances.length - 8} more</li>}
            </ul>
          )}
          <Chip tone="accent">{digest ? `Synthetic · fingerprint ${shortDigest(digest)}` : 'Synthetic · fingerprints assigned by the server'}</Chip>
          {output.kind !== 'corpus' && <SourceOfFiles files={output.response.files} />}
        </>
      )}
    </section>
  );
}

export interface KeepState {
  tone: 'success' | 'error';
  text: string;
  /** Where to look at what was kept. */
  href?: string;
}

interface KeepItProps {
  signedIn: boolean;
  projects: ProjectChoice[];
  projectsLoading: boolean;
  selected: string;
  onSelect: (id: string) => void;
  /** There is a result to keep. */
  hasOutput: boolean;
  /** The result has files a workbench can open. */
  hasFiles: boolean;
  saving: boolean;
  keep: KeepState | null;
  onSave: () => void;
  onOpen: () => void;
}

/** Keeping the result: adding it to a project, or opening it in that project's workbench. */
export function KeepIt({ signedIn, projects, projectsLoading, selected, onSelect, hasOutput, hasFiles, saving, keep, onSave, onOpen }: KeepItProps) {
  return (
    <section className="gl-card" aria-label="Keep it">
      <span className="gl-eyebrow">Keep it</span>
      {!signedIn && (
        <span className="gl-note">Saving to a project needs an account (401). <Link to="/login" viewTransition>Log in</Link></span>
      )}
      {signedIn && (
        <>
          <label className="gl-field">
            <span>Project</span>
            <select value={selected} onChange={(event) => onSelect(event.target.value)} disabled={projects.length === 0}>
              {projects.length === 0 && <option value="">{projectsLoading ? 'Looking for your projects…' : 'No project where you can add'}</option>}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
            </select>
          </label>
          <div className="gl-buttons">
            <Action variant="primary" busy={saving} disabled={!hasOutput || !selected} onClick={onSave}>Save to project</Action>
            {hasFiles && <Action variant="secondary" disabled={!selected || saving} onClick={onOpen}>Open in Workbench</Action>}
          </div>
          {!hasOutput && <span className="gl-muted">Generate something first; then you can keep it.</span>}
        </>
      )}
      {keep && (
        <Notice tone={keep.tone} action={keep.href ? <Link to={keep.href} viewTransition>See the project’s cases</Link> : undefined}>{keep.text}</Notice>
      )}
    </section>
  );
}
