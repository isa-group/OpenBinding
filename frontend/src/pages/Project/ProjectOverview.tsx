import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { useAuth } from '../../contexts/auth';
import { problemsPath, workbenchPath } from '../../routes/paths/problems';
import { launchPath } from '../../routes/paths/runs';
import { studiesPath } from '../../routes/paths/studies';
import { roleSource } from '../Organization/orgModel';
import { RoleChip } from '../Organization/parts';
import { OrgFrame, OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { VisibilityChip } from './parts';
import { useRouteProject } from './useRouteProject';
import './Project.css';

/** An action the role doesn't reach stays visible, dimmed, with the reason. */
function RoleAction({ allowed, to, variant, children }: { allowed: boolean; to: string; variant: 'primary' | 'secondary'; children: ReactNode }) {
  if (allowed) return <Action to={to} variant={variant}>{children}</Action>;
  return <span className={`ui-action is-${variant} is-md`} aria-disabled="true" title="Needs MEMBER">{children}</span>;
}

function GetStarted({ org, canCreate }: { org: string; canCreate: boolean }) {
  const steps: Array<{ title: string; detail: string; cta: string; to: string; needsMember?: boolean }> = [
    { title: 'Add a problem', detail: 'Problems belong to the organization: upload a package or write one in its Workbench.', cta: 'Open problems', to: problemsPath(org) },
    { title: 'Start a run', detail: 'Run a problem version of the organization with an exact engine.', cta: 'New run', to: launchPath(org), needsMember: true },
    { title: 'Validate a package', detail: 'Check a .bim.zip you already have.', cta: 'Open Workbench', to: '/workbench' },
  ];
  return (
    <section className="proj-start" aria-labelledby="po-start">
      <div>
        <h2 id="po-start">Get started</h2>
        <p>Problems, runs and studies belong to the organization. Three ways to begin:</p>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="proj-step-n" aria-hidden="true">{index + 1}</span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
            {step.needsMember && !canCreate
              ? <span className="proj-owner-only" title="Needs MEMBER">{step.cta} · needs MEMBER</span>
              : <Link to={step.to} viewTransition>{step.cta}</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function OverviewBody({ organization, project, canCreate, publicRead, role, roleTitle }: {
  organization: Organization; project: Project; canCreate: boolean; publicRead: boolean; role: Organization['effective_role'] | 'PLATFORM ADMIN'; roleTitle?: string;
}) {
  const org = organization.slug;

  const header = (
    <>
      <div className="proj-title-row">
        <div className="proj-title">
          <span className="proj-title-line">
            <h1>{project.name}</h1>
            <VisibilityChip visibility={project.visibility} />
            {!publicRead && <RoleChip role={role} title={roleTitle} />}
          </span>
          <p>{project.description || 'No description yet.'}</p>
        </div>
        <div className="proj-actions">
          {!publicRead && (
            <>
              <RoleAction allowed={canCreate} to={launchPath(org)} variant="primary">Run</RoleAction>
              <Action to={studiesPath(org)} variant="secondary">Studies</Action>
              <Action to={problemsPath(org)} variant="secondary">Problems</Action>
              <Action to={workbenchPath(org)} variant="secondary">Workbench</Action>
            </>
          )}
        </div>
      </div>
      {publicRead && <small className="org-muted">This project is open to read. Only members can change anything.</small>}
      {!publicRead && !canCreate && <small className="org-muted">You’re a VIEWER: you can read everything here; creating needs MEMBER.</small>}
    </>
  );

  return (
    <OrgFrame organization={organization} project={project} section="overview" header={header}>
      {!publicRead && <GetStarted org={org} canCreate={canCreate} />}
      {publicRead && <p className="org-muted">Nothing has been shared in this project yet.</p>}
    </OrgFrame>
  );
}

/** A project (`proj-overview`, `/app/:org/:project`). Problems, runs and studies are the organization's. */
export function ProjectOverview() {
  const { context, organization, project, access, waiting, failure, reload } = useRouteProject();
  const { isAdmin } = useAuth();
  if (waiting) return <OrgSkeleton label="Loading project…" />;
  if (!organization || !project) {
    return <OrgGate failure={organization ? failure : null} organizationName={organization?.name} onRetry={reload} />;
  }
  const role = organization.effective_role ?? (isAdmin ? 'PLATFORM ADMIN' : null);
  return (
    <OverviewBody
      organization={organization}
      project={project}
      canCreate={access.canCreate}
      publicRead={access.publicRead}
      role={role}
      roleTitle={roleSource(organization, context.organizations).text}
    />
  );
}
