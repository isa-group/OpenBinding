import type { ReactNode } from 'react';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Gate, type Crumb } from '../Organization/parts';
import { OrgFrame } from '../../features/workspace/OrgFrame';
import { Chip } from '../../components/ui/Chip';
import { normalizeStatus, outcomeOf } from './jobsModel';
import { jobStatus } from '../../features/workspace/model';
import type { Refusal } from './jobErrors';
import '../Project/Project.css';
import './Jobs.css';

interface JobFrameProps {
  organization: Organization;
  project: Project;
  /** The crumbs below the project: `Jobs`, then the screen. The last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of every project screen about runs: breadcrumb, the project tabs with Jobs current, and one live content column. */
export function JobFrame({ organization, project, trail, width = 'wide', children }: JobFrameProps) {
  return (
    <OrgFrame organization={organization} project={project} section="jobs" trail={trail} width={width}>
      {children}
    </OrgFrame>
  );
}

/** A run is not there, or is not the account's: one card with the way out. The words are the same for both. */
export function JobMissing({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
  return <Gate title={title} action={actions}>{children}</Gate>;
}

/** Where a run stands: a dot and a word, coloured by how it went. */
export function StatusChip({ status, termination }: { status: string; termination?: string | null }) {
  const state = normalizeStatus(status);
  const shown = jobStatus(state, state === 'completed' ? null : termination);
  return (
    <span className={`proj-status job-status is-${shown.tone}`}>
      <span className={`proj-dot is-${shown.tone}`} aria-hidden="true" />
      {shown.label}
    </span>
  );
}

/** How a finished run ended, in words. */
export function OutcomeChip({ termination, long = false }: { termination?: string | null; long?: boolean }) {
  const outcome = outcomeOf(termination);
  if (!outcome) return <span className="org-muted" aria-label="No outcome yet">—</span>;
  return <Chip tone={outcome.tone}>{long ? outcome.long : outcome.label}</Chip>;
}

/** A refusal of the gateway, worded: the title, what it means, the lines it attached, and the way forward. */
export function RefusalNotice({ refusal, action, usageTo, extra }: {
  refusal: Refusal; action?: ReactNode; usageTo?: boolean; extra?: ReactNode;
}) {
  return (
    <Notice tone={refusal.kind === 'plan' || refusal.kind === 'key' || refusal.kind === 'terminal' ? 'warning' : 'error'} title={refusal.title} action={action}>
      {refusal.text}
      {refusal.permission && refusal.kind === 'key' && <> <Chip mono>{refusal.permission}</Chip></>}
      {refusal.details.map((line) => <span className="job-refusal-line" key={line}>{line}</span>)}
      {extra}
      {refusal.kind === 'range' && (
        <span className="job-refusal-links">
          <Action to="/engines" variant="link" size="sm">Engines</Action>
        </span>
      )}
      {/* A larger plan helps with an allowance or a job limit of the plan - not with a limit this deployment sets whatever
          the plan (the problem size, the study matrix), nor with one the plan can't apply (`misconfigured`). */}
      {usageTo && (refusal.kind === 'quota' || (refusal.kind === 'busy' && refusal.source !== 'technical') || refusal.kind === 'plan') && (
        <span className="job-refusal-links">
          <Action to="/app/account/usage" variant="link" size="sm">See your plan</Action>
          <Action to="/pricing" variant="link" size="sm">Compare plans</Action>
        </span>
      )}
    </Notice>
  );
}
