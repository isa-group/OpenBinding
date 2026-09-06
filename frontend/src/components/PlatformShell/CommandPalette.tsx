import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Organization, Project } from '../../api/platform';
import './CommandPalette.css';

interface CommandPaletteProps {
  organization?: Organization;
  project?: Project;
  isAdmin: boolean;
}

export function CommandPalette({ organization, project, isAdmin }: CommandPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const root = organization && project ? `/app/${organization.slug}/${project.slug}` : '/app';
  const commands = useMemo(() => [
    { label: 'Workspace activity', detail: 'Organizations and recent projects', href: '/app', group: 'Workspace' },
    { label: 'Project overview', detail: project?.name ?? 'Select a project first', href: root, group: 'Workspace', disabled: !project },
    { label: 'Open workbench', detail: 'Model, validate and solve a binding case', href: `${root}/workbench`, group: 'Create', disabled: !project },
    { label: 'Binding cases', detail: 'Create and inspect immutable case histories', href: `${root}/cases`, group: 'Project', disabled: !project },
    { label: 'Comparative studies', detail: 'Cases × engines × parameters × seeds', href: `${root}/studies`, group: 'Project', disabled: !project },
    { label: 'Binding analysis', detail: 'Pareto, feasibility, runtime and stability', href: `${root}/analytics`, group: 'Project', disabled: !project },
    { label: 'Reports', detail: 'Freeze and publish reproducible evidence', href: `${root}/reports`, group: 'Project', disabled: !project },
    { label: 'Organization settings', detail: 'Hierarchy, roles and invitations', href: organization ? `/app/${organization.slug}/settings` : '/app', group: 'Workspace', disabled: !organization },
    { label: 'Explore public work', detail: 'Projects and publications', href: '/explore', group: 'Discover' },
    { label: 'BIM specification', detail: 'Schemas, profiles and extension points', href: '/schemas', group: 'Discover' },
    { label: 'Pricing control room', detail: 'SPHERE and SPACE lifecycle', href: '/app/admin/pricing', group: 'Administration', disabled: !isAdmin },
  ], [isAdmin, organization, project, root]);
  const visible = commands.filter((command) => !command.disabled && `${command.label} ${command.detail} ${command.group}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    const open = () => {
      setQuery('');
      dialog.current?.showModal();
      requestAnimationFrame(() => input.current?.focus());
    };
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('openbinding:command', open);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('openbinding:command', open);
      window.removeEventListener('keydown', keydown);
    };
  }, []);

  const choose = (href: string) => {
    dialog.current?.close();
    navigate(href, { viewTransition: true });
  };

  return <dialog ref={dialog} className="command-palette" aria-label="Search and quick actions" onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
    <div className="command-palette-panel">
      <header><Search aria-hidden="true" /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pages and actions…" aria-label="Search commands" /><form method="dialog"><button aria-label="Close command palette"><X aria-hidden="true" /></button></form></header>
      <div className="command-results">{visible.map((command, index) => <button key={command.label} type="button" className={index === 0 ? 'is-first' : undefined} onClick={() => choose(command.href)}><span>{command.group}</span><div><strong>{command.label}</strong><small>{command.detail}</small></div><ArrowRight aria-hidden="true" /></button>)}{!visible.length && <p>No matching page or action.</p>}</div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> inspect</span><span><kbd>esc</kbd> close</span><small>{organization?.name ?? 'No organization'}{project ? ` / ${project.name}` : ''}</small></footer>
    </div>
  </dialog>;
}
