import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import type { ArtifactDraft, ArtifactRef, DraftContent } from '../../api/library';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { DigestLine, ReadOnlyNote } from '../Cases/parts';
import { NeutralGate } from '../Organization/parts';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { accessIn } from '../Project/projectModel';
import { RefLine } from './ContentView';
import {
  checksFor, differences, freezeLines, isObject, jsonEqual, type Check, type Content, type JsonObject,
} from './contentModel';
import { DocumentForm } from './DocumentForm';
import { SealDialog } from './dialogs';
import { classifyAuthError, isMissing, marker, saveRefusal, sealRefusal } from './libraryErrors';
import { itemKey, itemPath, versionPath } from './libraryModel';
import { KindChip, LibraryFrame, LibrarySkeleton, MissingItem } from './parts';
import { useLibraryItem, useVersions } from './useLibrary';
import { VersionPicker } from './VersionPicker';

const MARKS: Record<Check['level'], string> = { ok: '✓', warn: '!', error: '✕' };

interface Conflict {
  theirs: ArtifactDraft;
}

function Editor({ organization, item, server, versions }: {
  organization: Organization; item: LibraryItem; server: ArtifactDraft; versions: LibraryVersion[];
}) {
  const { isAdmin } = useAuth();
  const access = accessIn(organization, isAdmin);
  const slug = organization.slug;
  const key = itemKey(item, organization.id, [item]);
  const [base, setBase] = useState<{ revision: number; payload: DraftContent }>({ revision: server.revision, payload: server.payload });
  const [content, setContent] = useState<Content>(server.payload.content as Content);
  const [dependencies, setDependencies] = useState<ArtifactRef[]>(server.payload.dependencies);
  const [formKey, setFormKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string>();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [gone, setGone] = useState(false);
  const [keyBlocked, setKeyBlocked] = useState(false);
  const [sealOpen, setSealOpen] = useState(false);
  const [sealBusy, setSealBusy] = useState(false);
  const [sealError, setSealError] = useState<string>();
  const [serverCheck, setServerCheck] = useState<string>();
  const [sealed, setSealed] = useState<LibraryVersion | null>(null);

  const readOnly = !access.canCreate || keyBlocked;
  const dirty = !(jsonEqual(content, base.payload.content) && jsonEqual(dependencies, base.payload.dependencies));
  const origin = versions.find((version) => version.id === server.based_on_id);
  const checks: Check[] = [
    ...checksFor(item.kind, content),
    ...(serverCheck ? [{ level: 'error' as const, text: `The server rejected the content (422): ${serverCheck}` }] : []),
  ];

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const payload = (): DraftContent => ({
    content: content as DraftContent['content'],
    media_type: base.payload.media_type,
    contracts: base.payload.contracts,
    dependencies,
  });

  const edit = (next: Content) => { setContent(next); setServerCheck(undefined); setProblem(undefined); };

  /** Somebody else saved first (or the draft was sealed): look at what is there now and put the two side by side. */
  const openConflict = async () => {
    try {
      const theirs = (await libraryItemsApi.drafts(item.id)).find((candidate) => candidate.id === server.id);
      if (!theirs) setGone(true);
      else setConflict({ theirs });
    } catch (caught) {
      setProblem(`The other copy couldn’t be read${marker(classifyAuthError(caught))}. Your changes are still here; try saving again.`);
    }
  };

  /** Saves with the revision the editor started from; returns the new revision, or `null` when it did not save. */
  const save = async (): Promise<number | null> => {
    const sent = payload();
    setSaving(true);
    setProblem(undefined);
    try {
      const saved = await libraryItemsApi.saveDraft(item.id, server.id, sent, base.revision);
      setBase({ revision: saved.revision, payload: sent });
      setAnnouncement('Draft saved.');
      return saved.revision;
    } catch (caught) {
      const refusal = saveRefusal(caught);
      if (refusal.kind === 'conflict') await openConflict();
      else {
        if (refusal.kind === 'forbidden') setKeyBlocked(true);
        if (refusal.kind === 'gone') setGone(true);
        setProblem(refusal.text);
        if (refusal.kind === 'invalid') setServerCheck(classifyAuthError(caught).message);
      }
      return null;
    } finally {
      setSaving(false);
    }
  };

  const keepMine = async () => {
    if (!conflict) return;
    const sent = payload();
    setSaving(true);
    try {
      const saved = await libraryItemsApi.saveDraft(item.id, server.id, sent, conflict.theirs.revision);
      setBase({ revision: saved.revision, payload: sent });
      setConflict(null);
      setAnnouncement(`Your changes were saved on top of revision ${conflict.theirs.revision}.`);
    } catch (caught) {
      const refusal = saveRefusal(caught);
      if (refusal.kind === 'conflict') await openConflict();
      else setProblem(refusal.text);
    } finally {
      setSaving(false);
    }
  };

  const takeTheirs = () => {
    if (!conflict) return;
    const { theirs } = conflict;
    setBase({ revision: theirs.revision, payload: theirs.payload });
    setContent(theirs.payload.content as Content);
    setDependencies(theirs.payload.dependencies);
    setFormKey((value) => value + 1);
    setConflict(null);
    setAnnouncement('Loaded the other version.');
  };

  const discard = () => {
    setContent(base.payload.content as Content);
    setDependencies(base.payload.dependencies);
    setFormKey((value) => value + 1);
    setServerCheck(undefined);
    setProblem(undefined);
    setAnnouncement('Changes discarded.');
  };

  const seal = async (label: string) => {
    setSealBusy(true);
    setSealError(undefined);
    try {
      let revision = base.revision;
      if (dirty) {
        const saved = await save();
        if (saved === null) {
          setSealOpen(false);
          return;
        }
        revision = saved;
      }
      try {
        const version = await libraryItemsApi.seal(item.id, server.id, revision, label || undefined);
        setSealed(version);
        setSealOpen(false);
        setAnnouncement('Version sealed.');
      } catch (caught) {
        const refusal = sealRefusal(caught, label);
        if (refusal.kind === 'conflict') {
          setSealOpen(false);
          await openConflict();
        } else if (refusal.kind === 'forbidden') {
          setKeyBlocked(true);
          setSealOpen(false);
          setProblem(refusal.text);
        } else {
          if (refusal.kind === 'invalid') setServerCheck(classifyAuthError(caught).message);
          setSealError(refusal.text);
        }
      }
    } finally {
      setSealBusy(false);
    }
  };

  const addDependency = (picked: LibraryItem, version: LibraryVersion) => {
    const ref = version.ref;
    if (!dependencies.some((existing) => existing.versionDigest === ref.versionDigest)) setDependencies([...dependencies, ref]);
    if (item.kind === 'Collection' && isObject(content) && Array.isArray(content.members)
      && !content.members.some((member) => isObject(member) && member.versionDigest === ref.versionDigest)) {
      edit({ ...content, members: [...content.members, ref as unknown as JsonObject] });
    }
    setAnnouncement(`${picked.display_name} version ${ref.version} added.`);
  };

  const trail = [
    { label: 'Library', to: `/app/${slug}/library` },
    { label: item.display_name, to: itemPath(slug, key) },
    { label: `Draft ${base.revision}` },
  ];

  if (sealed) {
    return (
      <LibraryFrame orgSlug={slug} orgName={organization.name} trail={trail}>
        <section className="lib-sealed" role="status" aria-labelledby="lib-sealed-title">
          <h1 id="lib-sealed-title">Version {sealed.ref.version} sealed</h1>
          <p>It can’t change any more. Its fingerprints were assigned by the server.</p>
          <dl className="lib-glance">
            <div><dt>Version fingerprint</dt><dd><DigestLine digest={sealed.ref.versionDigest} label="version" copyKey="sealed-version" /></dd></div>
            <div><dt>Content fingerprint</dt><dd><DigestLine digest={sealed.contentDigest} label="content" copyKey="sealed-content" /></dd></div>
          </dl>
          <div className="proj-actions">
            <Action to={versionPath(slug, key, sealed.ref.version)} variant="primary">Open the version</Action>
            <Action to={itemPath(slug, key)} variant="secondary">Back to {item.display_name}</Action>
          </div>
        </section>
      </LibraryFrame>
    );
  }

  const statusClass = saving ? 'is-saving' : dirty ? 'is-unsaved' : 'is-saved';

  return (
    <LibraryFrame orgSlug={slug} orgName={organization.name} trail={trail}>
      <header className="proj-title-row">
        <div className="proj-title">
          <KindChip kind={item.kind} />
          <h1>{item.display_name} · draft</h1>
          <p>{origin ? `Based on version ${origin.ref.version}. ` : server.based_on_id ? 'Based on another version. ' : 'Not based on a sealed version. '}Edits stay in this draft until you seal a new version.</p>
        </div>
        <div className="proj-actions">
          <Action variant="secondary" disabled={readOnly || !dirty || saving} onClick={discard}>Discard changes</Action>
          <Action variant="secondary" disabled={readOnly || !dirty} busy={saving} onClick={() => void save()}>Save draft</Action>
          <Action variant="primary" disabled={readOnly || Boolean(conflict) || gone} onClick={() => { setSealError(undefined); setSealOpen(true); }}>Seal version…</Action>
        </div>
      </header>

      <div className={`lib-statusbar ${statusClass}`} role="status">
        <strong>Draft revision {base.revision}</strong>
        <span>{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      </div>
      {keyBlocked && <Notice tone="warning" title="Read-only">This API key can’t write library items (403), so the editor is read-only.</Notice>}
      {!access.canCreate && !keyBlocked && <ReadOnlyNote role={access.role}>Drafts are read-only for your role; editing needs MEMBER.</ReadOnlyNote>}
      {problem && !conflict && <Notice tone="error">{problem}</Notice>}
      {gone && (
        <Notice tone="warning" title="This draft is no longer open" action={<Action to={itemPath(slug, key)} variant="secondary" size="sm">Back to {item.display_name}</Action>}>
          It was sealed or discarded while you were editing. Your copy is still on this page; copy what you need before leaving.
        </Notice>
      )}

      {conflict && (
        <section className="lib-conflict" role="alert" aria-labelledby="lib-conflict-title">
          <h2 id="lib-conflict-title">Someone saved this draft while you were editing (409 · draft conflict)</h2>
          <p>Nothing of yours was lost. Here’s what differs:</p>
          <div className="lib-table-scroll">
            <table className="lib-table is-conflict">
              <caption className="sr-only">Fields that differ between your draft and revision {conflict.theirs.revision}</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Yours</th>
                  <th scope="col">Saved by someone else · revision {conflict.theirs.revision}</th>
                </tr>
              </thead>
              <tbody>
                {differences(content, conflict.theirs.payload.content as Content).map((row) => (
                  <tr key={row.field}>
                    <th scope="row">{row.field}</th>
                    <td className="lib-mine">{row.mine}</td>
                    <td>{row.theirs}</td>
                  </tr>
                ))}
                {differences(content, conflict.theirs.payload.content as Content).length === 0 && (
                  <tr><td colSpan={3}>The content is the same; only the revision moved.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="proj-actions">
            <Action variant="primary" busy={saving} onClick={() => void keepMine()}>Keep mine on top of theirs</Action>
            <Action variant="secondary" disabled={saving} onClick={takeTheirs}>Use theirs</Action>
          </div>
        </section>
      )}

      <div className="lib-layout">
        <div className="lib-layout-main" key={formKey}>
          <DocumentForm kind={item.kind} content={content} onChange={edit} readOnly={readOnly || gone} />
        </div>
        <aside className="lib-layout-aside">
          <section className="lib-card is-compact" aria-label="Checks" aria-live="polite">
            <header><h3>Checks</h3></header>
            <ul className="lib-checks">
              {checks.map((check) => (
                <li key={check.text} className={`is-${check.level}`}>
                  <span aria-hidden="true">{MARKS[check.level]}</span>
                  <span><span className="sr-only">{check.level === 'ok' ? 'Passed: ' : check.level === 'warn' ? 'Note: ' : 'Problem: '}</span>{check.text}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="lib-card is-compact" aria-label="Language and links">
            <header><h3>Language and links</h3></header>
            <p className="lib-side-line">{isObject(content) && typeof content.apiVersion === 'string' ? <>Written in <code>{content.apiVersion}</code></> : 'A file, not a structured document'}</p>
            {dependencies.length === 0
              ? <p className="lib-side-line">Depends on nothing else</p>
              : (
                <ul className="lib-deps-list" aria-label="Exact dependencies">
                  {dependencies.map((dependency) => (
                    <li key={dependency.versionDigest}>
                      <RefLine value={dependency} />
                      {!readOnly && (
                        <button type="button" className="lib-remove" aria-label={`Remove dependency ${dependency.name} ${dependency.version}`} onClick={() => setDependencies(dependencies.filter((other) => other.versionDigest !== dependency.versionDigest))}>
                          <X aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            <p className="lib-side-line lib-muted">Cases that use it pin an exact sealed version, never this draft.</p>
          </section>
          {!readOnly && !gone && (
            <VersionPicker
              orgSlug={slug}
              exceptItem={item.id}
              title={item.kind === 'Collection' ? 'Add a version to the collection' : 'Add a dependency'}
              onPick={addDependency}
            />
          )}
        </aside>
      </div>

      <p className="org-muted"><Link to={itemPath(slug, key)} viewTransition>Back to {item.display_name}</Link></p>

      <div className="sr-only" aria-live="polite">{announcement}</div>
      {sealOpen && (
        <SealDialog
          freezes={freezeLines(item.kind, content, dependencies.length, origin?.ref.version ?? null)}
          error={sealError}
          busy={sealBusy}
          onClose={() => setSealOpen(false)}
          onSeal={(label) => void seal(label)}
        />
      )}
    </LibraryFrame>
  );
}

function DraftNotFound({ slug, itemKey: key, name, children }: { slug: string; itemKey: string; name: string; children: string }) {
  return (
    <LibraryFrame orgSlug={slug} trail={[{ label: 'Library', to: `/app/${slug}/library` }, { label: name, to: itemPath(slug, key) }, { label: 'Draft' }]}>
      <MissingItem orgSlug={slug} title="Draft not found">{children}</MissingItem>
    </LibraryFrame>
  );
}

function DraftLoader({ organization, item }: { organization: Organization; item: LibraryItem }) {
  const { draft: draftId = '' } = useParams();
  const slug = organization.slug;
  const key = itemKey(item, organization.id, [item]);
  const drafts = useResource<ArtifactDraft[]>(`library-drafts:${item.id}`, () => libraryItemsApi.drafts(item.id));
  const versions = useVersions(item.id);

  if (drafts.status === 'loading' || versions.status === 'loading') {
    return <div className="proj-body is-wide" role="status" aria-busy="true"><span className="sr-only">Loading the draft…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>;
  }
  if (drafts.status === 'error') {
    const failure = classifyAuthError(drafts.error);
    if (failure.status === 403) {
      return (
        <LibraryFrame orgSlug={slug} orgName={organization.name} trail={[{ label: 'Library', to: `/app/${slug}/library` }, { label: item.display_name, to: itemPath(slug, key) }, { label: 'Draft' }]}>
          <Notice tone="warning" title="Drafts are for members" action={<Action to={itemPath(slug, key)} variant="secondary" size="sm">Back to {item.display_name}</Action>}>
            {`Your role (or this API key) can’t read drafts${marker(failure)}. You can still read every sealed version.`}
          </Notice>
        </LibraryFrame>
      );
    }
    return (
      <LibraryFrame orgSlug={slug} orgName={organization.name} trail={[{ label: 'Library', to: `/app/${slug}/library` }, { label: item.display_name, to: itemPath(slug, key) }, { label: 'Draft' }]}>
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={drafts.reload}>Retry</Action>}>{`The draft couldn’t be loaded${marker(failure)}.`}</Notice>
      </LibraryFrame>
    );
  }
  const server = (drafts.data ?? []).find((candidate) => candidate.id === draftId);
  if (!server) {
    return (
      <DraftNotFound slug={slug} itemKey={key} name={item.display_name}>
        It was sealed, discarded or never existed. Open the item to see its versions and its open drafts.
      </DraftNotFound>
    );
  }
  return <Editor key={server.id} organization={organization} item={item} server={server} versions={versions.data ?? []} />;
}

/** Draft editor (`lib-draft`, `/app/:org/library/:artifact/drafts/:draft`): a draft edited through forms, saved optimistically and sealed into a version. */
export function LibDraft() {
  const { slug, organization, waiting } = useRouteOrganization();
  const { artifact = '' } = useParams();
  const loaded = useLibraryItem(slug, artifact, Boolean(organization), Boolean(organization));
  if (waiting || (organization && loaded.waiting)) return <LibrarySkeleton />;
  if (!organization) return <div className="proj-body is-wide"><NeutralGate /></div>;
  if (!loaded.item) {
    return (
      <LibraryFrame orgSlug={slug} orgName={organization.name} trail={[{ label: 'Library', to: `/app/${slug}/library` }, { label: 'Not found' }]}>
        {isMissing(loaded.failure) || !loaded.failure
          ? <MissingItem orgSlug={slug} title="Library item not found">It doesn’t exist or you can’t read it (404).</MissingItem>
          : <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={loaded.reload}>Retry</Action>}>{`The item couldn’t be loaded${marker(loaded.failure)}.`}</Notice>}
      </LibraryFrame>
    );
  }
  if (loaded.item.organization_id !== organization.id) {
    return (
      <DraftNotFound slug={slug} itemKey={loaded.item.id} name={loaded.item.display_name}>
        Drafts belong to the organization that owns the item.
      </DraftNotFound>
    );
  }
  return <DraftLoader organization={organization} item={loaded.item} />;
}
