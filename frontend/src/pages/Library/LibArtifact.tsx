import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import type { ArtifactDraft, DraftContent } from '../../api/library';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { NeutralGate } from '../Organization/parts';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { accessIn } from '../Project/projectModel';
import { RefLine } from './ContentView';
import { parseContent, templateFor } from './contentModel';
import { UseInProjectDialog } from './dialogs';
import { classifyAuthError, draftRefusal, isMissing, marker, renameRefusal } from './libraryErrors';
import { draftPath, itemKey, kindLabel, newestFirst, publicationOf, versionPath } from './libraryModel';
import { KindChip, LibraryFrame, LibrarySkeleton, MissingItem, PublicationChip } from './parts';
import { useLibraryItem, useUsage, useVersions } from './useLibrary';

const TABS = ['versions', 'drafts', 'dependencies', 'projects'] as const;
type Tab = (typeof TABS)[number];

interface BodyProps {
  organization: Organization;
  projects: Project[];
  item: LibraryItem;
  reloadItem: () => void;
}

function ItemBody({ organization, projects, item, reloadItem }: BodyProps) {
  const { isAdmin } = useAuth();
  const access = accessIn(organization, isAdmin);
  const slug = organization.slug;
  const own = item.organization_id === organization.id;
  const canEdit = own && access.canCreate;
  const key = itemKey(item, organization.id, [item]);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = TABS.find((candidate) => candidate === requested) ?? 'versions';
  const [renaming, setRenaming] = useState(false);
  const [display, setDisplay] = useState(item.display_name);
  const [renameError, setRenameError] = useState<string>();
  const [startingDraft, setStartingDraft] = useState(false);
  const [base, setBase] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [using, setUsing] = useState(params.get('use') === '1');
  const [toast, setToast] = useState<{ text: string; to?: string; link?: string } | null>(null);

  const versions = useVersions(item.id);
  const mayReadDrafts = canEdit;
  const drafts = useResource<ArtifactDraft[]>(`library-drafts:${item.id}:${mayReadDrafts ? 'read' : 'skip'}`, () => (mayReadDrafts ? libraryItemsApi.drafts(item.id) : Promise.resolve([])));
  const usage = useUsage(slug, projects, tab === 'projects' || using);

  const sealed = newestFirst(versions.data ?? []);
  const draftList = drafts.data ?? [];
  const draftsBlocked = drafts.status === 'error' && classifyAuthError(drafts.error).status === 403;
  const placed = usage.data?.byItem.get(item.id) ?? [];
  const chosenBase = base ?? (sealed[0]?.id ?? '');

  const setTab = (next: string) => {
    const copy = new URLSearchParams(params);
    copy.set('tab', next);
    setParams(copy, { replace: true });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const next = display.trim();
    if (!next || busy) {
      setRenameError('Give it a display name.');
      return;
    }
    setBusy(true);
    setRenameError(undefined);
    try {
      await libraryItemsApi.rename(item.id, next);
      setRenaming(false);
      setToast({ text: 'Display name saved. The fixed name and all versions are unchanged.' });
      reloadItem();
    } catch (caught) {
      setRenameError(renameRefusal(caught).text);
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setDraftError(undefined);
    try {
      const from = sealed.find((version) => version.id === chosenBase);
      let value: DraftContent;
      if (from) {
        const text = await libraryItemsApi.content(item.id, from.id);
        value = { content: parseContent(text, from.manifest.mediaType) as DraftContent['content'], media_type: from.manifest.mediaType, contracts: from.manifest.contracts, dependencies: from.manifest.dependencies };
      } else {
        const start = templateFor(item.kind, item.name);
        value = { content: start.content as DraftContent['content'], media_type: start.mediaType, contracts: [], dependencies: [] };
      }
      const draft = await libraryItemsApi.createDraft(item.id, value, from?.id ?? null);
      setStartingDraft(false);
      setTab('drafts');
      setToast({ text: `Draft created${from ? ` from version ${from.ref.version}` : ''}.`, to: draftPath(slug, key, draft.id), link: 'Open the editor' });
      drafts.reload();
    } catch (caught) {
      setDraftError(draftRefusal(caught).text);
    } finally {
      setBusy(false);
    }
  };

  const versionFailure = versions.status === 'error' ? classifyAuthError(versions.error) : null;
  const countDrafts = drafts.status === 'ready' ? draftList.length : undefined;

  return (
    <LibraryFrame orgSlug={slug} orgName={organization.name} trail={[{ label: 'Library', to: `/app/${slug}/library` }, { label: item.display_name }]}>
      <header className="lib-head">
        <div className="lib-head-main">
          <KindChip kind={item.kind} />
          {!renaming
            ? (
              <div className="lib-title-line">
                <h1>{item.display_name}</h1>
                {canEdit && <button type="button" className="case-link-button" onClick={() => { setDisplay(item.display_name); setRenaming(true); }}>Rename</button>}
              </div>
            )
            : (
              <form className="lib-rename" onSubmit={(event) => void save(event)} noValidate>
                <div className="ui-field">
                  <label htmlFor="la-display">Display name</label>
                  <input id="la-display" value={display} maxLength={160} aria-invalid={renameError ? true : undefined} onChange={(event) => { setDisplay(event.target.value); setRenameError(undefined); }} autoFocus />
                </div>
                <Action type="submit" variant="primary" busy={busy}>Save</Action>
                <Action variant="secondary" onClick={() => { setRenaming(false); setRenameError(undefined); }} disabled={busy}>Cancel</Action>
              </form>
            )}
          {renameError && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{renameError}</div>}
          <p className="lib-meta"><code>{item.name}</code> · owned by {own ? organization.name : 'another organization'}</p>
          {item.description && <p className="lib-desc">{item.description}</p>}
        </div>
        <div className="proj-actions">
          {canEdit && <Action variant="primary" onClick={() => { setStartingDraft(true); setDraftError(undefined); }}>New draft</Action>}
          {access.canCreate && <Action variant="secondary" onClick={() => setUsing(true)}>Use in a project</Action>}
        </div>
      </header>

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast.text}</span>
          {toast.to && <Link to={toast.to} viewTransition>{toast.link}</Link>}
        </div>
      )}
      {!own && <Notice tone="info">This item belongs to another organization and is published. You can read its published versions and use it in your projects; only its owners can change it.</Notice>}
      {own && !access.canCreate && <ReadOnlyNote role={access.role}>You can read every version; drafts, renaming and new versions need MEMBER.</ReadOnlyNote>}

      {startingDraft && (
        <form className="lib-new-draft" onSubmit={(event) => void createDraft(event)} noValidate>
          <div className="ui-field">
            <label htmlFor="la-base">Start from</label>
            <select id="la-base" value={chosenBase} onChange={(event) => setBase(event.target.value)}>
              {sealed.map((version) => <option key={version.id} value={version.id}>Version {version.ref.version}</option>)}
              <option value="">Blank draft</option>
            </select>
          </div>
          <Action type="submit" variant="primary" busy={busy}>Create draft</Action>
          <Action variant="secondary" onClick={() => setStartingDraft(false)} disabled={busy}>Cancel</Action>
          {draftError && <div className="org-dialog-error lib-new-draft-error" role="alert"><TriangleAlert aria-hidden="true" />{draftError}</div>}
        </form>
      )}

      <div>
        <TabBar
          ariaLabel="Sections"
          prefix="la"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'versions', label: 'Versions', count: versions.status === 'ready' ? sealed.length : undefined },
            { id: 'drafts', label: 'Drafts', count: countDrafts },
            { id: 'dependencies', label: 'Dependencies' },
            { id: 'projects', label: 'Projects' },
          ]}
        />
        <TabPanel prefix="la" active={tab}>
          {tab === 'versions' && (
            <VersionsPanel slug={slug} itemKey={key} versions={sealed} loading={versions.status === 'loading'} failure={versionFailure ? `The versions couldn’t be loaded${marker(versionFailure)}.` : null} retry={versions.reload} />
          )}
          {tab === 'drafts' && (
            <DraftsPanel slug={slug} itemKey={key} drafts={draftList} versions={sealed} loading={drafts.status === 'loading'} blocked={draftsBlocked || !mayReadDrafts} own={own} />
          )}
          {tab === 'dependencies' && <DependenciesPanel versions={sealed} kind={item.kind} />}
          {tab === 'projects' && (
            <div className="lib-stack-list">
              {usage.status === 'loading' && <p className="org-muted" role="status">Looking in the projects…</p>}
              {usage.status === 'ready' && placed.length === 0 && <p className="lib-dashed">Not used in any project of {organization.name} yet.</p>}
              {placed.map((project) => (
                <Link key={project.id} className="lib-project-row" to={`/app/${slug}/${project.slug}/library`} viewTransition>
                  <strong>{project.name}</strong>
                  <span>associated</span>
                </Link>
              ))}
              {access.canCreate && <button type="button" className="case-link-button" onClick={() => setUsing(true)}>Add to {placed.length ? 'another' : 'a'} project</button>}
            </div>
          )}
        </TabPanel>
      </div>

      {using && (
        <UseInProjectDialog
          orgSlug={slug}
          item={item}
          projects={projects}
          already={placed.map((project) => project.slug)}
          onClose={() => {
            setUsing(false);
            if (params.has('use')) { const copy = new URLSearchParams(params); copy.delete('use'); setParams(copy, { replace: true }); }
          }}
          onAdded={(project) => {
            setUsing(false);
            setToast({ text: `“${item.display_name}” added to ${project.name}.`, to: `/app/${slug}/${project.slug}/library`, link: 'Open its library' });
            usage.reload();
          }}
        />
      )}
    </LibraryFrame>
  );
}

function VersionsPanel({ slug, itemKey: key, versions, loading, failure, retry }: {
  slug: string; itemKey: string; versions: LibraryVersion[]; loading: boolean; failure: string | null; retry: () => void;
}) {
  if (loading) return <p className="org-muted" role="status">Loading versions…</p>;
  if (failure) return <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={retry}>Retry</Action>}>{failure}</Notice>;
  if (versions.length === 0) return <p className="lib-dashed">No version has been sealed yet. Seal a draft to create version 1.</p>;
  return (
    <ol className="lib-versions" aria-label="Versions">
      {versions.map((version) => (
        <li key={version.id} className="lib-version-row">
          <span className={`lib-dot${version.public && !version.withdrawn ? ' is-public' : ''}`} aria-hidden="true">v{version.ref.version}</span>
          <span className="lib-version-main">
            <Link to={versionPath(slug, key, version.ref.version)} viewTransition>Version {version.ref.version}</Link>
            <small>content <code>{shortDigest(version.contentDigest)}</code> · version <code>{shortDigest(version.ref.versionDigest)}</code>{formatDate(version.created_at) ? ` · ${formatDate(version.created_at)}` : ''}</small>
          </span>
          <PublicationChip state={publicationOf(version)} />
        </li>
      ))}
    </ol>
  );
}

function DraftsPanel({ slug, itemKey: key, drafts, versions, loading, blocked, own }: {
  slug: string; itemKey: string; drafts: ArtifactDraft[]; versions: LibraryVersion[]; loading: boolean; blocked: boolean; own: boolean;
}) {
  if (!own) return <p className="lib-dashed">Drafts belong to the owning organization and aren’t visible from here.</p>;
  if (blocked) return <p className="lib-dashed">Open drafts are visible to MEMBER and above in the owning organization.</p>;
  if (loading) return <p className="org-muted" role="status">Loading drafts…</p>;
  if (drafts.length === 0) return <p className="lib-dashed">No open drafts.</p>;
  return (
    <ul className="lib-drafts" aria-label="Open drafts">
      {drafts.map((draft) => {
        const from = versions.find((version) => version.id === draft.based_on_id);
        return (
          <li key={draft.id}>
            <Link className="lib-draft-row" to={draftPath(slug, key, draft.id)} viewTransition>
              <strong>Draft · revision {draft.revision}</strong>
              <span>{from ? `Based on version ${from.ref.version}` : draft.based_on_id ? 'Based on another version' : 'Blank'}</span>
              <span className="lib-draft-open">Open editor</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function DependenciesPanel({ versions, kind }: { versions: LibraryVersion[]; kind: string }) {
  const withDependencies = versions.filter((version) => version.manifest.dependencies.length > 0);
  return (
    <div className="lib-deps">
      <section className="lib-card" aria-label="It depends on">
        <header><h3>It depends on</h3></header>
        {withDependencies.length === 0
          ? <p className="lib-empty-note">Nothing: a {kindLabel(kind).toLowerCase()} here stands on its own, as far as the sealed versions show.</p>
          : withDependencies.map((version) => (
            <div key={version.id} className="lib-dep-group">
              <Chip tone="accent">v{version.ref.version}</Chip>
              <ul>{version.manifest.dependencies.map((dependency) => <li key={dependency.versionDigest}><RefLine value={dependency} /></li>)}</ul>
            </div>
          ))}
      </section>
      <section className="lib-card" aria-label="Used by">
        <header><h3>Used by</h3></header>
        <p className="lib-empty-note">The library doesn’t list the cases and studies that use a version: each one pins the exact version it was built from. Open a case revision to see which versions it uses.</p>
      </section>
    </div>
  );
}

/** Library item (`lib-artifact`, `/app/:org/library/:artifact`): its identity, its sealed versions and its open drafts. */
export function LibArtifact() {
  const { slug, organization, waiting, context } = useRouteOrganization();
  const { artifact = '' } = useParams();
  const loaded = useLibraryItem(slug, artifact, Boolean(organization), Boolean(organization));
  if (waiting || (organization && loaded.waiting)) return <LibrarySkeleton />;
  if (!organization) return <div className="proj-body is-wide"><NeutralGate /></div>;
  if (!loaded.item) {
    const missing = isMissing(loaded.failure);
    return (
      <LibraryFrame orgSlug={slug} orgName={organization.name} trail={[{ label: 'Library', to: `/app/${slug}/library` }, { label: 'Not found' }]}>
        {missing || !loaded.failure
          ? <MissingItem orgSlug={slug} title="Library item not found">It doesn’t exist or you can’t read it (404).</MissingItem>
          : <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={loaded.reload}>Retry</Action>}>{`The item couldn’t be loaded${marker(loaded.failure)}.`}</Notice>}
      </LibraryFrame>
    );
  }
  return <ItemBody organization={organization} projects={context.projects} item={loaded.item} reloadItem={loaded.reload} />;
}
