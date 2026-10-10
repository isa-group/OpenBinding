import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Circle, X } from 'lucide-react';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import type { DraftContent } from '../../api/library';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../contexts/auth';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { DigestLine } from '../Cases/parts';
import { NeutralGate } from '../Organization/parts';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { accessIn, type ProjectAccess } from '../Project/projectModel';
import { ContentView } from './ContentView';
import { parseContent } from './contentModel';
import { PublishDialog, WithdrawDialog } from './dialogs';
import { classifyAuthError, contentFailure, draftRefusal, isMissing, marker, type PublishRefusal } from './libraryErrors';
import {
  citationOf, draftPath, exactReference, findVersion, itemKey, itemPath, mediaKindOf, newestFirst, PUBLICATION_LABELS, publicationOf, versionPath,
} from './libraryModel';
import { KindChip, LibraryFrame, LibrarySkeleton, MissingItem, PublicationChip } from './parts';
import { useLibraryItem, useVersions } from './useLibrary';

type CheckState = 'ok' | 'fail' | 'later';

interface PublishCheck {
  id: string;
  state: CheckState;
  text: string;
  fix?: { label: string; to: string };
}

interface Message {
  tone: 'success' | 'error' | 'warning' | 'info';
  text: string;
  link?: { to: string; label: string };
}

/** The dependencies of a version, looked up one by one, so the checklist can say which of them is still private. */
interface Looked {
  ref: LibraryVersion['manifest']['dependencies'][number];
  found?: LibraryVersion;
  /** Still being looked up. */
  pending?: boolean;
}

function useDependencyChecks(version: LibraryVersion, enabled: boolean) {
  return useResource<Looked[]>(
    `library-dependencies:${version.id}:${enabled}`,
    async () => {
      if (!enabled) return [];
      const refs = version.manifest.dependencies;
      const results = await Promise.allSettled(refs.map((ref) => libraryItemsApi.resolve(ref)));
      return refs.map((ref, index) => ({ ref, found: results[index].status === 'fulfilled' ? (results[index] as PromiseFulfilledResult<LibraryVersion>).value : undefined }));
    },
  );
}

function checklistFor(args: { slug: string; itemKey: string; item: LibraryItem; refusal: PublishRefusal | null; dependencies: Looked[] }): PublishCheck[] {
  const { slug, itemKey: key, item, refusal, dependencies } = args;
  const checks: PublishCheck[] = [];
  if (dependencies.length === 0) {
    checks.push({ id: 'dependencies', state: refusal?.kind === 'dependency' ? 'fail' : 'ok', text: refusal?.kind === 'dependency' ? `Something it depends on isn’t published.${refusal.detail ? ` ${refusal.detail}` : ''}` : 'Everything it depends on is published (it depends on nothing)' });
  }
  for (const { ref, found, pending } of dependencies) {
    const label = `${ref.name} v${ref.version}`;
    const fix = found ? { label: 'Open it', to: versionPath(slug, found.artifact_id, found.ref.version) } : undefined;
    if (pending) checks.push({ id: `dep-${ref.versionDigest}`, state: 'later', text: `Checking whether ${label} is published…` });
    else if (!found) checks.push({ id: `dep-${ref.versionDigest}`, state: 'later', text: `${label} can’t be checked from here; the server checks it when you publish.` });
    else if (!found.public) checks.push({ id: `dep-${ref.versionDigest}`, state: 'fail', text: `Depends on a private item: ${label} isn’t published (422 · private dependency).`, fix });
    else checks.push({ id: `dep-${ref.versionDigest}`, state: 'ok', text: `${label} is published`, fix });
  }
  const projects = { label: 'See where it’s used', to: `${itemPath(slug, key)}?tab=projects` };
  checks.push(refusal?.kind === 'case'
    ? { id: 'cases', state: 'fail', text: `Used by a case in a private project, or one that pins unpublished versions (422 · private case dependency).${refusal.detail ? ` ${refusal.detail}` : ''}`, fix: projects }
    : { id: 'cases', state: 'later', text: 'Cases that use it live in public projects: the server checks this when you publish.', fix: projects });
  if (item.kind === 'Study' || item.kind === 'ExecutionConfiguration') {
    checks.push(refusal?.kind === 'engine'
      ? { id: 'engines', state: 'fail', text: `The exact engine it names isn’t published (422 · private engine dependency).${refusal.detail ? ` ${refusal.detail}` : ''}` }
      : { id: 'engines', state: 'later', text: 'The engines it names are published: the server checks this when you publish.' });
  }
  if (item.kind === 'Report') {
    checks.push(refusal?.kind === 'evidence'
      ? { id: 'evidence', state: 'fail', text: `Its evidence isn’t public (422 · private evidence).${refusal.detail ? ` ${refusal.detail}` : ''}` }
      : { id: 'evidence', state: 'later', text: 'The studies and jobs it cites are public: the server checks this when you publish.' });
  }
  return checks;
}

const CHECK_ICONS = { ok: Check, fail: X, later: Circle } as const;

function VersionBody({ organization, item, version: fetched, versions }: {
  organization: Organization | undefined; item: LibraryItem; version: LibraryVersion; versions: LibraryVersion[];
}) {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const access: ProjectAccess = organization ? accessIn(organization, isAdmin) : accessIn({ effective_role: null });
  const slug = organization?.slug ?? '';
  const member = Boolean(organization);
  const own = Boolean(organization) && item.organization_id === organization?.id;
  const key = organization ? itemKey(item, organization.id, [item]) : item.id;
  const [override, setOverride] = useState<LibraryVersion | null>(null);
  const version = override?.id === fetched.id ? override : fetched;
  const [citedTitle, setCitedTitle] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [refusal, setRefusal] = useState<PublishRefusal | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const { copy, status } = useCopy();
  const state = publicationOf(version);

  const content = useResource<string>(`library-content:${item.id}:${version.id}`, () => libraryItemsApi.content(item.id, version.id));
  const dependencies = useDependencyChecks(version, own && state === 'members');
  const contentProblem = content.status === 'error' ? contentFailure(classifyAuthError(content.error)) : null;
  const parsed = content.data === undefined ? null : parseContent(content.data, version.manifest.mediaType);
  const looked: Looked[] = dependencies.data ?? version.manifest.dependencies.map((ref) => ({ ref, pending: true }));
  const checks = checklistFor({ slug, itemKey: key, item, refusal, dependencies: looked });
  const canPublish = own && access.canAdminister && state === 'members';
  const canWithdraw = own && access.canAdminister && state === 'published';
  const citation = state === 'published' ? citationOf(item, version, own ? organization?.name ?? null : null, citedTitle, window.location.origin) : null;

  const fork = async () => {
    if (busy || content.data === undefined) return;
    setBusy(true);
    try {
      const draft = await libraryItemsApi.createDraft(
        item.id,
        { content: parseContent(content.data, version.manifest.mediaType) as DraftContent['content'], media_type: version.manifest.mediaType, contracts: version.manifest.contracts, dependencies: version.manifest.dependencies },
        version.id,
      );
      setMessage({ tone: 'success', text: `Draft created from version ${version.ref.version}.`, link: { to: draftPath(slug, key, draft.id), label: 'Open the editor' } });
    } catch (caught) {
      setMessage({ tone: 'error', text: draftRefusal(caught).text });
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (content.data === undefined) return;
    const kind = mediaKindOf(version.manifest.mediaType);
    const blob = new Blob([content.data], { type: version.manifest.mediaType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.name}-${version.ref.version}.${kind === 'json' ? 'json' : kind === 'xml' ? 'xml' : 'txt'}`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage({ tone: 'info', text: `Downloaded ${link.download}.` });
  };

  const trail = [
    { label: 'Library', to: member ? `/app/${slug}/library` : undefined },
    { label: item.display_name, to: member ? itemPath(slug, key) : undefined },
    { label: `Version ${version.ref.version}` },
  ];
  const ownerName = own ? organization?.name : undefined;

  return (
    <LibraryFrame orgSlug={slug || item.namespace} orgName={organization?.name} trail={trail}>
      {!member && <Notice tone="info">You’re seeing this because the version is published. Drafts and other versions stay with the organization that owns it.</Notice>}
      {contentProblem === 'integrity' && (
        <Notice tone="error">
          The stored content doesn’t match this version’s fingerprint (409 · version integrity). It isn’t shown or served until an administrator checks it.
        </Notice>
      )}

      <header className="lib-head">
        <div className="lib-head-main">
          <span className="lib-chips-line"><KindChip kind={item.kind} /><PublicationChip state={state} /></span>
          <h1>{item.display_name} · version {version.ref.version}</h1>
          {member && versions.length > 1 && (
            <div className="lib-switch">
              <label htmlFor="lv-switch">Version</label>
              <select id="lv-switch" value={version.ref.version} onChange={(event) => navigate(versionPath(slug, key, event.target.value))}>
                {newestFirst(versions).map((other) => <option key={other.id} value={other.ref.version}>{other.ref.version} · {PUBLICATION_LABELS[publicationOf(other)].split(' · ')[0].toLowerCase()}</option>)}
              </select>
            </div>
          )}
          {formatDateTime(version.created_at) && <p className="lib-meta">Sealed {formatDateTime(version.created_at)}</p>}
        </div>
        <div className="proj-actions">
          {canPublish && <Action variant="primary" onClick={() => setPublishing(true)}>Publish…</Action>}
          {canWithdraw && <Action variant="danger-outline" onClick={() => setWithdrawing(true)}>Withdraw</Action>}
          {own && access.canCreate && <Action variant="secondary" busy={busy} disabled={content.data === undefined} onClick={() => void fork()}>New draft from this</Action>}
          <Action variant="secondary" disabled={content.data === undefined} onClick={download}>Download content</Action>
        </div>
      </header>

      {message && (
        <Notice tone={message.tone} action={message.link ? <Link to={message.link.to} viewTransition>{message.link.label}</Link> : undefined}>{message.text}</Notice>
      )}
      {state === 'withdrawn' && (
        <Notice tone="warning">Withdrawn: it’s no longer listed, but existing references still resolve. To publish again, seal a new version.</Notice>
      )}

      <section className="lib-card" aria-labelledby="lv-ref-title">
        <header><h2 id="lv-ref-title">Exact reference</h2></header>
        <dl className="lib-ref-grid">
          <div><dt>Owner space</dt><dd>{ownerName ? `${ownerName} ` : ''}<code title={version.ref.namespace}>{version.ref.namespace.length > 20 ? `${version.ref.namespace.slice(0, 8)}…${version.ref.namespace.slice(-4)}` : version.ref.namespace}</code></dd></div>
          <div><dt>Name</dt><dd><code>{version.ref.name}</code></dd></div>
          <div><dt>Version</dt><dd><code>{version.ref.version}</code></dd></div>
          <div><dt>Version fingerprint</dt><dd><DigestLine digest={version.ref.versionDigest} label="version" copyKey="version-digest" /></dd></div>
          <div><dt>Content fingerprint</dt><dd><DigestLine digest={version.contentDigest} label="content" copyKey="content-digest" /></dd></div>
        </dl>
        <div>
          <Action variant="secondary" size="sm" onClick={() => void copy(exactReference(version), 'reference')}>
            {status('reference') === 'copied' ? 'Reference copied' : status('reference') === 'failed' ? 'Copy failed' : 'Copy exact reference'}
          </Action>
        </div>
      </section>

      <section className="lib-content-block" aria-labelledby="lv-content-title">
        <h2 id="lv-content-title">Content</h2>
        {content.status === 'loading' && <div role="status" aria-busy="true"><span className="sr-only">Loading the content…</span><Skeleton variant="panel" /></div>}
        {contentProblem === 'integrity' && <p className="lib-dashed">The content isn’t shown because it no longer matches its fingerprint.</p>}
        {contentProblem === 'missing' && <p className="lib-dashed">The content of this version can’t be read (404).</p>}
        {contentProblem === 'other' && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={content.reload}>Retry</Action>}>
            {`The content couldn’t be loaded${marker(classifyAuthError(content.error))}.`}
          </Notice>
        )}
        {parsed !== null && <ContentView kind={item.kind} content={parsed} />}
      </section>

      {own && access.canCreate && state === 'members' && (
        <section aria-labelledby="lv-checks-title" className="lib-checks-block">
          <h2 id="lv-checks-title">Before it can be public</h2>
          <ul className="lib-publish-checks">
            {checks.map((check) => {
              const Icon = CHECK_ICONS[check.state];
              return (
                <li key={check.id} className={`is-${check.state}`}>
                  <Icon aria-hidden="true" />
                  <span><span className="sr-only">{check.state === 'ok' ? 'Passed: ' : check.state === 'fail' ? 'Needs fixing: ' : 'Checked when you publish: '}</span>{check.text}</span>
                  {check.fix && <Link to={check.fix.to} viewTransition>{check.fix.label}</Link>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {citation && (
        <section className="lib-cite" aria-labelledby="lv-cite-title">
          <span id="lv-cite-title" className="lib-cite-label">Cite as</span>
          <p>{citation.text}</p>
          <div className="proj-actions">
            <Action variant="secondary" size="sm" onClick={() => void copy(citation.text, 'citation')}>{status('citation') === 'copied' ? 'Citation copied' : 'Copy citation'}</Action>
            <Action variant="secondary" size="sm" onClick={() => void copy(citation.bibtex, 'bibtex')}>{status('bibtex') === 'copied' ? 'BibTeX copied' : 'Copy BibTeX'}</Action>
          </div>
        </section>
      )}

      {publishing && (
        <PublishDialog
          item={item}
          version={version}
          defaultTitle={citedTitle ?? item.display_name}
          onClose={() => setPublishing(false)}
          onPublished={(published, title) => {
            setOverride(published);
            setCitedTitle(title);
            setRefusal(null);
            setPublishing(false);
            setMessage({ tone: 'success', text: 'Published with its citation. Anyone can now read and verify this version.' });
          }}
          onRefused={(failed) => {
            setPublishing(false);
            setRefusal(failed);
            if (failed.kind === 'withdrawn') setOverride({ ...version, public: true, withdrawn: true });
            setMessage({
              tone: 'error',
              text: ['dependency', 'engine', 'evidence', 'case'].includes(failed.kind) ? `Can’t publish yet (422): see the checks below.` : failed.text,
            });
          }}
        />
      )}
      {withdrawing && (
        <WithdrawDialog
          item={item}
          version={version}
          onClose={() => setWithdrawing(false)}
          onWithdrawn={(withdrawn) => {
            setOverride(withdrawn);
            setWithdrawing(false);
            setMessage({ tone: 'warning', text: 'Withdrawn: it’s no longer listed, but existing references still resolve.' });
          }}
        />
      )}
    </LibraryFrame>
  );
}

function VersionLoader({ organization, slug, item }: { organization: Organization | undefined; slug: string; item: LibraryItem }) {
  const { version: param = '' } = useParams();
  const versions = useVersions(item.id);
  if (versions.status === 'loading') {
    return <div className="proj-body is-wide" role="status" aria-busy="true"><span className="sr-only">Loading the version…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>;
  }
  const list = versions.data ?? [];
  const found = findVersion(list, param);
  const back = organization ? itemPath(slug, itemKey(item, organization.id, [item])) : null;
  if (versions.status === 'error' || !found) {
    const failure = versions.status === 'error' ? classifyAuthError(versions.error) : null;
    return (
      <LibraryFrame orgSlug={slug || item.namespace} orgName={organization?.name} trail={[{ label: 'Library', to: organization ? `/app/${slug}/library` : undefined }, { label: item.display_name, to: back ?? undefined }, { label: 'Version' }]}>
        {failure && !isMissing(failure)
          ? <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={versions.reload}>Retry</Action>}>{`The versions couldn’t be loaded${marker(failure)}.`}</Notice>
          : <MissingItem orgSlug={slug} canGoBack={Boolean(organization)} title="Version not found">It doesn’t exist, or it isn’t published and you’re not a member of the organization that owns it (404).</MissingItem>}
      </LibraryFrame>
    );
  }
  return <VersionBody organization={organization} item={item} version={found} versions={list} />;
}

/** Version (`lib-version`, `/app/:org/library/:artifact/versions/:version`): a sealed version, its fingerprints and the way to publish it. */
export function LibVersion() {
  const { slug, organization, waiting } = useRouteOrganization();
  const { artifact = '' } = useParams();
  const loaded = useLibraryItem(slug, artifact, Boolean(organization));
  if (waiting || loaded.waiting) return <LibrarySkeleton />;
  if (!loaded.item) {
    // Someone outside the organization sees a version only when it is published; a name can't be resolved from outside.
    if (!organization && !isMissing(loaded.failure)) return <div className="proj-body is-wide"><NeutralGate /></div>;
    return (
      <LibraryFrame orgSlug={slug} orgName={organization?.name} trail={[{ label: 'Library', to: organization ? `/app/${slug}/library` : undefined }, { label: 'Not found' }]}>
        {isMissing(loaded.failure) || !loaded.failure
          ? <MissingItem orgSlug={slug} canGoBack={Boolean(organization)} title="Library item not found">It doesn’t exist or you can’t read it (404).</MissingItem>
          : <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={loaded.reload}>Retry</Action>}>{`The item couldn’t be loaded${marker(loaded.failure)}.`}</Notice>}
      </LibraryFrame>
    );
  }
  return <VersionLoader organization={organization} slug={slug} item={loaded.item} />;
}
