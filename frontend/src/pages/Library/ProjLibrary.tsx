import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { ProjectLibraryNav } from '../../components/ui/SectionNav';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { ProjectFrame, ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { ProjectAccess } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { associateRefusal, classifyAuthError, dissociateRefusal, listRefusal, marker } from './libraryErrors';
import { itemKey, itemPath, kindLabel, newestFirst } from './libraryModel';
import { KindChip } from './parts';

const ENRICH_LIMIT = 60;

interface Row {
  item: LibraryItem;
  latest: LibraryVersion | undefined;
  /** Versions could be read for this item. */
  known: boolean;
}

function AddFromLibrary({ organization, project, already, onClose, onAdded, onRefused }: {
  organization: Organization; project: Project; already: string[]; onClose: () => void; onAdded: (item: LibraryItem) => void; onRefused: (text: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const library = useResource<LibraryItem[]>(`picker-library:${organization.slug}`, () => libraryItemsApi.list(organization.slug, true));
  const needle = query.trim().toLowerCase();
  const candidates = (library.data ?? []).filter((item) => !already.includes(item.id) && (!needle || `${item.display_name} ${item.name}`.toLowerCase().includes(needle)));
  const own = candidates.filter((item) => item.organization_id === organization.id);
  const others = candidates.filter((item) => item.organization_id !== organization.id);

  const add = async (item: LibraryItem) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await libraryItemsApi.associate(organization.slug, project.slug, item.id);
      onAdded(item);
    } catch (caught) {
      onRefused(associateRefusal(caught, item.display_name).text);
    }
  };

  const choice = (item: LibraryItem, foreign: boolean) => (
    <li key={item.id}>
      <button type="button" className={`lib-pick${foreign ? ' is-foreign' : ''}`} disabled={Boolean(busyId)} onClick={() => void add(item)} aria-label={`Add ${item.display_name}`}>
        <span>
          <strong>{item.display_name}</strong>
          <small>{kindLabel(item.kind)} · {foreign ? 'Other organization · published' : organization.name}</small>
        </span>
        <span className="lib-pick-add">Add</span>
      </button>
    </li>
  );

  return (
    <Modal title="Add from library" size="lg" onClose={onClose}>
      <div className="org-dialog-form">
        <div className="ui-field">
          <label htmlFor="pl-search" className="sr-only">Search</label>
          <input id="pl-search" type="search" value={query} placeholder="Search your library and published items…" onChange={(event) => setQuery(event.target.value)} />
        </div>
        {library.status === 'loading' && <p className="org-muted" role="status">Loading the library…</p>}
        {library.status === 'error' && <p className="lib-error-text" role="alert">{listRefusal(classifyAuthError(library.error)).text}</p>}
        {library.status === 'ready' && candidates.length === 0 && <p className="org-muted">{query ? 'Nothing matches.' : 'Everything from the library is already here.'}</p>}
        {own.length > 0 && <ul className="lib-picks" aria-label="From your library">{own.map((item) => choice(item, false))}</ul>}
        {others.length > 0 && <ul className="lib-picks" aria-label="Published by other organizations">{others.map((item) => choice(item, true))}</ul>}
        <div className="ui-modal-actions"><Action variant="secondary" onClick={onClose}>Close</Action></div>
      </div>
    </Modal>
  );
}

function Body({ organization, project, access }: { organization: Organization; project: Project; access: ProjectAccess }) {
  const slug = organization.slug;
  const [picker, setPicker] = useState(false);
  const [toast, setToast] = useState('');
  const [problem, setProblem] = useState('');
  const [removing, setRemoving] = useState<string>();
  const items = useResource<LibraryItem[]>(`project-library:${slug}/${project.slug}`, () => libraryItemsApi.projectItems(slug, project.slug));
  const listed = items.data ?? [];
  const ids = listed.slice(0, ENRICH_LIMIT).map((item) => item.id).join(',');
  const latest = useResource<Map<string, LibraryVersion[]>>(`project-library-latest:${slug}/${project.slug}:${ids}`, async () => {
    const found = new Map<string, LibraryVersion[]>();
    const results = await Promise.allSettled(listed.slice(0, ENRICH_LIMIT).map((item) => libraryItemsApi.versions(item.id)));
    results.forEach((result, index) => { if (result.status === 'fulfilled') found.set(listed[index].id, newestFirst(result.value)); });
    return found;
  });
  const failure = items.status === 'error' ? classifyAuthError(items.error) : null;
  const rows: Row[] = listed.map((item) => ({ item, latest: latest.data?.get(item.id)?.[0], known: latest.data?.has(item.id) ?? false }));

  const remove = async (item: LibraryItem) => {
    if (removing) return;
    setRemoving(item.id);
    setProblem('');
    setToast('');
    try {
      await libraryItemsApi.dissociate(slug, project.slug, item.id);
      setToast(`“${item.display_name}” removed from this project. Its versions are untouched.`);
      items.reload();
    } catch (caught) {
      setProblem(dissociateRefusal(caught).text);
    } finally {
      setRemoving(undefined);
    }
  };

  return (
    <ProjectFrame organization={organization} project={project} section="library" crumb="Library">
      <ProjectLibraryNav current="library" orgSlug={slug} projectSlug={project.slug} publicRead={access.publicRead} />
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Library used here</h1>
          <p>Library items this project works with, from {organization.name} or published by others.</p>
        </div>
        {access.canCreate && <div className="proj-actions"><Action variant="primary" onClick={() => { setPicker(true); setProblem(''); }}>Add from library</Action></div>}
      </header>
      <div className="proj-note is-info" role="note">
        <span>Removing an item from this list doesn’t delete it or any of its versions, and cases that pinned a version keep working.</span>
      </div>
      {!access.canCreate && <ReadOnlyNote role={access.role}>You can see what the project uses; changing the list needs MEMBER.</ReadOnlyNote>}
      {toast && <div className="org-toast" role="status"><CheckCircle2 aria-hidden="true" /><span>{toast}</span></div>}
      {problem && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{problem}</div>}
      {failure && (
        <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={failure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={items.reload}>Retry</Action>}>
          {failure.status === 403 ? `This account or API key can’t read this project’s library${marker(failure)}.` : `The project’s library couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}
      {items.status === 'loading' && <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading the project’s library…</span><Skeleton variant="panel" /></div>}
      {items.status === 'ready' && rows.length === 0 && (
        <section className="lib-dashed lib-nothing" aria-labelledby="pl-empty">
          <strong id="pl-empty">Nothing associated yet</strong>
          {access.publicRead ? (
            <span>This project doesn’t list any published library item.</span>
          ) : (
            <>
              <span>Add the catalogs, workflows and settings this project uses so they’re one click away.</span>
              <Action to={`/app/${slug}/library`} variant="secondary">Browse the library</Action>
            </>
          )}
        </section>
      )}
      {rows.length > 0 && (
        <ul className="lib-assoc" aria-label="Library items used here">
          {rows.map(({ item, latest: newest, known }) => {
            const own = item.organization_id === organization.id;
            return (
              <li key={item.id} className="lib-assoc-row">
                <KindChip kind={item.kind} />
                <Link className="lib-assoc-name" to={itemPath(slug, itemKey(item, organization.id, listed))} viewTransition>{item.display_name}</Link>
                <span className="lib-assoc-latest">{!known ? '—' : newest ? `latest v${newest.ref.version}` : 'no version'}</span>
                <Chip>{own ? `Own · ${organization.name}` : 'Published by another organization'}</Chip>
                {access.canCreate && (
                  <Action variant="secondary" size="sm" busy={removing === item.id} onClick={() => void remove(item)} aria-label={`Remove ${item.display_name} from this project`}>Remove from project</Action>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {picker && (
        <AddFromLibrary
          organization={organization}
          project={project}
          already={listed.map((item) => item.id)}
          onClose={() => setPicker(false)}
          onAdded={(item) => {
            setPicker(false);
            setProblem('');
            setToast(`${item.display_name} added.`);
            items.reload();
          }}
          onRefused={(text) => { setPicker(false); setToast(''); setProblem(text); }}
        />
      )}
    </ProjectFrame>
  );
}

/** Project library (`proj-library`, `/app/:org/:project/library`): the library items a project works with, added and removed here. */
export function ProjLibrary() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <Body organization={organization} project={project} access={access} />;
}
