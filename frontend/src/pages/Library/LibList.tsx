import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { NeutralGate, RoleChip } from '../Organization/parts';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { accessIn } from '../Project/projectModel';
import { NewItemDialog, type CreatedItem } from './dialogs';
import { classifyAuthError, listRefusal } from './libraryErrors';
import { draftPath, itemKey, itemPath, kindLabel, KIND_CHOICES, newestFirst, publicationOf } from './libraryModel';
import { KindChip, LibraryFrame, LibrarySkeleton, PublicationChip } from './parts';
import { useUsage } from './useLibrary';

/** Versions are read one item at a time, so a very large library is read in part: the table says "—" for the rest. */
const ENRICH_LIMIT = 60;

interface Toast {
  text: string;
  to?: string;
  link?: string;
}

function ListBody({ organization, projects }: { organization: Organization; projects: Project[] }) {
  const { isAdmin } = useAuth();
  const access = accessIn(organization, isAdmin);
  const slug = organization.slug;
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [includePublic, setIncludePublic] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const library = useResource(`library:${slug}:${includePublic}`, () => libraryItemsApi.list(slug, includePublic));

  const all = library.data ?? [];
  const own = all.filter((item) => item.organization_id === organization.id);
  const ownIds = own.slice(0, ENRICH_LIMIT).map((item) => item.id).join(',');
  const versions = useResource<Map<string, LibraryVersion[]>>(`library-latest:${slug}:${ownIds}`, async () => {
    const found = new Map<string, LibraryVersion[]>();
    const results = await Promise.allSettled(own.slice(0, ENRICH_LIMIT).map((item) => libraryItemsApi.versions(item.id)));
    results.forEach((result, index) => { if (result.status === 'fulfilled') found.set(own[index].id, newestFirst(result.value)); });
    return found;
  });
  const usage = useUsage(slug, projects, library.status === 'ready');

  const failure = library.status === 'error' ? classifyAuthError(library.error) : null;
  const refusal = failure ? listRefusal(failure) : null;
  const needle = query.trim().toLowerCase();
  const kindsPresent = [...new Set(all.map((item) => item.kind))].sort((a, b) => {
    const order = (value: string) => { const at = KIND_CHOICES.findIndex((choice) => choice.id === value); return at < 0 ? KIND_CHOICES.length : at; };
    return order(a) - order(b) || a.localeCompare(b);
  });
  const shown = all.filter((item) => (!kind || item.kind === kind) && (!needle || `${item.display_name} ${item.name}`.toLowerCase().includes(needle)));
  const foreign = all.filter((item) => item.organization_id !== organization.id);

  const created = ({ item, draft, draftFailure }: CreatedItem) => {
    setCreating(false);
    const key = itemKey(item, organization.id, [...all, item]);
    setToast(draft
      ? { text: `Created “${item.display_name}”. It starts with an empty draft; seal it when it’s ready.`, to: draftPath(slug, key, draft.id), link: 'Open the draft' }
      : { text: `Created “${item.display_name}”, but its first draft couldn’t be made. ${draftFailure ?? ''}`.trim(), to: itemPath(slug, key), link: 'Open the item' });
    library.reload();
  };

  return (
    <LibraryFrame orgSlug={slug} orgName={organization.name} trail={[{ label: 'Library' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Library</h1>
          <p>Reusable parts of {organization.name}: workflows, candidate catalogs, rules, goals and more. Each one has editable drafts and sealed versions that never change.</p>
        </div>
        {access.canCreate && (
          <div className="proj-actions">
            <Action variant="primary" onClick={() => setCreating(true)}>New library item</Action>
          </div>
        )}
      </header>

      {refusal && (
        <Notice tone={failure?.status === 403 ? 'warning' : 'error'} action={failure?.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={library.reload}>Retry</Action>}>
          {refusal.text}
        </Notice>
      )}
      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast.text}</span>
          {toast.to && <Link to={toast.to} viewTransition>{toast.link}</Link>}
        </div>
      )}
      {!access.canCreate && <ReadOnlyNote role={access.role}>You can browse the library and open any item; creating items needs MEMBER.</ReadOnlyNote>}

      {failure?.status !== 403 && (
        <>
          <div className="case-toolbar">
            <div className="ui-field case-search">
              <label htmlFor="lib-search" className="sr-only">Search the library</label>
              <input id="lib-search" type="search" value={query} placeholder="Search by name…" onChange={(event) => setQuery(event.target.value)} />
            </div>
            {kindsPresent.length > 0 && (
              <FilterPills ariaLabel="Kind" value={kind} onChange={setKind} options={[{ id: '', label: 'All kinds' }, ...kindsPresent.map((id) => ({ id, label: kindLabel(id) }))]} />
            )}
            <label className="lib-check">
              <input type="checkbox" checked={includePublic} onChange={(event) => setIncludePublic(event.target.checked)} />
              Include public items from other organizations
            </label>
          </div>
          {includePublic && library.status === 'ready' && foreign.length === 0 && <p className="org-muted">There are no public items from other organizations.</p>}

          {library.status === 'loading' && (
            <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading the library…</span><Skeleton variant="panel" /></div>
          )}

          {library.status === 'ready' && own.length === 0 && foreign.length === 0 && (
            <section className="case-guide" aria-labelledby="lib-guide-title">
              <h2 id="lib-guide-title">The library is empty</h2>
              <p>A good first item is a candidate catalog: the providers your tasks can use, with their measured latency, cost and availability.</p>
              <div className="proj-actions">
                {access.canCreate && <Action variant="primary" onClick={() => setCreating(true)}>Create a candidate catalog</Action>}
                <Action to="/examples" variant="secondary">Import an example</Action>
              </div>
            </section>
          )}

          {library.status === 'ready' && all.length > 0 && shown.length === 0 && <p className="org-muted">Nothing matches these filters.</p>}
          {shown.length > 0 && (
            <div className="lib-table-card">
              <div className="lib-table-scroll">
                <table className="lib-table is-list">
                  <caption className="sr-only">Library items</caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Latest version</th>
                      <th scope="col">Public</th>
                      <th scope="col">Used in</th>
                      <th scope="col"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        all={all}
                        organization={organization}
                        versions={versions.data?.get(item.id)}
                        used={usage.data?.byItem.get(item.id) ?? []}
                        canUse={access.canCreate}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {library.status === 'ready' && usage.data && usage.data.unread > 0 && (
            <p className="org-muted">“Used in” may be incomplete: {usage.data.unread === 1 ? '1 project' : `${usage.data.unread} projects`} of {organization.name} couldn’t be read.</p>
          )}
          {library.status === 'ready' && all.length > 0 && <p className="org-muted">Your role here: <RoleChip role={access.role} />. Creating needs MEMBER; publishing and withdrawing need ADMIN.</p>}
        </>
      )}

      {creating && <NewItemDialog orgSlug={slug} onClose={() => setCreating(false)} onCreated={created} />}
    </LibraryFrame>
  );
}

function ItemRow({ item, all, organization, versions, used, canUse }: {
  item: LibraryItem; all: LibraryItem[]; organization: Organization; versions: LibraryVersion[] | undefined; used: Project[]; canUse: boolean;
}) {
  const own = item.organization_id === organization.id;
  const to = itemPath(organization.slug, itemKey(item, organization.id, all));
  const latest = versions?.[0];
  const published = (versions ?? []).some((version) => publicationOf(version) === 'published');
  return (
    <tr>
      <th scope="row" className="lib-name-cell">
        <Link to={to} viewTransition>{item.display_name}</Link>
        <code>{item.name}</code>
        {!own && <small>Another organization</small>}
      </th>
      <td><KindChip kind={item.kind} /></td>
      <td>{!own ? <span className="lib-none">—</span> : versions === undefined ? <span className="lib-none">—</span> : latest ? `v${latest.ref.version}` : 'No version yet'}</td>
      <td>{!own ? <Chip tone="success">Public</Chip> : versions === undefined ? <span className="lib-none">—</span> : <PublicationChip state={published ? 'published' : 'members'} />}</td>
      <td>{used.length ? used.map((project) => project.name).join(', ') : <span className="lib-none">—</span>}</td>
      <td className="lib-cell-end">{canUse && <Link to={`${to}?use=1`} viewTransition>Use in a project</Link>}</td>
    </tr>
  );
}

/** Library (`lib-list`, `/app/:org/library`): the reusable parts of an organization, and the way to make a new one. */
export function LibList() {
  const { organization, waiting, context } = useRouteOrganization();
  if (waiting) return <LibrarySkeleton />;
  if (!organization) return <div className="proj-body is-wide"><NeutralGate /></div>;
  return <ListBody organization={organization} projects={context.projects} />;
}
