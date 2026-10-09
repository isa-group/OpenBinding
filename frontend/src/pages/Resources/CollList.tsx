import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { platformApi, type Collection, type Organization, type Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { ProjectLibraryNav } from '../../components/ui/SectionNav';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { RoleChip } from '../Organization/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { ProjectAccess } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { newestFirst, typeSummary } from './collectionModel';
import { ConfirmDialog, NewCollectionDialog } from './dialogs';
import { Meter, ResourceFrame } from './parts';
import { classifyAuthError, collectionDeleteRefusal, collectionsListRefusal } from './resourceErrors';
import { loadCollections } from './resourceData';
import { allowanceOf, plural } from './resourceModel';
import { useSponsorUsage, type SponsorUsage } from './useSponsorUsage';

function Allowance({ count, sponsor }: { count: number; sponsor: SponsorUsage }) {
  const { isSponsor, usage, loading } = sponsor;
  const allowance = allowanceOf(usage, 'collections', isSponsor);
  const limit = allowance.limit;
  const used = allowance.used ?? count;
  const full = limit !== null && used >= limit;
  let text: string;
  if (loading) text = 'Reading the allowance…';
  else if (!allowance.known) text = `${plural(count, 'collection')} in this project · the sponsor’s allowance isn’t shown to you`;
  else if (limit === null) text = `${plural(count, 'collection')} in this project · no limit on your plan`;
  else if (allowance.used !== null) text = `${used} of ${limit}`;
  else text = `${count} in this project · allowance ${limit}`;
  return (
    <div className="res-allowance">
      <div className="res-allowance-main">
        <strong id="coll-allowance">Sponsor’s collections</strong>
        {allowance.known && limit !== null && <Meter label="Sponsor’s collections used" percent={(used / limit) * 100} full={full} valueText={`${used} of ${limit}`} />}
        <span className="res-allowance-note">{text}</span>
      </div>
    </div>
  );
}

function Body({ organization, project, access }: { organization: Organization; project: Project; access: ProjectAccess }) {
  const slug = organization.slug;
  const root = `/app/${slug}/${project.slug}`;
  const location = useLocation();
  const sponsor = useSponsorUsage(organization);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Collection | null>(null);
  const [toast, setToast] = useState<{ text: string; open?: string }>(() => ({ text: (location.state as { toast?: string } | null)?.toast ?? '' }));
  const collections = useResource(`collections:${slug}/${project.slug}`, () => loadCollections(slug, project.slug));
  const rows = collections.data ?? [];
  const failure = collections.status === 'error' ? classifyAuthError(collections.error) : null;

  return (
    <ResourceFrame organization={organization} project={project} section="library" trail={[{ label: 'Collections' }]}>
      <ProjectLibraryNav current="collections" orgSlug={slug} projectSlug={project.slug} />
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Collections</h1>
          <p>Curated, ordered lists of exact references to cases and resources. A collection never runs anything, but it can seed a study.</p>
        </div>
        {access.canCreate && <div className="proj-actions"><Action variant="primary" onClick={() => setCreating(true)}>New collection</Action></div>}
      </header>

      <Allowance count={rows.length} sponsor={sponsor} />
      {!access.canCreate && <ReadOnlyNote role={access.role}>You can open collections and compare their revisions; creating and editing need MEMBER.</ReadOnlyNote>}
      {toast.text && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast.text}</span>
          {toast.open && <Link to={toast.open} viewTransition>Add its first items</Link>}
        </div>
      )}

      {collections.status === 'loading' && <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading collections…</span><Skeleton variant="panel" /></div>}
      {failure && (
        <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={failure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={collections.reload}>Retry</Action>}>
          {collectionsListRefusal(failure).text}
        </Notice>
      )}
      {collections.status === 'ready' && rows.length === 0 && (
        <section className="lib-dashed lib-nothing" aria-labelledby="coll-empty">
          <strong id="coll-empty">No collections</strong>
          <span>Group the cases and resources you want to keep together, each pinned to an exact revision, so a reviewer can reproduce what you cite.</span>
        </section>
      )}
      {rows.length > 0 && (
        <ul className="res-collections" aria-label="Collections">
          {rows.map(({ collection, revisions, known }) => {
            const latest = newestFirst(revisions)[0];
            return (
              <li key={collection.id} className="res-collection">
                <Link to={`${root}/collections/${encodeURIComponent(collection.slug)}`} viewTransition>{collection.name}</Link>
                {collection.description && <p>{collection.description}</p>}
                {latest && (
                  <span className="proj-chips">{typeSummary(latest.items).map((text) => <Chip key={text}>{text}</Chip>)}</span>
                )}
                <span className="res-collection-meta">
                  {!known ? 'Revisions couldn’t be read' : latest ? `${plural(latest.items.length, 'item')} · revision ${latest.revision}` : 'No revision yet'}
                </span>
                {access.canAdminister && <button type="button" className="res-linkish" onClick={() => setRemoving(collection)} aria-label={`Delete ${collection.name}`}>Delete</button>}
              </li>
            );
          })}
        </ul>
      )}
      {collections.status === 'ready' && rows.length > 0 && (
        <p className="org-muted">Your role here: <RoleChip role={access.role} />. Deleting needs ADMIN and leaves everything a collection pointed to untouched.</p>
      )}

      {creating && (
        <NewCollectionDialog
          organization={organization}
          project={project}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setToast({ text: `Collection “${created.name}” created.`, open: `${root}/collections/${encodeURIComponent(created.slug)}` });
            collections.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          confirmLabel="Delete collection"
          onClose={() => setRemoving(null)}
          run={() => platformApi.deleteCollection(slug, project.slug, removing.slug)}
          refusal={(caught) => collectionDeleteRefusal(caught).text}
          onDone={() => {
            setToast({ text: `${removing.name} deleted. The things it pointed to are untouched.` });
            setRemoving(null);
            collections.reload();
          }}
        >
          <p>The collection and its revisions leave {project.name}. The cases and resources it pinned are not touched.</p>
        </ConfirmDialog>
      )}
    </ResourceFrame>
  );
}

/** Collections (`coll-list`, `/app/:org/:project/collections`): the project’s ordered, versioned lists of exact references. */
export function CollList() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <Body organization={organization} project={project} access={access} />;
}
