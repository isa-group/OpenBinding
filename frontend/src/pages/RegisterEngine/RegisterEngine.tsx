import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import {
  apiClient, bimResourceKey,
  type BimResourceRef, type EngineRegistrationRevision, type EngineRevision,
} from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { ProjectPicker } from '../../components/ui/ProjectPicker';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { ConformanceChecklist, Crumbs, PlanMeter, StatusChip, ViewSource } from '../Engines/EngineParts';
import {
  allowanceOf, describeFailure, readProbe, refFromAddress, registrationHref,
  type Allowance, type Failure, type Probe,
} from '../Engines/registrationModel';
import {
  analyzeContract, buildRegistration, deploymentFromManifest, newDeployment, validateDeployment,
  type DeploymentDraft,
} from './deploymentDraft';
import { DeploymentForm } from './DeploymentForm';
import {
  BUILTIN_VOCABULARY, bumpPatch, buildManifest, draftFromManifest, newDraft, validateDraft, vocabulariesFrom,
  type EngineDraft, type Vocabulary,
} from './engineDraft';
import { EngineForm } from './EngineForm';
import './RegisterEngine.css';

type Step = 1 | 2 | 3 | 4;

const STEPS: ReadonlyArray<{ id: Step; label: string; sub: string }> = [
  { id: 1, label: 'Engine', sub: 'What it solves' },
  { id: 2, label: 'Deployment', sub: 'Address and contract' },
  { id: 3, label: 'Credential', sub: 'Stored, never shown' },
  { id: 4, label: 'Verify', sub: 'Conformance and activation' },
];

interface Setup {
  vocabularies: Vocabulary[];
  protocolDigest: string | null;
  prefill: { engine: EngineDraft | null; deployment: DeploymentDraft } | null;
  prefillFailed: boolean;
}

async function loadSetup(from: BimResourceRef | null): Promise<Setup> {
  let vocabularies: Vocabulary[] = [BUILTIN_VOCABULARY];
  let protocolDigest: string | null = null;
  try {
    const profiles = await apiClient.getProfiles();
    vocabularies = vocabulariesFrom(profiles);
    protocolDigest = profiles.find((profile) => profile.id === 'qos-binding/v1')?.protocolDigest ?? null;
  } catch {
    // The built-in vocabulary is the same one the gateway installs; the gateway still checks every manifest.
  }
  if (!from) return { vocabularies, protocolDigest, prefill: null, prefillFailed: false };
  try {
    const [detail, manifest] = await Promise.all([apiClient.getEngineRegistrationReport(from), apiClient.getEngineRegistration(from)]);
    const engine = draftFromManifest(detail.engine, vocabularies);
    const deployment = deploymentFromManifest(manifest, detail.openapi);
    return {
      vocabularies,
      protocolDigest,
      prefillFailed: false,
      prefill: {
        engine: engine ? { ...engine, version: bumpPatch(engine.version) } : null,
        deployment: { ...deployment, name: from.name, version: bumpPatch(from.version) },
      },
    };
  } catch {
    return { vocabularies, protocolDigest, prefill: null, prefillFailed: true };
  }
}

async function loadAllowance(username: string): Promise<Allowance | null> {
  const [usage, registrations] = await Promise.all([
    apiClient.getOwnUsage().catch(() => null),
    apiClient.listEngineRegistrations().catch((): EngineRegistrationRevision[] => []),
  ]);
  return allowanceOf(usage, registrations.filter((item) => item.namespace === username).length);
}

/** The manifest of an engine kept as a file, to start the form from it. */
function ImportManifest({ vocabularies, onLoad }: { vocabularies: Vocabulary[]; onLoad: (draft: EngineDraft) => void }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = (source: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      setProblem('The engine manifest must be valid JSON.');
      return;
    }
    const draft = draftFromManifest(parsed, vocabularies);
    if (!draft) {
      setProblem('That is not a bim/v1 Engine manifest: it needs a spec with modes.');
      return;
    }
    setProblem(null);
    setLoaded(true);
    onLoad(draft);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    load(text);
  };

  return (
    <details className="rg-more">
      <summary>Start from a manifest file <span>optional</span></summary>
      <form className="rg-import" onSubmit={submit}>
        <p className="eng-muted">Load an engine manifest you already have. Its fields fill the form below, where you can change them; the namespace is always your account’s.</p>
        <label className="rg-file">
          <span>Choose a JSON file</span>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Engine manifest file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then(setText, () => setProblem('The manifest file could not be read.'));
            }}
          />
        </label>
        <label className="rg-paste-label">
          <span>Or paste the manifest JSON</span>
          <textarea aria-label="Engine manifest JSON" name="engine-manifest" rows={8} value={text} spellCheck={false} onChange={(event) => setText(event.target.value)} />
        </label>
        {problem && <span className="rg-error" role="alert">{problem}</span>}
        {loaded && !problem && <span className="eng-muted" role="status">Loaded into the form.</span>}
        <Action type="submit" variant="secondary" size="sm" className="rg-self-start" disabled={text.trim() === ''}>Load into the form</Action>
      </form>
    </details>
  );
}

function CredentialStep({ scheme, busy, onSave, onBack }: { scheme: 'bearer' | 'basic'; busy: boolean; onSave: (secret: string) => Promise<boolean>; onBack: () => void }) {
  const [secret, setSecret] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret) return;
    const stored = await onSave(secret);
    // What was typed is never kept, whether it was stored or refused.
    setSecret('');
    return stored;
  };
  return (
    <form className="rg-form" onSubmit={(event) => void save(event)}>
      <div className="rg-lock" role="note">
        <span>Once you save it, nobody can read it back: not you, not support, not this page. If you lose it, you replace it.</span>
      </div>
      <label className="rg-secret">
        <span>{scheme === 'basic' ? 'Username and password (user:password)' : 'Token'}</span>
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder="Paste it here; it won’t be shown"
        />
      </label>
      <div className="rg-actions">
        <Action variant="secondary" onClick={onBack} disabled={busy}>Back</Action>
        <Action type="submit" variant="primary" busy={busy} disabled={!secret}>Save credential</Action>
        <span className="eng-muted">Encrypted separately; never inserted into or returned with the manifest.</span>
      </div>
    </form>
  );
}

interface WizardProps {
  username: string;
  setup: Setup;
  allowance: Allowance | null;
  allowanceLoading: boolean;
  onAllowanceChanged: () => void;
  onRestart: () => void;
}

function Wizard({ username, setup, allowance, allowanceLoading, onAllowanceChanged, onRestart }: WizardProps) {
  const { vocabularies, protocolDigest } = setup;
  const [step, setStep] = useState<Step>(1);
  const [engineDraft, setEngineDraft] = useState<EngineDraft>(() => setup.prefill?.engine ?? newDraft(vocabularies[0]));
  const [deployment, setDeployment] = useState<DeploymentDraft>(() => setup.prefill?.deployment ?? newDeployment());
  const [engine, setEngine] = useState<EngineRevision | null>(null);
  const [registration, setRegistration] = useState<EngineRegistrationRevision | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [activated, setActivated] = useState(false);
  const [engineOnly, setEngineOnly] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [publicationAsked, setPublicationAsked] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ failure: Failure; step: Step } | null>(null);
  const [toast, setToast] = useState('');

  const engineIssues = useMemo(() => validateDraft(engineDraft, vocabularies), [engineDraft, vocabularies]);
  const { contract, request, health, openapi, job } = deployment;
  const reading = useMemo(
    () => analyzeContract(contract, [request, health, openapi, ...(job ? [job] : [])], protocolDigest),
    [contract, request, health, openapi, job, protocolDigest],
  );
  const deployIssues = validateDeployment(deployment, reading);
  const manifest = useMemo(() => buildManifest(engineDraft, username, vocabularies), [engineDraft, username, vocabularies]);

  const needsCredential = deployment.auth !== 'none';
  const reached = [true, Boolean(engine), Boolean(registration), Boolean(registration) && (credentialSaved || !needsCredential)];
  const complete = [Boolean(engine), Boolean(registration), Boolean(registration) && (credentialSaved || !needsCredential), activated];
  const done = activated || engineOnly;

  const fail = (reason: unknown, at: Step, fallback: string) => {
    const failure = describeFailure(reason, fallback);
    setError({ failure, step: at });
    return failure;
  };

  const createEngine = async () => {
    if (engineIssues.length > 0) return;
    setBusy('engine');
    setError(null);
    setToast('');
    try {
      const created = await apiClient.createEngine(manifest);
      setEngine(created);
      setToast('Engine revision created. It’s private and can’t be edited.');
    } catch (reason: unknown) {
      fail(reason, 1, 'The engine was refused');
    } finally {
      setBusy('');
    }
  };

  const createRegistration = async () => {
    if (!engine || deployIssues.length > 0 || !reading.document) return;
    setBusy('registration');
    setError(null);
    setToast('');
    try {
      // The gateway’s own pins decide, not the copy this page read earlier.
      const profile = await apiClient.getBimProfile();
      if (reading.document['x-bim-protocol-digest'] !== profile.protocolDigest) {
        throw new Error('The deployment OpenAPI document does not pin this gateway’s bim-engine/v1 digest.');
      }
      const created = await apiClient.createEngineRegistration(
        buildRegistration(deployment, engine, username, { id: profile.protocol, digest: profile.protocolDigest }, reading.document),
      );
      setRegistration(created);
      setToast('Registration created. It stays inactive until it passes verification.');
      onAllowanceChanged();
    } catch (reason: unknown) {
      fail(reason, 2, 'The registration was refused');
    } finally {
      setBusy('');
    }
  };

  const saveCredential = async (secret: string): Promise<boolean> => {
    if (!registration) return false;
    setBusy('credential');
    setError(null);
    setToast('');
    try {
      setRegistration(await apiClient.setEngineRegistrationCredential(registration, secret));
      setCredentialSaved(true);
      setToast('Credential stored. It can be replaced, never read.');
      return true;
    } catch (reason: unknown) {
      fail(reason, 3, 'The credential was refused');
      return false;
    } finally {
      setBusy('');
    }
  };

  const verify = async () => {
    if (!registration) return;
    setBusy('verify');
    setError(null);
    setToast('');
    setProbe(null);
    try {
      const active = await apiClient.activateEngineRegistration(registration);
      setRegistration(active);
      const report = await apiClient.getEngineRegistrationReport(active).catch(() => null);
      setProbe(report ? readProbe(report.report) : null);
      setActivated(true);
    } catch (reason: unknown) {
      const failure = fail(reason, 4, 'The check could not run');
      setProbe(failure.probe);
    } finally {
      setBusy('');
    }
  };

  const requestPublication = async () => {
    if (!registration) return;
    setBusy('publish');
    setError(null);
    try {
      setRegistration(await apiClient.requestEngineRegistrationPublication(registration));
      setPublicationAsked(true);
    } catch (reason: unknown) {
      fail(reason, 4, 'Publication could not be requested');
    } finally {
      setBusy('');
    }
  };

  const go = (target: Step) => {
    setToast('');
    setStep(target);
  };

  const authLabel = deployment.auth === 'none' ? 'None' : deployment.auth === 'bearer' ? 'Bearer token (stored)' : 'Username and password (stored)';
  const full = allowance !== null && allowance.limit !== null && allowance.used >= allowance.limit ? allowance : null;
  const engineRef = engine ? `${engine.namespace}/${engine.name} ${engine.version}` : '';

  return (
    <div className="rg-page">
      <Crumbs items={[{ label: 'Home', to: '/app' }, { label: 'My engines', to: '/app/engines/registrations' }, { label: 'Register an engine' }]} />
      <PageHeader
        eyebrow="Engines"
        title="Register a private engine"
        lede="Describe your engine, point OpenBinding at your deployment, give it a credential and let us check it speaks the engine protocol. Only you can use it until it’s reviewed and published."
        actions={<PlanMeter allowance={allowance} loading={allowanceLoading} />}
      />

      <ol className="rg-steps" aria-label="Steps">
        {STEPS.map((item) => {
          const current = !done && step === item.id;
          const bad = error?.step === item.id;
          const ok = complete[item.id - 1];
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                disabled={!reached[item.id - 1] || done}
                className={`${current ? 'is-current' : ''} ${bad ? 'is-bad' : ''}`.trim()}
                onClick={() => go(item.id)}
              >
                <span className={`rg-dot${ok ? ' is-ok' : ''}${bad ? ' is-bad' : ''}${current ? ' is-current' : ''}`} aria-hidden="true">{bad ? '!' : ok ? <Check /> : item.id}</span>
                <span><strong>{item.label}</strong><small>{item.sub}</small></span>
              </button>
            </li>
          );
        })}
      </ol>

      {error && (
        <Notice
          tone={error.failure.tone}
          title={error.failure.title}
          action={!done && error.step !== step && reached[error.step - 1] ? <Action size="sm" variant="secondary" onClick={() => go(error.step)}>Show me where (step {error.step})</Action> : undefined}
        >
          {[error.failure.text, ...error.failure.details].join(' ')}
          {error.failure.status === 402 && <> <Link to="/app/account/usage">See your plan</Link></>}
        </Notice>
      )}
      {toast && <Notice tone="success">{toast}</Notice>}

      {!done && step === 1 && (
        <section className="rg-section" aria-labelledby="rg-step-1">
          <div>
            <h2 id="rg-step-1">1 · Your engine</h2>
            <p>What it is and what it can solve. This becomes a fixed revision: to change it later you register a new version.</p>
          </div>
          {!engine && <ImportManifest vocabularies={vocabularies} onLoad={setEngineDraft} />}
          {setup.vocabularies[0].source === 'built-in' && <Notice tone="info">The gateway’s profile list couldn’t be read, so the form uses the standard qos-binding/v1 vocabulary. The gateway still checks the manifest.</Notice>}
          <EngineForm draft={engineDraft} onChange={setEngineDraft} vocabularies={vocabularies} issues={engineIssues} locked={Boolean(engine)} namespace={username} />
          <ViewSource value={manifest} />
          <div className="rg-actions">
            {!engine ? (
              <>
                <Action variant="primary" busy={busy === 'engine'} disabled={engineIssues.length > 0} onClick={() => void createEngine()}>Create engine revision</Action>
                <span className="eng-muted">{engineIssues.length > 0 ? `Fix the highlighted fields first (${engineIssues.length}).` : 'Creates a private, fixed revision. Nobody else can see it.'}</span>
              </>
            ) : (
              <>
                <StatusChip tone="success">✓ Engine revision created · private</StatusChip>
                <span className="rg-ref">{engineRef}</span>
                <Action variant="primary" onClick={() => go(2)}>Next: deployment</Action>
                <Action variant="secondary" onClick={() => setEngineOnly(true)}>Keep the engine only</Action>
              </>
            )}
          </div>
        </section>
      )}

      {!done && step === 2 && (
        <section className="rg-section" aria-labelledby="rg-step-2">
          <div>
            <h2 id="rg-step-2">2 · Where it runs</h2>
            <p>The address of your deployment and the contract it follows. OpenBinding calls it from its own servers, never from your browser.</p>
          </div>
          {full && !registration && (
            <Notice tone="warning" title="Your plan is full">
              You’ve registered {full.used} of {full.limit} federated engines. Creating another is likely to be refused (402); delete one you no longer use first.
            </Notice>
          )}
          <DeploymentForm draft={deployment} onChange={setDeployment} reading={reading} issues={deployIssues} locked={Boolean(registration)} protocolDigest={protocolDigest} />
          <div className="rg-actions">
            <Action variant="secondary" onClick={() => go(1)}>Back</Action>
            {!registration ? (
              <>
                <Action variant="primary" busy={busy === 'registration'} disabled={deployIssues.length > 0} onClick={() => void createRegistration()}>Create registration</Action>
                <span className="eng-muted">
                  {deployIssues.length > 0 ? (deployIssues.find((issue) => issue.path === 'contract')?.message ?? 'Fix the highlighted fields first.') : 'Creates the registration, inactive until verified.'}
                </span>
              </>
            ) : (
              <>
                <StatusChip tone="success">✓ Registration created · inactive</StatusChip>
                <Action variant="primary" onClick={() => go(needsCredential ? 3 : 4)}>{needsCredential ? 'Next: credential' : 'Next: verify'}</Action>
              </>
            )}
          </div>
        </section>
      )}

      {!done && step === 3 && registration && (
        <section className="rg-section" aria-labelledby="rg-step-3">
          <div>
            <h2 id="rg-step-3">3 · Credential</h2>
            <p>
              {needsCredential
                ? `The ${deployment.auth === 'basic' ? 'username and password' : 'token'} OpenBinding sends when it calls your deployment.`
                : 'You chose an open endpoint, so there’s nothing to store.'}
            </p>
          </div>
          {needsCredential && !credentialSaved && (
            <CredentialStep scheme={deployment.auth === 'basic' ? 'basic' : 'bearer'} busy={busy === 'credential'} onSave={saveCredential} onBack={() => go(2)} />
          )}
          {needsCredential && credentialSaved && (
            <div className="rg-stored">
              <span aria-hidden="true" className="rg-dots">••••••••••••</span>
              <span>Stored encrypted. It will never be shown again.</span>
              <Action variant="primary" onClick={() => go(4)}>Next: verify</Action>
            </div>
          )}
          {!needsCredential && (
            <div className="rg-actions">
              <Action variant="secondary" onClick={() => go(2)}>Back</Action>
              <Action variant="primary" onClick={() => go(4)}>Next: verify</Action>
            </div>
          )}
        </section>
      )}

      {!done && step === 4 && registration && (
        <section className="rg-section" aria-labelledby="rg-step-4">
          <div>
            <h2 id="rg-step-4">4 · Verify and activate</h2>
            <p>We call your deployment with a sample problem and check every answer against bim-engine/v1. Activating makes it usable for you; nobody else sees it.</p>
          </div>
          {busy === 'verify' && (
            <div role="status" className="rg-checking">
              <span className="rg-spinner" aria-hidden="true" />Checking conformance…
              <Skeleton variant="tile" /><Skeleton variant="tile" />
            </div>
          )}
          {busy !== 'verify' && probe && probe.verdict === 'failed' && (
            <ConformanceChecklist probe={probe} failedText="One check failed. Nothing was activated; the registration itself stays as it is." />
          )}
          <div className="rg-actions">
            <Action variant="secondary" onClick={() => go(needsCredential ? 3 : 2)} disabled={busy === 'verify'}>Back</Action>
            <Action variant="primary" busy={busy === 'verify'} onClick={() => void verify()}>
              {probe?.verdict === 'failed' ? 'Check again' : 'Check conformance and activate'}
            </Action>
            {probe?.verdict === 'failed' && <span className="eng-muted">Fix your deployment first, then check again.</span>}
          </div>
        </section>
      )}

      {done && engine && !registration && (
        <section className="rg-done" aria-live="polite" aria-label="Engine revision created">
          <div className="rg-done-head">
            <span aria-hidden="true" className="rg-done-ring"><Check /></span>
            <span>
              <strong>{engine.name} {engine.version} is saved</strong>
              <span>A private engine revision. Only your account can discover it. A material change needs a new version and digest.</span>
            </span>
          </div>
          <dl className="rg-summary">
            <div><dt>Engine</dt><dd>{engine.namespace}/{engine.name} {engine.version}</dd></div>
            <div><dt>Fingerprint</dt><dd className="is-mono" title={engine.digest}>{shortDigest(engine.digest)}</dd></div>
            <div><dt>State</dt><dd>{engine.status}</dd></div>
          </dl>
          <div className="rg-actions">
            <Action variant="primary" onClick={() => { setEngineOnly(false); setStep(2); }}>Register a deployment for it</Action>
            <Action to="/app/engines/registrations" variant="secondary">All my engines</Action>
            <Action variant="secondary" onClick={onRestart}>Register another engine</Action>
          </div>
        </section>
      )}

      {done && registration && engine && (
        <section className="rg-done" aria-live="polite" aria-label="Registration active">
          <div className="rg-done-head">
            <span aria-hidden="true" className="rg-done-ring"><Check /></span>
            <span>
              <strong>{registration.name} {registration.version} is active</strong>
              <span>Only you can pick it when launching a job. It counts as 1 of your {allowance?.limit ?? 'plan’s'} federated engines.</span>
            </span>
          </div>
          <dl className="rg-summary">
            <div><dt>Engine</dt><dd>{engine.namespace}/{engine.name} {engine.version}</dd></div>
            <div><dt>Fingerprint</dt><dd className="is-mono" title={registration.digest}>{shortDigest(registration.digest)}</dd></div>
            <div><dt>Endpoint</dt><dd className="is-mono">{deployment.endpoint.trim()}</dd></div>
            <div><dt>Sign-in</dt><dd>{authLabel}</dd></div>
          </dl>
          {probe && probe.verdict === 'verified' && <ConformanceChecklist probe={probe} />}
          <div className="rg-publish">
            <span>
              <strong>Want others to use it?</strong>
              {publicationAsked || registration.status === 'pending_review'
                ? ' An administrator will review it. Until then it stays private.'
                : ' An administrator reviews it first. Requires an account or key allowed to publish engines.'}
            </span>
            {publicationAsked || registration.status === 'pending_review'
              ? <StatusChip tone="warning">Waiting for review</StatusChip>
              : <Action variant="secondary" busy={busy === 'publish'} onClick={() => void requestPublication()}>Request publication</Action>}
          </div>
          <div className="rg-actions">
            <Action to={registrationHref(registration)} variant="primary">Open registration</Action>
            <ProjectPicker label="Launch a job with it" destination={(org, project) => `/app/${org}/${project}/jobs/new?engine=${encodeURIComponent(bimResourceKey(engine))}`} />
            <Action to="/app/engines/registrations" variant="secondary">All my engines</Action>
          </div>
        </section>
      )}
    </div>
  );
}

/** eng-register: register an engine and, if you want, its deployment: engine revision, address and contract, credential, verification. */
export function RegisterEngine() {
  const { user } = useAuth();
  const username = user?.username ?? '';
  const [params] = useSearchParams();
  const from = refFromAddress(params.get('from') ?? '', params);
  const [run, setRun] = useState(0);
  const setup = useResource(`register-setup:${username}:${from ? bimResourceKey(from) : ''}`, () => loadSetup(from));
  const allowance = useResource(`register-allowance:${username}`, () => loadAllowance(username));

  if (!setup.data) {
    return (
      <div className="rg-page">
        <Crumbs items={[{ label: 'Home', to: '/app' }, { label: 'My engines', to: '/app/engines/registrations' }, { label: 'Register an engine' }]} />
        <h1 className="sr-only">Register a private engine</h1>
        <div aria-busy="true" aria-live="polite" className="rg-loading"><Skeleton variant="tile" /><Skeleton variant="panel" /></div>
      </div>
    );
  }

  return (
    <>
      {setup.data.prefillFailed && (
        <div className="rg-page rg-page-notice">
          <Notice tone="warning" title="The registration to copy couldn’t be read">You can still fill the form in from scratch.</Notice>
        </div>
      )}
      <Wizard
        key={run}
        username={username}
        setup={run === 0 ? setup.data : { ...setup.data, prefill: null }}
        allowance={allowance.data ?? allowance.stale ?? null}
        allowanceLoading={allowance.status === 'loading' && !allowance.stale}
        onAllowanceChanged={allowance.reload}
        onRestart={() => setRun((value) => value + 1)}
      />
    </>
  );
}
