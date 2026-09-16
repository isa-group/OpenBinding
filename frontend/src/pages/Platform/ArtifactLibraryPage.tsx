import { ArtifactVersionPicker } from '../../components/Artifacts/ArtifactVersionPicker';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { libraryApi, type Artifact, type ArtifactDraft, type ArtifactVersion, type DraftContent } from '../../api/library';
import { CodeEditor } from '../../components/CodeEditor/CodeEditor';
import { jsonChanges, sourceDiff } from '../../utils/workspaceViews';
import './PlatformPages.css';

export default function ArtifactLibraryPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Artifact[]>([]);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [drafts, setDrafts] = useState<ArtifactDraft[]>([]);
  const [draft, setDraft] = useState<ArtifactDraft | null>(null);
  const [text, setText] = useState('{}');
  const [label, setLabel] = useState('');
  const [compareId, setCompareId] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const identity = params.get('artifact') || '';
  const versionId = params.get('version') || '';
  const selected = versions.find(item => item.id === versionId);
  const artifact = items.find(item => item.id === identity);
  const editable = artifact?.organization_id === organization?.id && ['OWNER', 'ADMIN', 'MEMBER'].includes(organization?.effective_role || '');
  const publishable = editable && ['OWNER', 'ADMIN'].includes(organization?.effective_role || '');
  const reload = useCallback(async () => {
    if (!organization) return;
    const request = ++requestId.current;
    const items = await libraryApi.list(organization.slug, true);
    const own = items.some(item => item.id === identity && item.organization_id === organization.id);
    const [versions, drafts] = identity
      ? await Promise.all([libraryApi.versions(identity), own ? libraryApi.drafts(identity) : Promise.resolve([])])
      : [[], []];
    if (request === requestId.current) { setItems(items); setVersions(versions); setDrafts(drafts); }
  }, [organization, identity]);
  useEffect(() => {
    void reload().catch(err => setError(String(err)));
    return () => { requestId.current += 1; };
  }, [reload]);
  useEffect(() => {
    let active = true;
    if (versionId) setDraft(null);
    if (identity && versionId) libraryApi.content(identity, versionId).then(content => { if (active) setText(content); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [identity, versionId]);
  useEffect(() => { setCompareId(''); setBefore(null); }, [identity]);
  useEffect(() => {
    let active = true;
    setBefore(null);
    if (identity && compareId) libraryApi.content(identity, compareId).then(value => { if (active) setBefore(value); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [identity, compareId]);
  const mediaType = draft?.payload.media_type || selected?.manifest.mediaType || 'application/json';
  const comparison = useMemo(() => {
    if (before === null) return '';
    try {
      if (mediaType === 'application/json') return jsonChanges(JSON.parse(before), JSON.parse(text)).map(change =>
        `${change.kind} ${change.path}: ${JSON.stringify(change.before) ?? '<absent>'} → ${JSON.stringify(change.after) ?? '<absent>'}`).join('\n') || 'No content changes.';
    } catch { /* Invalid draft JSON can still be compared as text. */ }
    return sourceDiff(before, text).map(line => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.value}`).join('\n');
  }, [before, text, mediaType]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); await reload(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  const payload = (): DraftContent => ({
    content: (draft?.payload.media_type || selected?.manifest.mediaType || 'application/json') === 'application/json' ? JSON.parse(text) : text,
    media_type: draft?.payload.media_type || selected?.manifest.mediaType || 'application/json',
    contracts: draft?.payload.contracts || selected?.manifest.contracts || [],
    dependencies: draft?.payload.dependencies || selected?.manifest.dependencies || [],
  });
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!organization) return;
    const form = new FormData(event.currentTarget);
    void run(async () => {
      const item = await libraryApi.create(organization.slug, { name: String(form.get('name')), display_name: String(form.get('title')), kind: String(form.get('kind')), description: '' });
      setParams({ artifact: item.id });
      const content = item.kind === 'Study' ? { apiVersion: 'openbinding/study/v1', cases: [], engines: [], parameter_sets: [{}], seeds: [0] }
        : item.kind === 'Collection' ? { apiVersion: 'openbinding/collection/v1', members: [] } : {};
      const value = await libraryApi.draft(item.id, { content, media_type: 'application/json', contracts: [], dependencies: [] });
      setDraft(value); setText(JSON.stringify(content, null, 2));
    });
  };
  if (!organization) return <p>Select an organization.</p>;
  return <section className="platform-page">
    <header className="platform-page-heading"><div><span>Organization library</span><h1>Versioned artifacts</h1><p>Define resources once. Each case selects an immutable version.</p></div></header>
    {error && <p role="alert">{error}</p>}
    <div className="study-builder-fields"><label>Artifact<select value={identity} onChange={event => { setVersions([]); setDraft(null); setParams({ artifact: event.target.value }); }}><option value="">Choose an artifact</option>{items.map(item => <option value={item.id} key={item.id}>{item.display_name} · {item.kind}</option>)}</select></label>
      <label>Sealed version<select value={selected?.id || ''} onChange={event => setParams({ artifact: identity, version: event.target.value })}><option value="">Choose a version</option>{versions.map(item => <option key={item.id} value={item.id}>{item.ref.version} · {item.withdrawn ? 'withdrawn' : item.public ? 'public' : 'organization'}</option>)}</select></label></div>
    {artifact && <><h2>{artifact.display_name}</h2><p>{artifact.description}</p><code>{artifact.namespace}/{artifact.name}</code>
      {selected && <p><strong>Version {selected.ref.version}</strong> · <code>{selected.ref.versionDigest}</code></p>}
      {!!drafts.length && <label>Editable draft<select value={draft?.id || ''} onChange={event => {
        const value = drafts.find(item => item.id === event.target.value); if (value) { setDraft(value); setText(typeof value.payload.content === 'string' ? value.payload.content : JSON.stringify(value.payload.content, null, 2)); }
      }}><option value="">Choose a draft</option>{drafts.map(item => <option key={item.id} value={item.id}>Draft {item.id.slice(0, 8)} · revision {item.revision}</option>)}</select></label>}
      {draft && <label>Content format<select value={mediaType} onChange={event => setDraft({ ...draft, payload: { ...draft.payload, media_type: event.target.value } })}>
        <option value="application/json">JSON</option><option value="application/vnd.omg.bpmn+xml">BPMN XML</option><option value="text/plain">Text</option>
      </select></label>}
      {draft && artifact.kind === 'Collection' && <ArtifactVersionPicker org={organization.slug} onSelect={(_, version) => {
        try {
          const content = JSON.parse(text);
          if (!Array.isArray(content.members)) throw new Error('Collection members must be an array.');
          if (content.members.some((member: { versionDigest?: string }) => member.versionDigest === version.ref.versionDigest)) return;
          content.members.push(version.ref);
          const dependencies = draft.payload.dependencies.some(ref => ref.versionDigest === version.ref.versionDigest)
            ? draft.payload.dependencies : [...draft.payload.dependencies, version.ref];
          setDraft({ ...draft, payload: { ...draft.payload, dependencies } });
          setText(JSON.stringify(content, null, 2));
        } catch (err) { setError(String(err)); }
      }} />}
      <CodeEditor value={text} onChange={setText} language={mediaType === 'application/json' ? 'json' : mediaType.includes('xml') ? 'xml' : 'text'} readOnly={!draft} />
      {!!versions.length && <details><summary>Compare versions</summary><label>Compare with<select value={compareId} onChange={event => setCompareId(event.target.value)}><option value="">Choose a base version</option>{versions.map(item => <option key={item.id} value={item.id}>{item.ref.version}</option>)}</select></label>
        {before !== null && <pre aria-label="Version comparison" style={{ whiteSpace: 'pre-wrap' }}>{comparison}</pre>}
        {compareId && selected && <pre aria-label="Contract and dependency comparison" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(jsonChanges(versions.find(item => item.id === compareId)?.manifest, selected.manifest), null, 2)}</pre>}
      </details>}
      <div className="study-builder-options">
        {editable && !draft && <button disabled={busy} onClick={() => void run(async () => { const value = await libraryApi.draft(identity, payload(), selected?.id || null); setDraft(value); })}>New draft{selected ? ` from ${selected.ref.version}` : ''}</button>}
        {draft && <><button disabled={busy} onClick={() => void run(async () => { const next = await libraryApi.editDraft(identity, draft, payload()); setDraft({ ...draft, ...next, payload: payload() }); })}>Save draft</button>
          <label>Version label<input value={label} onChange={event => setLabel(event.target.value)} placeholder="Assigned automatically" /></label>
          <button disabled={busy} onClick={() => void run(async () => { const next = await libraryApi.editDraft(identity, draft, payload()); const version = await libraryApi.seal(identity, { ...draft, ...next }, label); setDraft(null); setParams({ artifact: identity, version: version.id }); })}>Seal version</button></>}
        {publishable && selected && !selected.public && <button disabled={busy} onClick={() => void run(async () => { await libraryApi.publish(identity, selected.id); })}>Publish this version</button>}
        {publishable && selected?.public && !selected.withdrawn && <button disabled={busy} onClick={() => void run(async () => { await libraryApi.withdraw(identity, selected.id); })}>Withdraw publication</button>}
        {project && selected && <button disabled={busy} onClick={() => void run(async () => { await libraryApi.associate(organization.slug, project.slug, identity); })}>Use in {project.name}</button>}
        {selected && <Link to={`?artifact=${identity}&version=${selected.id}`}>Permanent version link</Link>}
        {selected && <details><summary>Fork this version</summary><form onSubmit={event => {
          event.preventDefault(); const form = new FormData(event.currentTarget);
          void run(async () => {
            const content = await libraryApi.content(identity, selected.id);
            const fork = await libraryApi.create(organization.slug, { name: String(form.get('forkName')), display_name: String(form.get('forkTitle')), kind: artifact.kind, description: artifact.description });
            const value = await libraryApi.draft(fork.id, { content: selected.manifest.mediaType === 'application/json' ? JSON.parse(content) : content, media_type: selected.manifest.mediaType, contracts: selected.manifest.contracts, dependencies: selected.manifest.dependencies }, selected.id);
            setParams({ artifact: fork.id }); setDraft(value); setText(content);
          });
        }}><label>New stable name<input name="forkName" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" /></label><label>Display name<input name="forkTitle" required /></label><button disabled={busy}>Create fork draft</button></form></details>}
      </div>
    </>}
    <details className="study-builder"><summary>Create artifact</summary><form onSubmit={create} className="study-builder-fields"><label>Stable name<input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" /></label><label>Display name<input name="title" required /></label><label>Type<select name="kind">{['Application', 'BPMN', 'CandidateCatalog', 'ConstraintSet', 'Optimization', 'RoutingOverlay', 'Placement', 'Dataset', 'ExecutionConfiguration', 'AnalysisConfiguration', 'Report', 'Study', 'Collection', 'BindingDecision'].map(kind => <option key={kind}>{kind}</option>)}</select></label><button disabled={busy}>Create artifact</button></form></details>
  </section>;
}
