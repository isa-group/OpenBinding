import { useId, useMemo, useState, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import { retrievePricingFromYaml } from 'pricing4ts';
import { platformApi } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { AdminFrame, AdminOnly, FailureNotice } from './AdminChrome';
import type { Failure } from './adminModel';
import { ChangeList, PricingPreview, ValidationPanel } from './PricingParts';
import { PricingEditor } from './PricingEditor';
import {
  DRAFT_VERSION, RELEASE_VERSION, buildYaml, describePricingFailure, diffPricing, editFrom, issuesOf, readValidation, tryReadPricing,
  type DraftEdit, type PricingDoc, type ServerValidation,
} from './pricingModel';
import './AdminPricing.css';

type Step = 1 | 2 | 3 | 4 | 5;
type Start = 'edit' | 'fork' | 'file';

const STEPS: Array<[Step, string]> = [
  [1, 'Where to start'], [2, 'Plans, features and limits'], [3, 'Validate'], [4, 'Save a private draft'], [5, 'Publish a release'],
];

const STARTS: Array<[Start, string, string]> = [
  ['edit', 'Edit a copy of a version', 'Load a version into forms, change plans and limits, then validate and save it as a new draft.'],
  ['fork', 'Fork a version as it is', 'Copy a version into a new private draft right away. Change its content later by forking the draft again.'],
  ['file', 'Load a YAML file', 'Read a Pricing2Yaml file from your computer into the forms. Nothing is uploaded until you save.'],
];

/** The next minor version as a first draft: `0.1.0` → `0.2.0-draft.1`. */
function suggestDraft(version: string): string {
  const parts = /^(\d+)\.(\d+)\.\d+/.exec(version);
  return parts ? `${parts[1]}.${Number(parts[2]) + 1}.0-draft.1` : '0.1.0-draft.1';
}

function manifestOf(reason: string, extra: string): { manifest: Record<string, unknown> } | { error: string } {
  const manifest: Record<string, unknown> = reason.trim() ? { reason: reason.trim() } : {};
  if (extra.trim() === '') return { manifest };
  try {
    const parsed: unknown = JSON.parse(extra);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'The extra manifest must be a JSON object.' };
    return { manifest: { ...manifest, ...parsed as Record<string, unknown> } };
  } catch {
    return { error: 'The extra manifest isn’t valid JSON.' };
  }
}

interface Base {
  doc: PricingDoc;
  from: string;
}

function DraftScreen() {
  const ids = useId();
  const room = useResource('admin-pricing-draft-room', () => platformApi.pricingControlRoom());
  const data = room.data ?? room.stale;
  const releases = data?.releases ?? [];
  const liveVersion = data?.live ?? null;
  const roomFailure = room.status === 'error' ? describePricingFailure(room.error, 'The pricing versions couldn’t be loaded') : null;

  const [step, setStep] = useState<Step>(1);
  const [reached, setReached] = useState<Step>(1);
  const [start, setStart] = useState<Start>('edit');
  const [chosen, setChosen] = useState<string | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [edit, setEdit] = useState<DraftEdit | null>(null);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [reason, setReason] = useState('new functionality');
  const [extraManifest, setExtraManifest] = useState('');
  const [releaseVersion, setReleaseVersion] = useState('');
  const [validated, setValidated] = useState<{ yaml: string; validation: ServerValidation; client: string } | null>(null);
  const [saved, setSaved] = useState<{ version: string; message: string } | null>(null);
  const [published, setPublished] = useState<{ version: string; message: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [showRenderer, setShowRenderer] = useState(false);
  const [busy, setBusy] = useState<'load' | 'validate' | 'save' | 'fork' | 'publish' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const picked = chosen ?? liveVersion ?? releases[0]?.version ?? '';
  const live = useResource(`admin-pricing-draft-live:${liveVersion ?? ''}`, async () => (liveVersion ? tryReadPricing(await platformApi.previewPricing(liveVersion)) : null));

  const built = useMemo(() => {
    if (advanced !== null) return { yaml: advanced };
    if (!base || !edit) return { yaml: '' };
    try {
      return { yaml: buildYaml(base.doc, edit, draftVersion || suggestDraft(base.doc.version)) };
    } catch (error: unknown) {
      return { yaml: '', error: error instanceof Error ? error.message : 'The document couldn’t be built.' };
    }
  }, [advanced, base, edit, draftVersion]);
  const yaml = built.yaml;
  const edited = useMemo(() => (yaml ? tryReadPricing(yaml) : null), [yaml]);
  const issues = useMemo(() => (base && edit && advanced === null ? issuesOf(base.doc, edit) : []), [base, edit, advanced]);
  const liveDoc = live.data ?? live.stale;
  const baseline = liveDoc && 'doc' in liveDoc ? liveDoc.doc : null;
  const changes = useMemo(() => (baseline && edited && 'doc' in edited ? diffPricing(baseline, edited.doc) : []), [baseline, edited]);
  const manifest = manifestOf(reason, extraManifest);
  const current = validated && validated.yaml === yaml ? validated : null;
  const versionOk = DRAFT_VERSION.test(draftVersion);

  const go = (next: Step) => {
    setStep(next);
    setReached((value) => (next > value ? next : value));
    setFailure(null);
    setNotice(null);
  };

  const adopt = (doc: PricingDoc, from: string) => {
    setBase({ doc, from });
    setEdit(editFrom(doc));
    setAdvanced(null);
    setValidated(null);
    setDraftVersion(suggestDraft(doc.version));
    go(2);
  };

  const load = async () => {
    if (!picked) return;
    setBusy('load');
    setFailure(null);
    try {
      const result = tryReadPricing(await platformApi.previewPricing(picked));
      if ('error' in result) setFailure({ status: null, code: null, tone: 'error', quota: null, title: `${picked} couldn’t be read as plans and limits`, text: result.error });
      else adopt(result.doc, picked);
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, `The content of ${picked} couldn’t be loaded`));
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFailure(null);
    if (file.size > 2 * 1024 * 1024) {
      setFailure({ status: null, code: null, tone: 'error', quota: null, title: 'That file is too large', text: 'Pricing files are limited to 2 MB.' });
      return;
    }
    const result = tryReadPricing(await file.text());
    if ('error' in result) setFailure({ status: null, code: null, tone: 'error', quota: null, title: `${file.name} couldn’t be read`, text: result.error });
    else {
      adopt(result.doc, file.name);
      setNotice(`Loaded ${file.name} on this computer. Nothing has been uploaded.`);
    }
  };

  const fork = async () => {
    setBusy('fork');
    setFailure(null);
    try {
      const result = await platformApi.forkPricing(picked, draftVersion, changelog);
      setSaved({ version: result.release.version, message: result.message });
      go(4);
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, 'The draft couldn’t be forked'));
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    setBusy('validate');
    setFailure(null);
    let client: string;
    try {
      retrievePricingFromYaml(yaml);
      client = 'Pricing4TS parsed the document successfully.';
    } catch (error: unknown) {
      client = `Pricing4TS: ${error instanceof Error ? error.message : 'the document couldn’t be parsed.'}`;
    }
    try {
      setValidated({ yaml, validation: readValidation(await platformApi.validatePricing(yaml)), client });
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, 'The document couldn’t be validated'));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if ('error' in manifest) return;
    setBusy('save');
    setFailure(null);
    try {
      const result = await platformApi.createPricingDraft(yaml, changelog, manifest.manifest);
      setSaved({ version: result.release.version, message: result.message });
      setReleaseVersion('');
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, 'The draft wasn’t saved'));
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!saved || 'error' in manifest) return;
    setBusy('publish');
    setFailure(null);
    try {
      const result = await platformApi.publishPricing(saved.version, releaseVersion, changelog, manifest.manifest);
      setPublished({ version: result.release.version, message: result.message });
    } catch (error: unknown) {
      setFailure(describePricingFailure(error, 'The release wasn’t published'));
    } finally {
      setBusy(null);
      setAsking(false);
    }
  };

  const releasePath = (version: string) => `/app/admin/pricing/${encodeURIComponent(version)}`;

  return (
    <AdminFrame
      section="pricing"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Pricing', to: '/app/admin/pricing' }, { label: 'New draft' }]}
      title="New pricing draft"
      lede="Start from an existing version, adjust plans and limits, validate, save a private draft and, when it’s ready, publish it as an immutable release. Publishing doesn’t make it LIVE, and nothing here certifies that a draft is correct."
    >
      <ol className="apr-steps" aria-label="Steps">
        {STEPS.map(([number, label]) => (
          <li key={number}>
            <button type="button" aria-current={step === number ? 'step' : undefined} disabled={number > reached} onClick={() => go(number)} className={number < step ? 'is-done' : undefined}>
              <span aria-hidden="true">{number < step ? '✓' : number}</span>{label}
            </button>
          </li>
        ))}
      </ol>

      {failure && <FailureNotice failure={failure} />}
      {roomFailure && <FailureNotice failure={roomFailure} onRetry={room.reload} />}
      {notice && <Notice tone="success">{notice}</Notice>}

      {step === 1 && (
        <section className="adm-card" aria-labelledby="apr-s1">
          <h2 id="apr-s1">1 · Where to start</h2>
          <div className="adm-plans" role="radiogroup" aria-label="Start from">
            {STARTS.map(([id, label, help]) => (
              <button key={id} type="button" role="radio" aria-checked={start === id} className={`adm-choice${start === id ? ' is-on' : ''}`} onClick={() => setStart(id)}>
                <strong>{label}</strong><span>{help}</span>
              </button>
            ))}
          </div>

          {start !== 'file' && (
            <>
              {room.status === 'loading' && !data && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading the versions</span><Skeleton variant="tile" /></div>}
              {releases.length === 0 && data && <p className="adm-muted">No version is recorded yet. Sync metadata in the control room, or load a file.</p>}
              {releases.length > 0 && (
                <div className="apr-pick" role="radiogroup" aria-label="Version">
                  {releases.map((release) => (
                    <button key={release.id} type="button" role="radio" aria-checked={picked === release.version} className={`apr-pill${picked === release.version ? ' is-on' : ''}`} onClick={() => setChosen(release.version)}>
                      {release.version}{release.is_live ? ' · LIVE' : release.sphere_state === 'PRIVATE_DRAFT' ? ' · draft' : ''}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {start === 'edit' && (
            <div className="adm-buttons">
              <Action variant="primary" busy={busy === 'load'} disabled={!picked || busy !== null} onClick={() => void load()}>Next: edit plans</Action>
            </div>
          )}

          {start === 'fork' && (
            <>
              <div className="adm-form-grid">
                <div className="adm-field">
                  <label className="adm-label" htmlFor={`${ids}-fork`}>New draft version</label>
                  <input id={`${ids}-fork`} value={draftVersion} onChange={(event) => setDraftVersion(event.target.value)} placeholder="0.2.0-draft.1" spellCheck={false} aria-invalid={draftVersion !== '' && !versionOk ? true : undefined} aria-describedby={`${ids}-fork-hint`} />
                  <span id={`${ids}-fork-hint`} className="adm-muted">Format X.Y.Z-draft.N</span>
                </div>
                <label className="adm-field">
                  <span className="adm-label">What changed (changelog)</span>
                  <input value={changelog} onChange={(event) => setChangelog(event.target.value)} maxLength={4000} />
                </label>
              </div>
              <div className="adm-buttons">
                <Action variant="primary" busy={busy === 'fork'} disabled={!picked || !versionOk || busy !== null} onClick={() => void fork()}>Fork {picked || 'a version'} into {versionOk ? draftVersion : 'a new draft'}</Action>
              </div>
            </>
          )}

          {start === 'file' && (
            <label className="apr-file">
              <Upload aria-hidden="true" />
              <span>Choose a Pricing2Yaml file (.yaml, up to 2 MB)</span>
              <input type="file" accept=".yaml,.yml,text/yaml" onChange={(event) => void readFile(event)} />
            </label>
          )}
        </section>
      )}

      {step === 2 && (
        <section className="adm-card" aria-labelledby="apr-s2">
          <div className="adm-card-head">
            <h2 id="apr-s2">2 · Plans, features and limits</h2>
            <span className="adm-muted">Starting from {base?.from ?? '—'}</span>
          </div>
          {!base || !edit ? (
            <p className="adm-muted">Choose where to start in step 1 first.</p>
          ) : (
            <>
              <Notice tone="warning" title="Drafts must never contain secrets">Anything that looks like a key or token is refused.</Notice>
              {advanced !== null && <Notice tone="info" title="You’re editing the source">The forms are paused. Use them again to read the document back into plans and limits.</Notice>}
              <PricingEditor doc={base.doc} edit={edit} onChange={setEdit} disabled={advanced !== null} />
              {issues.length > 0 && (
                <ul className="apr-issues" aria-label="What needs fixing">
                  {issues.map((issue) => <li key={`${issue.where}-${issue.text}`}><strong>{issue.where}</strong> {issue.text}</li>)}
                </ul>
              )}
              {'error' in built && <Notice tone="error">{built.error}</Notice>}

              <div className="apr-source">
                {advanced === null ? (
                  <Action size="sm" variant="link" onClick={() => setAdvanced(yaml)}>Advanced: edit the YAML source</Action>
                ) : (
                  <>
                    <label className="adm-field">
                      <span className="adm-label">Pricing YAML</span>
                      <textarea aria-label="Pricing YAML" className="apr-yaml" spellCheck={false} value={advanced} onChange={(event) => setAdvanced(event.target.value)} />
                    </label>
                    <Action
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const result = tryReadPricing(advanced);
                        if ('error' in result) setFailure({ status: null, code: null, tone: 'error', quota: null, title: 'The source couldn’t be read back', text: result.error });
                        else adopt(result.doc, base.from);
                      }}
                    >Use the forms again</Action>
                  </>
                )}
              </div>

              <div className="adm-buttons">
                <Action variant="secondary" onClick={() => go(1)}>Back</Action>
                <Action variant="primary" disabled={issues.length > 0 || !yaml} onClick={() => go(3)}>Next: validate</Action>
              </div>
            </>
          )}
        </section>
      )}

      {step === 3 && (
        <section className="adm-card" aria-labelledby="apr-s3">
          <h2 id="apr-s3">3 · Validate</h2>
          {!base ? (
            <p className="adm-muted">Choose where to start in step 1 first.</p>
          ) : (
            <>
              <div className="adm-field apr-version">
                <label className="adm-label" htmlFor={`${ids}-draft`}>Draft version</label>
                <input id={`${ids}-draft`} value={draftVersion} onChange={(event) => setDraftVersion(event.target.value)} placeholder="0.2.0-draft.1" spellCheck={false} aria-invalid={draftVersion !== '' && !versionOk ? true : undefined} disabled={advanced !== null} aria-describedby={`${ids}-draft-hint`} />
                <span id={`${ids}-draft-hint`} className="adm-muted">{advanced !== null ? 'The version is whatever the source says.' : 'Format X.Y.Z-draft.N'}</span>
              </div>
              <div className="adm-buttons">
                <Action variant="primary" busy={busy === 'validate'} disabled={(advanced === null && !versionOk) || !yaml || busy !== null} onClick={() => void validate()}>Validate</Action>
                {current && <span className="adm-muted">Validated just now. Changing anything asks for another validation.</span>}
              </div>
              {busy === 'validate' && <div role="status" className="adm-busy"><span className="adm-spinner" aria-hidden="true" />Validating…</div>}
              {current && <ValidationPanel validation={current.validation} client={current.client} />}

              <h3 className="apr-subhead">Compared with LIVE {liveVersion ?? ''}</h3>
              {live.status === 'loading' && !liveDoc && <p className="adm-muted">Reading the LIVE version…</p>}
              {liveVersion === null && live.status !== 'loading' && <p className="adm-muted">No version is LIVE, so there is nothing to compare with.</p>}
              {baseline && changes.length === 0 && <p className="adm-muted">No difference from the LIVE version.</p>}
              {baseline && <ChangeList changes={changes} label="Changes against LIVE" />}
              {liveDoc && 'error' in liveDoc && <p className="adm-muted">The LIVE version couldn’t be read for comparison: {liveDoc.error}</p>}

              {current?.validation.valid && (
                <div className="apr-preview">
                  <Action size="sm" variant="link" aria-expanded={showRenderer} onClick={() => setShowRenderer((value) => !value)}>
                    {showRenderer ? 'Hide the customer preview' : 'Show the customer preview'}
                  </Action>
                  {showRenderer && <PricingPreview yaml={yaml} />}
                </div>
              )}

              <div className="adm-buttons">
                <Action variant="secondary" onClick={() => go(2)}>Back to edit</Action>
                <Action variant="primary" disabled={!current?.validation.valid} onClick={() => go(4)}>Next: save draft</Action>
              </div>
            </>
          )}
        </section>
      )}

      {step === 4 && (
        <section className="adm-card" aria-labelledby="apr-s4">
          <h2 id="apr-s4">4 · Save a private draft</h2>
          {saved ? (
            <Notice
              tone="success"
              title={`${saved.version} saved as a private draft`}
              action={<><Action size="sm" variant="secondary" to={releasePath(saved.version)}>Open draft</Action><Action size="sm" variant="primary" onClick={() => go(5)}>Next: publish</Action></>}
            >
              Not public, not deployed, not LIVE. {saved.message} You can deploy it to SPACE as a preview from its page.
            </Notice>
          ) : (
            <>
              <div className="adm-form-grid">
                <label className="adm-field">
                  <span className="adm-label">What changed (changelog)</span>
                  <input value={changelog} onChange={(event) => setChangelog(event.target.value)} maxLength={4000} placeholder="e.g. More solves on ADVANCED" />
                </label>
                <label className="adm-field">
                  <span className="adm-label">Reason for the change</span>
                  <input value={reason} onChange={(event) => setReason(event.target.value)} />
                </label>
              </div>
              <details className="apr-advanced">
                <summary>Advanced: more migration manifest keys</summary>
                <label className="adm-field">
                  <span className="adm-label">Extra keys (JSON object)</span>
                  <textarea aria-label="Extra manifest keys" className="apr-yaml is-short" spellCheck={false} value={extraManifest} onChange={(event) => setExtraManifest(event.target.value)} placeholder="{}" />
                </label>
              </details>
              {'error' in manifest && <Notice tone="error">{manifest.error}</Notice>}
              <p className="adm-muted">Saving writes {draftVersion || 'the draft'} to SPHERE as a private, immutable draft. A version that already exists is refused (409).</p>
              <div className="adm-buttons">
                <Action variant="secondary" onClick={() => go(3)}>Back</Action>
                <Action variant="primary" busy={busy === 'save'} disabled={'error' in manifest || !current?.validation.valid || busy !== null} onClick={() => void save()}>Save draft in SPHERE</Action>
              </div>
            </>
          )}
        </section>
      )}

      {step === 5 && (
        <section className="adm-card" aria-labelledby="apr-s5">
          <h2 id="apr-s5">5 · Publish an immutable release</h2>
          {published ? (
            <Notice tone="success" title={`${published.version} published`} action={<Action size="sm" variant="primary" to={releasePath(published.version)}>Open release</Action>}>
              It’s public and fixed. {published.message} Next: deploy it to SPACE, then make it LIVE. Existing contracts move at renewal.
            </Notice>
          ) : !saved ? (
            <p className="adm-muted">Save a draft first (step 4), or open an existing draft and publish it from its page.</p>
          ) : (
            <>
              <div className="adm-form-grid">
                <div className="adm-field"><span className="adm-label">From draft</span><span className="apr-readonly is-mono">{saved.version}</span></div>
                <div className="adm-field">
                  <label className="adm-label" htmlFor={`${ids}-release`}>Release version</label>
                  <input id={`${ids}-release`} value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="0.2.0" spellCheck={false} aria-invalid={releaseVersion !== '' && !RELEASE_VERSION.test(releaseVersion) ? true : undefined} aria-describedby={`${ids}-release-hint`} />
                  <span id={`${ids}-release-hint`} className="adm-muted">Format X.Y.Z, no suffix</span>
                </div>
                <label className="adm-field">
                  <span className="adm-label">Changelog (required)</span>
                  <input value={changelog} onChange={(event) => setChangelog(event.target.value)} maxLength={4000} placeholder="What people will see changed" />
                </label>
              </div>
              <div className="adm-buttons">
                <Action variant="secondary" onClick={() => go(4)}>Back</Action>
                <Action variant="primary" disabled={!RELEASE_VERSION.test(releaseVersion) || changelog.trim() === '' || 'error' in manifest || busy !== null} onClick={() => setAsking(true)}>Publish {RELEASE_VERSION.test(releaseVersion) ? releaseVersion : ''}</Action>
                <span className="adm-muted">A published release can never change or be deleted.</span>
              </div>
            </>
          )}
        </section>
      )}

      {asking && saved && (
        <ConfirmDialog
          title={`Publish ${releaseVersion} as an immutable release?`}
          confirmLabel="Publish release"
          busy={busy === 'publish'}
          onConfirm={() => void publish()}
          onClose={() => setAsking(false)}
        >
          <p>{saved.version} becomes the public release {releaseVersion}. It can never change or be deleted. Publishing doesn’t make it LIVE and doesn’t certify its content.</p>
        </ConfirmDialog>
      )}
    </AdminFrame>
  );
}

/** admin-pricing-draft: build a private pricing draft with forms, compare it with LIVE, validate it, save it and publish it. */
export function AdminPricingDraft() {
  return <AdminOnly><DraftScreen /></AdminOnly>;
}
