import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent, FormEvent } from 'react';
import {
  Activity, Archive, CheckCircle2, CircleDot, Cloud, CloudCog, Copy,
  GitBranch, LoaderCircle, LockKeyhole, Play, RefreshCw, Rocket, ShieldAlert,
  Trash2, Upload, XCircle,
} from 'lucide-react';
import { retrievePricingFromYaml } from 'pricing4ts';
import { PricingRenderer } from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';
import { platformApi } from '../../api/platform';
import type { PricingControlRoom } from '../../api/platform';
import { useTheme } from '../../contexts/theme';
import './PricingControlRoom.css';

interface Validation {
  valid: boolean;
  version: string | null;
  digest: string | null;
  plans: string[];
  add_ons: string[];
  errors: string[];
  warnings: string[];
}

function stateTone(state: string) {
  if (state === 'PUBLIC_RELEASE' || state === 'ACTIVE') return 'success';
  if (state === 'PRIVATE_DRAFT' || state === 'DRAINING') return 'warning';
  return 'muted';
}

function readableError(caught: unknown) {
  return caught instanceof Error ? caught.message : 'The control-plane operation failed.';
}

function operationMessage(result: unknown) {
  if (result && typeof result === 'object' && 'message' in result && typeof result.message === 'string') {
    return result.message;
  }
  if (result && typeof result === 'object' && 'created' in result && typeof result.created === 'number') {
    return `${result.created} remote version${result.created === 1 ? '' : 's'} synchronized.`;
  }
  return 'Operation completed.';
}

export function PricingControlRoomPage() {
  const { theme } = useTheme();
  const [room, setRoom] = useState<PricingControlRoom | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [yaml, setYaml] = useState('');
  const [baseline, setBaseline] = useState('');
  const [changelog, setChangelog] = useState('');
  const [manifest, setManifest] = useState('{\n  "reason": "new functionality"\n}');
  const [validation, setValidation] = useState<Validation | null>(null);
  const [clientValidation, setClientValidation] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const value = await platformApi.pricingControlRoom();
      setRoom(value);
      setSelected((current) => current || value.live || value.releases[0]?.version || '');
    } catch (caught) { setError(readableError(caught)); }
    finally { setBusy(null); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const loadVersion = useCallback(async (version: string) => {
    if (!version) return;
    setBusy('preview'); setError(null);
    try {
      const source = await platformApi.previewPricing(version);
      setYaml(source); setBaseline(source); setSelected(version); setValidation(null); setClientValidation(null);
    } catch (caught) { setError(readableError(caught)); }
    finally { setBusy(null); }
  }, []);

  useEffect(() => {
    if (selected && !yaml) void loadVersion(selected);
  }, [loadVersion, selected, yaml]);

  const selectedRelease = room?.releases.find((item) => item.version === selected);
  const diff = useMemo(() => {
    const before = baseline.split('\n'); const after = yaml.split('\n');
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) => ({
      line: index + 1, before: before[index] ?? '', after: after[index] ?? '', changed: before[index] !== after[index],
    })).filter((line) => line.changed);
  }, [baseline, yaml]);

  const validate = async () => {
    setBusy('validate'); setError(null); setNotice(null);
    try {
      retrievePricingFromYaml(yaml);
      setClientValidation('Pricing4TS 0.11.1 parsed the document successfully.');
    } catch (caught) {
      setClientValidation(`Pricing4TS: ${readableError(caught)}`);
    }
    try { setValidation(await platformApi.validatePricing(yaml)); }
    catch (caught) { setError(readableError(caught)); }
    finally { setBusy(null); }
  };

  const parsedManifest = () => {
    const value: unknown = JSON.parse(manifest);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Migration manifest must be a JSON object.');
    return value as Record<string, unknown>;
  };

  const mutate = async (name: string, operation: () => Promise<unknown>) => {
    setBusy(name); setError(null); setNotice(null);
    try { const result = await operation(); setNotice(operationMessage(result)); await reload(); }
    catch (caught) { setError(readableError(caught)); }
    finally { setBusy(null); }
  };

  const uploadFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError('Pricing files are limited to 2 MB.'); return; }
    const value = await file.text(); setYaml(value); setValidation(null); setClientValidation(null); setNotice(`Loaded ${file.name} locally. Nothing has been uploaded.`);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault(); void uploadFile(event.dataTransfer.files[0]);
  };

  const createDraft = () => mutate('draft', () => platformApi.createPricingDraft(yaml, changelog, parsedManifest()));
  const publish = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const version = String(new FormData(event.currentTarget).get('stableVersion'));
    if (!selectedRelease || selectedRelease.sphere_state !== 'PRIVATE_DRAFT') { setError('Select a private draft to publish.'); return; }
    void mutate('publish', () => platformApi.publishPricing(selectedRelease.version, version, changelog, parsedManifest()));
  };
  const fork = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const version = String(new FormData(event.currentTarget).get('draftVersion'));
    if (!selectedRelease) return;
    void mutate('fork', () => platformApi.forkPricing(selectedRelease.version, version, changelog));
  };
  const typedDelete = () => {
    if (!selectedRelease) return;
    const answer = window.prompt(`Type ${selectedRelease.version} to delete this private draft from SPHERE and its archived SPACE copy.`);
    if (answer !== selectedRelease.version) { setNotice('Deletion cancelled: confirmation did not match.'); return; }
    void mutate('delete', () => platformApi.deletePricingDraft(selectedRelease.version));
  };

  return <div className="pricing-room">
    <header className="pricing-room-heading">
      <div><span>Administrative control plane</span><h1>Pricing releases</h1><p>Prepare immutable drafts in SPHERE, validate their contract shape, deploy previews to SPACE and move the OpenBinding LIVE pointer deliberately.</p></div>
      <button type="button" onClick={() => void mutate('sync', () => platformApi.syncPricing())} disabled={Boolean(busy)}><RefreshCw aria-hidden="true" />Sync metadata</button>
    </header>

    {error && <div className="room-message is-error" role="alert"><XCircle aria-hidden="true" />{error}</div>}
    {notice && <div className="room-message is-success" role="status"><CheckCircle2 aria-hidden="true" />{notice}</div>}

    <section className="control-health" aria-label="Pricing control plane health">
      <article><div><Cloud aria-hidden="true" /><span>SPHERE</span></div><strong className={room?.sphere.reachable ? 'is-up' : 'is-down'}>{room?.sphere.reachable ? 'Connected' : room?.sphere.enabled ? 'Unavailable' : 'Not configured'}</strong><small>OpenBinding / openbinding</small></article>
      <article><div><CloudCog aria-hidden="true" /><span>SPACE 1.5</span></div><strong className={room?.space.reachable ? 'is-up' : 'is-down'}>{room?.space.reachable ? 'Connected' : room?.space.enabled ? 'Unavailable' : 'Not configured'}</strong><small>contracts and usage</small></article>
      <article><div><Activity aria-hidden="true" /><span>LIVE</span></div><strong>{room?.live ?? 'No release'}</strong><small>new contracts only</small></article>
      <article><div><ShieldAlert aria-hidden="true" /><span>Divergence</span></div><strong>{(room?.divergence.onlyInSphere.length ?? 0) + (room?.divergence.onlyLocal.length ?? 0)}</strong><small>metadata differences</small></article>
    </section>

    <div className="control-layout">
      <aside className="release-timeline">
        <header><div><span>Immutable history</span><h2>Versions</h2></div><small>{room?.releases.length ?? 0}</small></header>
        <div>{room?.releases.map((release) => <button key={release.id} type="button" className={selected === release.version ? 'is-selected' : ''} onClick={() => void loadVersion(release.version)}>
          <i className={release.is_live ? 'is-live' : ''}><CircleDot aria-hidden="true" /></i>
          <span><strong>{release.version}</strong><small>{new Date(release.created_at).toLocaleDateString()}</small></span>
          <span className={`state-tag is-${stateTone(release.sphere_state)}`}>{release.sphere_state === 'PRIVATE_DRAFT' ? 'private' : 'public'}</span>
          <span className={`state-tag is-${stateTone(release.space_state)}`}>{release.space_state.toLowerCase().replace('_', ' ')}</span>
        </button>)}</div>
        {!room?.releases.length && <p>No SPHERE versions have been synchronized.</p>}
      </aside>

      <main className="release-workspace">
        <div className="release-identity">
          <div><span>{selectedRelease?.sphere_state === 'PRIVATE_DRAFT' ? <LockKeyhole aria-hidden="true" /> : <Cloud aria-hidden="true" />}{selectedRelease?.sphere_state ?? 'LOCAL WORK'}</span><h2>{selectedRelease?.version ?? 'New pricing draft'}</h2><code>{selectedRelease?.digest ?? 'Not persisted'}</code></div>
          {selectedRelease?.public_url && <button type="button" onClick={() => void navigator.clipboard.writeText(selectedRelease.public_url!)}><Copy aria-hidden="true" />Copy public URL</button>}
        </div>

        <div className="pricing-editor-grid">
          <section className="pricing-editor">
            <header><div><span>Pricing2Yaml 3.1</span><h3>Source editor</h3></div><div><label className="upload-pricing" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><Upload aria-hidden="true" />Upload<input type="file" accept=".yaml,.yml,text/yaml" onChange={(event) => void uploadFile(event.target.files?.[0])} /></label><button type="button" onClick={() => void validate()} disabled={!yaml || Boolean(busy)}>{busy === 'validate' ? <LoaderCircle className="is-spinning" /> : <CheckCircle2 />}Validate</button></div></header>
            <textarea aria-label="Pricing YAML" spellCheck={false} value={yaml} onChange={(event) => { setYaml(event.target.value); setValidation(null); }} placeholder="Drop a Pricing2Yaml document here…" />
          </section>
          <section className="pricing-preview">
            <header><div><span>pricing-renderer 0.1.0</span><h3>Customer preview</h3></div><small>{validation?.valid ? 'validated' : 'awaiting validation'}</small></header>
            <div>{validation?.valid && yaml ? <PricingRenderer yaml={yaml} locale="en-US" pricingPath="/pricing" theme={theme} selectionEnabled={false} ctaEnabled={false} /> : <div className="preview-placeholder"><Play aria-hidden="true" /><strong>Validate to render</strong><p>Preview uses the same renderer exposed on the public pricing page.</p></div>}</div>
          </section>
        </div>

        <section className="validation-console">
          <header><span>Validation pipeline</span><strong>{validation ? validation.valid ? 'READY' : 'BLOCKED' : 'IDLE'}</strong></header>
          <div><p>{clientValidation ?? 'Pricing4TS 0.11.1 has not parsed this worktree yet.'}</p>{validation?.errors.map((item) => <p className="is-error" key={item}>{item}</p>)}{validation?.warnings.map((item) => <p className="is-warning" key={item}>{item}</p>)}</div>
          {validation?.valid && <footer><code>{validation.version}</code><code>{validation.plans.join(' · ')}</code><code>{validation.add_ons.length} add-ons</code></footer>}
        </section>

        <details className="diff-panel" open={diff.length > 0}><summary><GitBranch aria-hidden="true" />Diff against loaded version <span>{diff.length} changed lines</span></summary><div>{diff.slice(0, 160).map((line) => <article key={line.line}><span>{line.line}</span><del>{line.before || ' '}</del><ins>{line.after || ' '}</ins></article>)}{diff.length > 160 && <p>Showing the first 160 changed lines.</p>}</div></details>

        <section className="release-notes-form">
          <label>Changelog<textarea value={changelog} onChange={(event) => setChangelog(event.target.value)} rows={4} placeholder="Explain limits, capabilities and contract impact." /></label>
          <label>Migration manifest (JSON)<textarea value={manifest} onChange={(event) => setManifest(event.target.value)} rows={4} spellCheck={false} /></label>
        </section>

        <section className="release-actions">
          <header><span>Audited operations</span><h2>Lifecycle actions</h2></header>
          <div className="action-grid">
            <article><Upload /><h3>Persist draft</h3><p>Uploads this editor as a new private, immutable SPHERE version.</p><button type="button" onClick={() => void createDraft()} disabled={!validation?.valid || Boolean(busy)}>Create private draft</button></article>
            <article><GitBranch /><h3>Fork revision</h3><p>Clones the selected remote version and changes only its draft version.</p><form onSubmit={fork}><input name="draftVersion" required pattern="[0-9]+\.[0-9]+\.[0-9]+-draft\.[1-9][0-9]*" placeholder="0.2.0-draft.1" /><button disabled={!selectedRelease || Boolean(busy)}>Fork draft</button></form></article>
            <article><Rocket /><h3>Publish release</h3><p>Clones a private draft into a public SPHERE release. Public versions cannot be deleted.</p><form onSubmit={publish}><input name="stableVersion" required pattern="[0-9]+\.[0-9]+\.[0-9]+" placeholder="0.1.0" /><button disabled={selectedRelease?.sphere_state !== 'PRIVATE_DRAFT' || Boolean(busy)}>Publish</button></form></article>
            <article><Play /><h3>SPACE deployment</h3><p>Drafts deploy only for preview. Public releases can become LIVE for new contracts.</p><div><button onClick={() => selectedRelease && void mutate('deploy', () => platformApi.pricingAction(selectedRelease.version, 'deploy'))} disabled={!selectedRelease || !['NOT_DEPLOYED', 'ARCHIVED'].includes(selectedRelease.space_state) || Boolean(busy)}>Deploy / redeploy</button><button onClick={() => selectedRelease && void mutate('activate', () => platformApi.pricingAction(selectedRelease.version, 'activate'))} disabled={selectedRelease?.sphere_state !== 'PUBLIC_RELEASE' || Boolean(busy)}>Make LIVE</button></div></article>
            <article><Archive /><h3>Retire deployment</h3><p>Drain first, then archive only after contract reconciliation permits it.</p><div><button onClick={() => selectedRelease && void mutate('drain', () => platformApi.pricingAction(selectedRelease.version, 'drain'))} disabled={!selectedRelease || selectedRelease.is_live || selectedRelease.space_state !== 'ACTIVE' || Boolean(busy)}>Drain</button><button onClick={() => selectedRelease && void mutate('archive', () => platformApi.archivePricing(selectedRelease.version))} disabled={!selectedRelease || selectedRelease.is_live || !['ACTIVE', 'DRAINING'].includes(selectedRelease.space_state) || Boolean(busy)}>Archive</button></div></article>
            <article className="danger-action"><Trash2 /><h3>Delete private draft</h3><p>Requires the exact version. Public releases are structurally excluded.</p><button type="button" onClick={typedDelete} disabled={selectedRelease?.sphere_state !== 'PRIVATE_DRAFT' || selectedRelease?.is_live || Boolean(busy)}>Delete draft safely</button></article>
          </div>
        </section>
      </main>
    </div>
  </div>;
}
