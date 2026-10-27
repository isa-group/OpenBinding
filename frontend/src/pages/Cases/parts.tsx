import { Fragment, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { Organization, Project } from '../../api/platform';
import { ProjectTabs } from '../../components/PlatformShell/ProjectTabs';
import { useCopy } from '../../components/ui/useCopy';
import { Breadcrumb, Gate, type Crumb } from '../Organization/parts';
import { describeFlow, type FlowNode, type TaskInfo } from './bindingModel';
import '../Project/Project.css';
import './Cases.css';

interface CaseFrameProps {
  organization: Organization;
  project: Project;
  /** The crumbs below the project: `Cases`, the case, the screen. The last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of every screen of the cases: breadcrumb, project tabs and one live content column. */
export function CaseFrame({ organization, project, trail, width = 'wide', children }: CaseFrameProps) {
  const root = `/app/${organization.slug}/${project.slug}`;
  const items: Crumb[] = [
    { label: 'Home', to: '/app' },
    { label: organization.name, to: `/app/${organization.slug}` },
    { label: project.name, to: root },
    ...trail,
  ];
  return (
    <div className="proj-frame">
      <div className="proj-band">
        <div className="proj-band-inner"><Breadcrumb items={items} /></div>
      </div>
      <ProjectTabs active="cases" orgSlug={organization.slug} projectSlug={project.slug} access={project.access} />
      <div className={`proj-body is-${width}`} aria-live="polite">{children}</div>
    </div>
  );
}

/** The case, or the revision, isn't there: one card with the way out. */
export function CaseMissing({ title, children, actions }: { title: string; children?: ReactNode; actions: ReactNode }) {
  return (
    <Gate title={title} action={actions}>
      {children ?? ''}
    </Gate>
  );
}

/** A role that can look and not change: stated once, near the top. */
export function ReadOnlyNote({ role, children }: { role: string | null; children: ReactNode }) {
  return (
    <div className="proj-note is-info" role="note">
      <Lock aria-hidden="true" className="org-inline-icon" />
      <span>{role ? <>You’re {role === 'VIEWER' ? 'a ' : 'an '}<strong>{role}</strong>. </> : null}{children}</span>
    </div>
  );
}

/** `10` to the power of a number, as text people can read. */
export function Power({ log10 }: { log10: number | null }) {
  if (log10 === null) return <>—</>;
  return <>10<sup>{(Math.round(log10 * 10) / 10).toString()}</sup></>;
}

/** A fingerprint in short form with a button that copies the whole of it. */
export function DigestLine({ digest, label, copyKey }: { digest: string; label: string; copyKey: string }) {
  const { copy, status } = useCopy();
  return (
    <span className="case-digest">
      <code title={digest}>{digest.length > 24 ? `${digest.slice(0, 11)}…${digest.slice(-4)}` : digest}</code>
      <button type="button" className="case-link-button" onClick={() => void copy(digest, copyKey)} aria-label={`Copy ${label} fingerprint`}>
        {status(copyKey) === 'copied' ? 'Copied' : status(copyKey) === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
    </span>
  );
}

// --- the drawing of a workflow

function TaskBox({ task, branch }: { task: TaskInfo; branch?: { probability: number | null } }) {
  const local = task.kind === 'local';
  const percent = branch?.probability !== null && branch?.probability !== undefined ? Math.round(branch.probability * 100) : null;
  return (
    <div className={`flow-task${local ? ' is-local' : ''}`}>
      <div className="flow-task-top">
        <code>{task.id}</code>
        {percent !== null && <b>{percent}%</b>}
      </div>
      {percent !== null && <div className="flow-bar" aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>}
      <small>{local ? 'local task · not bound' : `service${task.capability ? ` · ${task.capability}` : ''}`}</small>
      {!local && <span className="flow-count">{task.candidates.length === 1 ? '1 candidate' : `${task.candidates.length} candidates`}</span>}
    </div>
  );
}

function Step({ node, vertical }: { node: FlowNode; vertical: boolean }) {
  switch (node.kind) {
    case 'task': return <TaskBox task={node.task} />;
    case 'empty': return <span className="flow-empty">nothing happens</span>;
    case 'sequence':
      return (
        <div className={`flow-seq${vertical ? ' is-vertical' : ''}`}>
          {node.steps.map((step, index) => (
            <Fragment key={index}>
              <Step node={step} vertical={vertical} />
              {index < node.steps.length - 1 && <span className="flow-arrow" aria-hidden="true">{vertical ? '↓' : '→'}</span>}
            </Fragment>
          ))}
        </div>
      );
    case 'parallel':
      return (
        <div className="flow-group">
          <span className="flow-group-label">Parallel · all at once</span>
          {node.branches.map((branch, index) => <Step key={index} node={branch} vertical />)}
        </div>
      );
    case 'exclusive': {
      const byProbability = node.branches.some((branch) => branch.probability !== null);
      return (
        <div className="flow-group">
          <span className="flow-group-label">{byProbability ? 'One of · by probability' : 'One of · by condition'}</span>
          {node.branches.map((branch) => (
            <div className="flow-branch" key={branch.id}>
              {branch.flow.kind === 'task'
                ? <TaskBox task={branch.flow.task} branch={{ probability: branch.probability }} />
                : <><b className="flow-branch-id">{branch.id}{branch.probability !== null ? ` · ${Math.round(branch.probability * 100)}%` : ''}</b><Step node={branch.flow} vertical /></>}
              {branch.condition && <small className="flow-when">when {branch.condition}</small>}
            </div>
          ))}
        </div>
      );
    }
    case 'repeat':
      return (
        <div className="flow-group">
          <span className="flow-group-label">Repeat · {node.times}</span>
          <Step node={node.body} vertical />
        </div>
      );
    default: return null;
  }
}

/** The workflow of a revision drawn as boxes and arrows: what runs in sequence, in parallel or as alternatives. */
export function FlowDrawing({ flow, caption }: { flow: FlowNode | null; caption?: ReactNode }) {
  if (!flow) return <p className="org-muted">The workflow isn’t available for this revision.</p>;
  return (
    <div className="flow">
      <div className="flow-scroll">
        <div className="flow-canvas" role="img" aria-label={describeFlow(flow)}>
          <Step node={flow} vertical={false} />
        </div>
      </div>
      <div className="flow-legend">
        <span><i className="flow-key" />Service task (gets a provider)</span>
        <span><i className="flow-key is-local" />Local task</span>
        {caption}
      </div>
    </div>
  );
}
