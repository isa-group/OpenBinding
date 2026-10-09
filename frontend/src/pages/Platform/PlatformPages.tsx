import type { ReactNode } from 'react';
import { CircleDashed, Plus } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import './PlatformPages.css';

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="observatory-empty"><CircleDashed aria-hidden="true" /><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function PageHeading({ eyebrow, title, detail, action }: {
  eyebrow: string; title: string; detail: string; action?: ReactNode;
}) {
  return <header className="platform-page-heading"><div><span>{eyebrow}</span><h1>{title}</h1><p>{detail}</p></div>{action}</header>;
}

// The Home (app-home), the organization screens (org-*), the project screens (proj-*), the case screens (case-*, snap-detail), the files, resources and
// collections, the executions (job-*), the studies (study-*), and the reports, publications, analysis and verifier live in pages/AppHome,
// pages/Organization, pages/Project, pages/Cases, pages/Resources, pages/Jobs, pages/Studies, pages/Reports and pages/Analysis.
// What stays here is the message of a project page that has no project to open.

/** What the pages of a project show when the workspace has no project to open: the way to the new-project screen. */
export function NoProject() {
  const context = useOutletContext<PlatformOutletContext>();
  if (context.loading) return <div className="route-loading" role="status"><span className="status-dot" aria-hidden="true" /> Loading workspace…</div>;
  if (!context.organization) return <div className="platform-page"><Empty title="No organization yet" detail="Create an organization from the activity page first." /></div>;
  return <div className="platform-page"><PageHeading eyebrow={context.organization.name} title="Create a first project" detail="Projects isolate cases, studies, artifacts and permissions." action={<Link className="platform-primary-action" to={`/app/${context.organization.slug}/new-project`}><Plus aria-hidden="true" />New project</Link>} /></div>;
}
