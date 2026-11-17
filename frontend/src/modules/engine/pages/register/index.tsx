// Adapted from SPHERE frontend/src/modules/pricing/components/create-pricing-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the create-form page frame of SPHERE's pages/create (the back link, the display title, a 900 px column) holds OpenBinding's four-step
// engine registration instead of a pricing upload: the engine revision built from fields (or a manifest file), the
// deployment's address and pinned contract, the credential (stored, never shown) and the conformance check that activates
// it. Each step is a card; the steps above say which are done, current or refused. A run is launched in an organization
// chosen with SPHERE's selector. pricing4ts is not brought: the gateway checks every document.

import { useMemo, useState, type FormEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { MdArrowBack, MdCheck } from 'react-icons/md';
import { Link, useSearchParams } from 'react-router-dom';
import { bimResourceKey } from '../../../../api/client';
import { useResource } from '../../../../utils/useResource';
import type { ImmutableResourceRef } from '../../../core/api/types';
import { Action } from '../../../core/components/action-button';
import BlockAlert from '../../../core/components/block-alert';
import { useAuth } from '../../../auth/hooks/useAuth';
import { MY_ENGINES_PATH } from '../../../../routes/paths/engines';
import { launchPath } from '../../../../routes/paths/runs';
import {
  useEnginesApi,
  type CreatedEngineRevision as EngineRevision,
  type EngineRegistrationRevision,
  type EnginesApi,
} from '../../api/enginesApi';
import {
  allowanceOf,
  describeFailure,
  readProbe,
  refFromAddress,
  registrationHref,
  type Allowance,
  type Failure,
  type Probe,
} from '../../api/registrationModel';
import {
  analyzeContract,
  buildRegistration,
  deploymentFromManifest,
  newDeployment,
  validateDeployment,
  type DeploymentDraft,
} from '../../components/deployment-form/deploymentDraft';
import { DeploymentForm } from '../../components/deployment-form';
import EngineLaunchModal from '../../components/engine-launch-modal';
import {
  BUILTIN_VOCABULARY,
  bumpPatch,
  buildManifest,
  draftFromManifest,
  newDraft,
  validateDraft,
  vocabulariesFrom,
  type EngineDraft,
  type Vocabulary,
} from '../../components/engine-form/engineDraft';
import { EngineForm } from '../../components/engine-form';
import {
  ConformanceChecklist,
  PlanMeter,
  StatusChip,
  ViewSource,
} from '../../components/engine-parts';
import {
  FIELD_ERROR,
  INPUT,
  MORE,
  MORE_SUMMARY,
  MUTED,
  STACKED,
} from '../../components/engine-parts/styles';

/** A step of the form: a titled card. */
const SECTION = 'flex flex-col gap-4 rounded-2xl border border-tp-hairline bg-tp-canvas p-5 sm:p-6';
const SECTION_TITLE = 'text-lg font-semibold text-tp-ink';
const SECTION_LEDE = 'mt-0.5 text-[13px] text-tp-steel';
/** The buttons at the foot of a step. */
const ACTIONS = 'flex flex-wrap items-center gap-3';
const SECRET_DOTS = 'font-mono tracking-widest text-tp-steel';

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

async function loadSetup(api: EnginesApi, from: ImmutableResourceRef | null): Promise<Setup> {
  let vocabularies: Vocabulary[] = [BUILTIN_VOCABULARY];
  let protocolDigest: string | null = null;
  try {
    const profiles = await api.getProtocolProfiles();
    vocabularies = vocabulariesFrom(profiles);
    protocolDigest =
      profiles.find(profile => profile.id === 'qos-binding/v1')?.protocolDigest ?? null;
  } catch {
    // The built-in vocabulary is the same one the gateway installs; the gateway still checks every manifest.
  }
  if (!from) return { vocabularies, protocolDigest, prefill: null, prefillFailed: false };
  try {
    const [detail, manifest] = await Promise.all([
      api.getEngineRegistrationReport(from),
      api.getEngineRegistration(from),
    ]);
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

async function loadAllowance(api: EnginesApi, username: string): Promise<Allowance | null> {
  const [usage, registrations] = await Promise.all([
    api.getOwnUsage().catch(() => null),
    api.listEngineRegistrations().catch((): EngineRegistrationRevision[] => []),
  ]);
  return allowanceOf(usage, registrations.filter(item => item.namespace === username).length);
}

/** The manifest of an engine kept as a file, to start the form from it. */
function ImportManifest({
  vocabularies,
  onLoad,
}: {
  vocabularies: Vocabulary[];
  onLoad: (draft: EngineDraft) => void;
}) {
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
    <details className={MORE}>
      <summary className={MORE_SUMMARY}>
        Start from a manifest file{' '}
        <span className="ml-2 text-xs font-normal text-tp-steel">optional</span>
      </summary>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className={MUTED}>
          Load an engine manifest you already have. Its fields fill the form below, where you can
          change them; the namespace is always your account’s.
        </p>
        <label className="relative inline-flex min-h-9 cursor-pointer items-center self-start rounded-md border border-tp-hairline-strong bg-tp-canvas px-3.5 text-[13px] font-medium text-tp-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tp-primary hover:bg-tp-surface">
          <span>Choose a JSON file</span>
          <input
            type="file"
            accept="application/json,.json"
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Engine manifest file"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file)
                void file
                  .text()
                  .then(setText, () => setProblem('The manifest file could not be read.'));
            }}
          />
        </label>
        <label className={STACKED}>
          <span>Or paste the manifest JSON</span>
          <textarea
            className={`${INPUT} min-h-30 resize-y py-2 font-mono text-xs`}
            aria-label="Engine manifest JSON"
            name="engine-manifest"
            rows={8}
            value={text}
            spellCheck={false}
            onChange={event => setText(event.target.value)}
          />
        </label>
        {problem && (
          <span className={FIELD_ERROR} role="alert">
            {problem}
          </span>
        )}
        {loaded && !problem && (
          <span className={MUTED} role="status">
            Loaded into the form.
          </span>
        )}
        <Action
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={text.trim() === ''}
        >
          Load into the form
        </Action>
      </form>
    </details>
  );
}

function CredentialStep({
  scheme,
  busy,
  onSave,
  onBack,
}: {
  scheme: 'bearer' | 'basic';
  busy: boolean;
  onSave: (secret: string) => Promise<boolean>;
  onBack: () => void;
}) {
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
    <form className="flex flex-col gap-4" onSubmit={event => void save(event)}>
      <div
        className="rounded-lg border border-tp-severity-info-border bg-tp-severity-info-bg px-3 py-2.5 text-[13px] text-tp-info-text"
        role="note"
      >
        <span>
          Once you save it, nobody can read it back: not you, not support, not this page. If you
          lose it, you replace it.
        </span>
      </div>
      <label className={STACKED}>
        <span>{scheme === 'basic' ? 'Username and password (user:password)' : 'Token'}</span>
        <input
          className={`${INPUT} font-mono`}
          type="password"
          value={secret}
          onChange={event => setSecret(event.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder="Paste it here; it won’t be shown"
        />
      </label>
      <div className={ACTIONS}>
        <Action variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Action>
        <Action type="submit" variant="primary" busy={busy} disabled={!secret}>
          Save credential
        </Action>
        <span className={MUTED}>
          Encrypted separately; never inserted into or returned with the manifest.
        </span>
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

function Wizard({
  username,
  setup,
  allowance,
  allowanceLoading,
  onAllowanceChanged,
  onRestart,
}: WizardProps) {
  const api = useEnginesApi();
  const { vocabularies, protocolDigest } = setup;
  const [launching, setLaunching] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [engineDraft, setEngineDraft] = useState<EngineDraft>(
    () => setup.prefill?.engine ?? newDraft(vocabularies[0])
  );
  const [deployment, setDeployment] = useState<DeploymentDraft>(
    () => setup.prefill?.deployment ?? newDeployment()
  );
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

  const engineIssues = useMemo(
    () => validateDraft(engineDraft, vocabularies),
    [engineDraft, vocabularies]
  );
  const { contract, request, health, openapi, job } = deployment;
  const reading = useMemo(
    () =>
      analyzeContract(contract, [request, health, openapi, ...(job ? [job] : [])], protocolDigest),
    [contract, request, health, openapi, job, protocolDigest]
  );
  const deployIssues = validateDeployment(deployment, reading);
  const manifest = useMemo(
    () => buildManifest(engineDraft, username, vocabularies),
    [engineDraft, username, vocabularies]
  );

  const needsCredential = deployment.auth !== 'none';
  const reached = [
    true,
    Boolean(engine),
    Boolean(registration),
    Boolean(registration) && (credentialSaved || !needsCredential),
  ];
  const complete = [
    Boolean(engine),
    Boolean(registration),
    Boolean(registration) && (credentialSaved || !needsCredential),
    activated,
  ];
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
      const created = await api.createEngine(manifest);
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
      const profile = await api.getBimProfile();
      if (reading.document['x-bim-protocol-digest'] !== profile.protocolDigest) {
        throw new Error(
          'The deployment OpenAPI document does not pin this gateway’s bim-engine/v1 digest.'
        );
      }
      const created = await api.createEngineRegistration(
        buildRegistration(
          deployment,
          engine,
          username,
          { id: profile.protocol, digest: profile.protocolDigest },
          reading.document
        )
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
      setRegistration(await api.setEngineRegistrationCredential(registration, secret));
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
      const active = await api.activateEngineRegistration(registration);
      setRegistration(active);
      const report = await api.getEngineRegistrationReport(active).catch(() => null);
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
      setRegistration(await api.requestEngineRegistrationPublication(registration));
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

  const authLabel =
    deployment.auth === 'none'
      ? 'None'
      : deployment.auth === 'bearer'
        ? 'Bearer token (stored)'
        : 'Username and password (stored)';
  const full =
    allowance !== null && allowance.limit !== null && allowance.used >= allowance.limit
      ? allowance
      : null;
  const engineRef = engine ? `${engine.namespace}/${engine.name} ${engine.version}` : '';

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl text-tp-ink sm:text-3xl">
            Register a private engine
          </h1>
          <p className="mt-1 text-sm text-tp-steel">
            Describe your engine, point OpenBinding at your deployment, give it a credential and let
            us check it speaks the engine protocol. Only you can use it until it’s reviewed and
            published.
          </p>
        </div>
        <div className="w-full sm:w-72">
          <PlanMeter allowance={allowance} loading={allowanceLoading} />
        </div>
      </div>

      <ol
        className="mb-5 grid [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))] gap-2"
        aria-label="Steps"
      >
        {STEPS.map(item => {
          const current = !done && step === item.id;
          const bad = error?.step === item.id;
          const ok = complete[item.id - 1];
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                disabled={!reached[item.id - 1] || done}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-tp-ink disabled:cursor-not-allowed disabled:opacity-55 ${
                  bad
                    ? 'border-tp-severity-error-border bg-tp-severity-error-bg'
                    : current
                      ? 'border-tp-primary bg-tp-severity-info-bg ring-1 ring-tp-primary'
                      : 'border-tp-hairline-strong bg-tp-canvas'
                }`}
                onClick={() => go(item.id)}
              >
                <span
                  className={`inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-[13px] font-semibold ${
                    bad
                      ? 'bg-tp-severity-error text-tp-on-primary'
                      : ok
                        ? 'bg-tp-severity-success text-tp-on-primary'
                        : current
                          ? 'bg-tp-primary text-tp-on-primary'
                          : 'bg-tp-cream-deeper text-tp-charcoal'
                  }`}
                  aria-hidden="true"
                >
                  {bad ? '!' : ok ? <MdCheck className="h-4 w-4" /> : item.id}
                </span>
                <span>
                  <strong className="block text-sm font-semibold">{item.label}</strong>
                  <small className="block text-xs text-tp-steel">{item.sub}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-4">
        {error && (
          <BlockAlert variant={error.failure.tone}>
            <div className="min-w-0">
              {error.failure.title && <p className="font-medium">{error.failure.title}</p>}
              <p>
                {[error.failure.text, ...error.failure.details].join(' ')}
                {error.failure.status === 402 && (
                  <>
                    {' '}
                    <Link
                      to="/me/settings?section=plan"
                      className="cursor-pointer font-medium underline"
                    >
                      See your plan
                    </Link>
                  </>
                )}
              </p>
              {!done && error.step !== step && reached[error.step - 1] && (
                <button
                  type="button"
                  onClick={() => go(error.step)}
                  className="mt-2 cursor-pointer rounded-md border border-current px-3 py-1 text-xs font-medium"
                >
                  Show me where (step {error.step})
                </button>
              )}
            </div>
          </BlockAlert>
        )}
        {toast && <BlockAlert variant="success" message={toast} />}

        {!done && step === 1 && (
          <section className={SECTION} aria-labelledby="rg-step-1">
            <div>
              <h2 id="rg-step-1" className={SECTION_TITLE}>
                1 · Your engine
              </h2>
              <p className={SECTION_LEDE}>
                What it is and what it can solve. This becomes a fixed revision: to change it later
                you register a new version.
              </p>
            </div>
            {!engine && <ImportManifest vocabularies={vocabularies} onLoad={setEngineDraft} />}
            {setup.vocabularies[0].source === 'built-in' && (
              <BlockAlert variant="info">
                The gateway’s profile list couldn’t be read, so the form uses the standard
                qos-binding/v1 vocabulary. The gateway still checks the manifest.
              </BlockAlert>
            )}
            <EngineForm
              draft={engineDraft}
              onChange={setEngineDraft}
              vocabularies={vocabularies}
              issues={engineIssues}
              locked={Boolean(engine)}
              namespace={username}
            />
            <ViewSource
              value={manifest}
              sourceLabel="Engine manifest source"
              filename="engine.json"
            />
            <div className={ACTIONS}>
              {!engine ? (
                <>
                  <Action
                    variant="primary"
                    busy={busy === 'engine'}
                    disabled={engineIssues.length > 0}
                    onClick={() => void createEngine()}
                  >
                    Create engine revision
                  </Action>
                  <span className={MUTED}>
                    {engineIssues.length > 0
                      ? `Fix the highlighted fields first (${engineIssues.length}).`
                      : 'Creates a private, fixed revision. Nobody else can see it.'}
                  </span>
                </>
              ) : (
                <>
                  <StatusChip tone="success">✓ Engine revision created · private</StatusChip>
                  <span className="font-mono text-xs [overflow-wrap:anywhere] text-tp-slate">
                    {engineRef}
                  </span>
                  <Action variant="primary" onClick={() => go(2)}>
                    Next: deployment
                  </Action>
                  <Action variant="secondary" onClick={() => setEngineOnly(true)}>
                    Keep the engine only
                  </Action>
                </>
              )}
            </div>
          </section>
        )}

        {!done && step === 2 && (
          <section className={SECTION} aria-labelledby="rg-step-2">
            <div>
              <h2 id="rg-step-2" className={SECTION_TITLE}>
                2 · Where it runs
              </h2>
              <p className={SECTION_LEDE}>
                The address of your deployment and the contract it follows. OpenBinding calls it
                from its own servers, never from your browser.
              </p>
            </div>
            {full && !registration && (
              <BlockAlert variant="warning">
                <strong>Your plan is full.</strong> You’ve registered {full.used} of {full.limit}{' '}
                federated engines. Creating another is likely to be refused (402); delete one you no
                longer use first.
              </BlockAlert>
            )}
            <DeploymentForm
              draft={deployment}
              onChange={setDeployment}
              reading={reading}
              issues={deployIssues}
              locked={Boolean(registration)}
            />
            <div className={ACTIONS}>
              <Action variant="secondary" onClick={() => go(1)}>
                Back
              </Action>
              {!registration ? (
                <>
                  <Action
                    variant="primary"
                    busy={busy === 'registration'}
                    disabled={deployIssues.length > 0}
                    onClick={() => void createRegistration()}
                  >
                    Create registration
                  </Action>
                  <span className={MUTED}>
                    {deployIssues.length > 0
                      ? (deployIssues.find(issue => issue.path === 'contract')?.message ??
                        'Fix the highlighted fields first.')
                      : 'Creates the registration, inactive until verified.'}
                  </span>
                </>
              ) : (
                <>
                  <StatusChip tone="success">✓ Registration created · inactive</StatusChip>
                  <Action variant="primary" onClick={() => go(needsCredential ? 3 : 4)}>
                    {needsCredential ? 'Next: credential' : 'Next: verify'}
                  </Action>
                </>
              )}
            </div>
          </section>
        )}

        {!done && step === 3 && registration && (
          <section className={SECTION} aria-labelledby="rg-step-3">
            <div>
              <h2 id="rg-step-3" className={SECTION_TITLE}>
                3 · Credential
              </h2>
              <p className={SECTION_LEDE}>
                {needsCredential
                  ? `The ${deployment.auth === 'basic' ? 'username and password' : 'token'} OpenBinding sends when it calls your deployment.`
                  : 'You chose an open endpoint, so there’s nothing to store.'}
              </p>
            </div>
            {needsCredential && !credentialSaved && (
              <CredentialStep
                scheme={deployment.auth === 'basic' ? 'basic' : 'bearer'}
                busy={busy === 'credential'}
                onSave={saveCredential}
                onBack={() => go(2)}
              />
            )}
            {needsCredential && credentialSaved && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-tp-surface px-3 py-2.5 text-sm text-tp-slate">
                <span aria-hidden="true" className={SECRET_DOTS}>
                  ••••••••••••
                </span>
                <span className="flex-1">Stored encrypted. It will never be shown again.</span>
                <Action variant="primary" onClick={() => go(4)}>
                  Next: verify
                </Action>
              </div>
            )}
            {!needsCredential && (
              <div className={ACTIONS}>
                <Action variant="secondary" onClick={() => go(2)}>
                  Back
                </Action>
                <Action variant="primary" onClick={() => go(4)}>
                  Next: verify
                </Action>
              </div>
            )}
          </section>
        )}

        {!done && step === 4 && registration && (
          <section className={SECTION} aria-labelledby="rg-step-4">
            <div>
              <h2 id="rg-step-4" className={SECTION_TITLE}>
                4 · Verify and activate
              </h2>
              <p className={SECTION_LEDE}>
                We call your deployment with a sample problem and check every answer against
                bim-engine/v1. Activating makes it usable for you; nobody else sees it.
              </p>
            </div>
            {busy === 'verify' && (
              <div role="status" className="flex flex-col gap-2 text-sm text-tp-slate">
                <span className="flex items-center gap-2">
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-tp-primary border-t-transparent"
                    aria-hidden="true"
                  />
                  Checking conformance…
                </span>
                <div className="h-12 animate-pulse rounded-lg bg-tp-surface" aria-hidden="true" />
                <div className="h-12 animate-pulse rounded-lg bg-tp-surface" aria-hidden="true" />
              </div>
            )}
            {busy !== 'verify' && probe && probe.verdict === 'failed' && (
              <ConformanceChecklist
                probe={probe}
                failedText="One check failed. Nothing was activated; the registration itself stays as it is."
              />
            )}
            <div className={ACTIONS}>
              <Action
                variant="secondary"
                onClick={() => go(needsCredential ? 3 : 2)}
                disabled={busy === 'verify'}
              >
                Back
              </Action>
              <Action variant="primary" busy={busy === 'verify'} onClick={() => void verify()}>
                {probe?.verdict === 'failed' ? 'Check again' : 'Check conformance and activate'}
              </Action>
              {probe?.verdict === 'failed' && (
                <span className={MUTED}>Fix your deployment first, then check again.</span>
              )}
            </div>
          </section>
        )}

        {done && engine && !registration && (
          <section className={SECTION} aria-live="polite" aria-label="Engine revision created">
            <DoneHead
              title={`${engine.name} ${engine.version} is saved`}
              text="A private engine revision. Only your account can discover it. A material change needs a new version."
            />
            <Summary
              rows={[
                ['Engine', `${engine.namespace}/${engine.name} ${engine.version}`],
                ['State', engine.status],
              ]}
            />
            <div className={ACTIONS}>
              <Action
                variant="primary"
                onClick={() => {
                  setEngineOnly(false);
                  setStep(2);
                }}
              >
                Register a deployment for it
              </Action>
              <Action to={MY_ENGINES_PATH} variant="secondary">
                All my engines
              </Action>
              <Action variant="secondary" onClick={onRestart}>
                Register another engine
              </Action>
            </div>
          </section>
        )}

        {done && registration && engine && (
          <section className={SECTION} aria-live="polite" aria-label="Registration active">
            <DoneHead
              title={`${registration.name} ${registration.version} is active`}
              text={`Only you can pick it when launching a run. It counts as 1 of your ${allowance?.limit ?? 'plan’s'} federated engines.`}
            />
            <Summary
              rows={[
                ['Engine', `${engine.namespace}/${engine.name} ${engine.version}`],
                ['Endpoint', deployment.endpoint.trim(), true],
                ['Sign-in', authLabel],
              ]}
            />
            {probe && probe.verdict === 'verified' && <ConformanceChecklist probe={probe} />}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-tp-hairline bg-tp-surface px-4 py-3 text-sm text-tp-slate">
              <span className="min-w-0 flex-1">
                <strong className="text-tp-ink">Want others to use it?</strong>
                {publicationAsked || registration.status === 'pending_review'
                  ? ' An administrator will review it. Until then it stays private.'
                  : ' An administrator reviews it first. Requires an account or key allowed to publish engines.'}
              </span>
              {publicationAsked || registration.status === 'pending_review' ? (
                <StatusChip tone="warning">In review</StatusChip>
              ) : (
                <Action
                  variant="secondary"
                  busy={busy === 'publish'}
                  onClick={() => void requestPublication()}
                >
                  Request publication
                </Action>
              )}
            </div>
            <div className={ACTIONS}>
              <Action to={registrationHref(registration)} variant="primary">
                Open registration
              </Action>
              <Action variant="secondary" onClick={() => setLaunching(true)}>
                Launch a run with it
              </Action>
              <Action to={MY_ENGINES_PATH} variant="secondary">
                All my engines
              </Action>
            </div>
          </section>
        )}
      </div>

      {launching && engine && (
        <EngineLaunchModal
          title="Launch a run with it"
          actionLabel="Launch a run"
          noun="run"
          destination={org => launchPath(org, { engine: bimResourceKey(engine) })}
          onClose={() => setLaunching(false)}
        />
      )}
    </>
  );
}

function DoneHead({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full bg-tp-severity-success-bg text-tp-success-text"
      >
        <MdCheck className="h-5 w-5" />
      </span>
      <span className="flex flex-col">
        <strong className="text-base font-semibold text-tp-ink">{title}</strong>
        <span className="text-sm text-tp-slate">{text}</span>
      </span>
    </div>
  );
}

function Summary({ rows }: { rows: Array<[string, string, boolean?]> }) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-3">
      {rows.map(([label, value, mono]) => (
        <div key={label} className="flex flex-col gap-0.5 rounded-lg bg-tp-surface p-3">
          <dt className="text-[11px] text-tp-steel">{label}</dt>
          <dd className={`[overflow-wrap:anywhere] text-tp-ink ${mono ? 'font-mono' : ''}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * `/me/engines/new`: register an engine and, if you want, its deployment, in four steps on SPHERE's create-form page: the
 * engine revision, the address and contract, the credential, and the verification. `?from=` (with the exact identity)
 * starts from an existing registration as its next version.
 */
export default function RegisterEnginePage() {
  const api = useEnginesApi();
  const { user } = useAuth();
  const username = user?.username ?? '';
  const [params] = useSearchParams();
  const from = refFromAddress(params.get('from') ?? '', params);
  const [run, setRun] = useState(0);
  const setup = useResource(`register-setup:${username}:${from ? bimResourceKey(from) : ''}`, () =>
    loadSetup(api, from)
  );
  const allowance = useResource(`register-allowance:${username}`, () =>
    loadAllowance(api, username)
  );

  return (
    <div className="mx-auto mt-4 w-full max-w-[900px] px-4 pb-16">
      <Helmet>
        <title>OpenBinding - Register an engine</title>
      </Helmet>
      <Link
        to={MY_ENGINES_PATH}
        className="mb-4 inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm text-tp-steel transition-colors hover:text-tp-ink"
      >
        <MdArrowBack className="h-4 w-4" aria-hidden="true" />
        My engines
      </Link>
      {!setup.data ? (
        <>
          <h1 className="sr-only">Register a private engine</h1>
          <div aria-busy="true" aria-live="polite" className="flex flex-col gap-3">
            <div className="h-24 animate-pulse rounded-2xl bg-tp-surface" />
            <div className="h-64 animate-pulse rounded-2xl bg-tp-surface" />
          </div>
        </>
      ) : (
        <>
          {setup.data.prefillFailed && (
            <BlockAlert variant="warning" className="mb-4">
              <strong>The registration to copy couldn’t be read.</strong> You can still fill the
              form in from scratch.
            </BlockAlert>
          )}
          <Wizard
            key={run}
            username={username}
            setup={run === 0 ? setup.data : { ...setup.data, prefill: null }}
            allowance={allowance.data ?? allowance.stale ?? null}
            allowanceLoading={allowance.status === 'loading' && !allowance.stale}
            onAllowanceChanged={allowance.reload}
            onRestart={() => setRun(value => value + 1)}
          />
        </>
      )}
    </div>
  );
}
