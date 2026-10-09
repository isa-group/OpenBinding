import type { ReactNode } from 'react';
import { Lock, PenLine } from 'lucide-react';
import type { Organization, Project, Report } from '../../api/platform';
import { ProjectTabs } from '../../components/PlatformShell/ProjectTabs';
import { Chip } from '../../components/ui/Chip';
import { Breadcrumb, Gate, type Crumb } from '../Organization/parts';
import '../Project/Project.css';
import '../Jobs/Jobs.css';
import './Reports.css';

interface ReportFrameProps {
  organization: Organization;
  project: Project;
  /** The crumbs below the project: `Reports`, then the screen. The last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of every project screen about reports and publications: breadcrumb, the project tabs with Reports current, and one live content column. */
export function ReportFrame({ organization, project, trail, width = 'wide', children }: ReportFrameProps) {
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
      <ProjectTabs active="reports" orgSlug={organization.slug} projectSlug={project.slug} />
      <div className={`proj-body rp-body is-${width}`} aria-live="polite">{children}</div>
    </div>
  );
}

/** Draft or frozen, and whether an edition is live in Explore. */
export function ReportChips({ state, published }: { state: Report['state']; published: boolean }) {
  return (
    <span className="rp-chips">
      <Chip tone={state === 'frozen' ? 'accent' : 'warning'}>{state === 'frozen' ? 'Frozen' : 'Draft'}</Chip>
      {published && <Chip tone="success">Published</Chip>}
    </span>
  );
}

/** The tile of a report in a list: a lock for a sealed edition, a pen for a draft. */
export function ReportTile({ state }: { state: Report['state'] }) {
  return (
    <span className={`rp-tile is-${state}`} aria-hidden="true">
      {state === 'frozen' ? <Lock size={16} /> : <PenLine size={16} />}
    </span>
  );
}

/** A card that says why a report or a list of publications is not shown. */
export function ReportGate({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <Gate title={title} action={action}>{children}</Gate>;
}
