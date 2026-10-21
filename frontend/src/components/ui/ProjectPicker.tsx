import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import './ProjectPicker.css';

interface ProjectOption {
  organization: { slug: string; name: string };
  project: { slug: string; name: string };
}

interface ProjectPickerProps {
  /** The button label: "Run with this engine", "Import as case". */
  label: string;
  /** Where a project leads to. */
  destination: (organization: string, project: string) => string;
  variant?: 'primary' | 'secondary';
}

type Load = { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; options: ProjectOption[] };

async function loadProjects(): Promise<ProjectOption[]> {
  const organizations = await platformApi.organizations();
  const lists = await Promise.all(organizations.map(async (organization) => {
    const projects = await platformApi.projects(organization.slug);
    return projects.map((project) => ({ organization, project }));
  }));
  return lists.flat();
}

/**
 * A button that opens a short list of the projects the signed-in account belongs to, each a link to
 * `destination(organization, project)`. Actions that need a project (save, import, run) start here
 * instead of guessing which project the person means.
 */
export function ProjectPicker({ label, destination, variant = 'secondary' }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const panelId = useId();

  const fetchProjects = () => {
    setLoad({ status: 'loading' });
    loadProjects().then(
      (options) => setLoad({ status: 'ready', options }),
      () => setLoad({ status: 'failed' }),
    );
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && load.status !== 'ready' && load.status !== 'loading') fetchProjects();
  };

  return (
    <div className="ui-project-picker">
      <button type="button" className={`ui-project-picker-button is-${variant}`} aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        {label}
      </button>
      {open && (
        <div className="ui-project-picker-panel" id={panelId} role="group" aria-label={`${label}: choose a project`}>
          <span className="ui-project-picker-title">Choose a project</span>
          {load.status === 'loading' && <span role="status">Loading your projects…</span>}
          {load.status === 'failed' && (
            <span role="alert">
              Your projects couldn’t be loaded. <button type="button" onClick={fetchProjects}>Retry</button>
            </span>
          )}
          {load.status === 'ready' && load.options.length === 0 && (
            <span>You have no projects yet. <Link to="/app">Open your workspace</Link> to create one.</span>
          )}
          {load.status === 'ready' && load.options.length > 0 && (
            <ul>
              {load.options.map(({ organization, project }) => (
                <li key={`${organization.slug}/${project.slug}`}>
                  <Link to={destination(organization.slug, project.slug)}>
                    <span>{organization.name}</span> / <strong>{project.name}</strong>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
