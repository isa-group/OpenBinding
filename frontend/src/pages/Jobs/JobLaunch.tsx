import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import type { PricingCatalog, UsageView } from '../../api/auth';
import { casesApi } from '../../api/cases';
import { apiClient, type EngineCatalogEntry } from '../../api/client';
import { jobsApi, type JobReceipt } from '../../api/jobs';
import type { ArtifactVersion } from '../../api/library';
import type { Organization, Project } from '../../api/platform';
import { workbenchApi } from '../../api/workbench';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { zipStore } from '../../utils/bimZip';
import { useResource } from '../../utils/useResource';
import { classifyAuthError } from '../Account/accountErrors';
import { loadCases } from '../Project/projectData';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { CaseContent } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { refusalOf, type Refusal } from './jobErrors';
import { shortJobId } from './jobsModel';
import { AutoNote, EngineStep, ForecastBars, SettingsStep, SlotCountdown, SourceStep, type Prepared } from './LaunchSteps';
import {
  DEFAULT_POLICY, PROFILE_LABELS, buildRequest, forecastOf, initialChoice, modeChoices, modeOfCatalog, optionInputs, parseEngineParam, planCeilingsOf,
  planOptions, requestOptions, sourceChoices, type AutoPolicy, type SettingsSource, type SourceChoice,
} from './launchModel';
import { JobFrame, RefusalNotice } from './parts';

const STEPS = ['What', 'Engine', 'Settings', 'Send'] as const;

/** A revision that carries no snapshot of its own is compiled the way the Workbench does: its instance document, as a package of one file. */
async function snapshotOf(choice: SourceChoice): Promise<string> {
  if (choice.snapshotId) return choice.snapshotId;
  if (!choice.revision) throw new Error('This choice has nothing to compile.');
  const made = await workbenchApi.snapshot(zipStore({ 'instance.json': JSON.stringify(choice.revision.document, null, 2) }));
  return made.id;
}

function LaunchBody({ organization, project, canLaunch, role }: { organization: Organization; project: Project; canLaunch: boolean; role: Organization['effective_role'] }) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const caseParam = params.get('case');
  const revisionParam = params.get('revision');
  const snapshotParam = params.get('snapshot');
  const engineParam = parseEngineParam(params.get('engine'));
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;

  const cases = useResource<CaseContent[]>(`launch-cases:${org}/${slug}`, () => loadCases(org, slug));
  const usage = useResource<UsageView | null>('launch-usage', () => apiClient.getOwnUsage().catch(() => null));
  const pricing = useResource<PricingCatalog | null>('launch-pricing', () => apiClient.getPricingCatalog().catch(() => null));
  const catalog = useResource<EngineCatalogEntry[]>('launch-engines', () => apiClient.getEngines().catch(() => []));

  const [step, setStep] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareIssue, setPrepareIssue] = useState<Refusal | null>(null);
  const [pickedMode, setPickedMode] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsSource>('inline');
  const [configuration, setConfiguration] = useState<ArtifactVersion | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<AutoPolicy>(DEFAULT_POLICY);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [receipt, setReceipt] = useState<JobReceipt | null>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const choices = sourceChoices({ cases: cases.data ?? [], caseSlug: caseParam, revision: revisionParam, snapshot: snapshotParam });
  const chosenId = picked && choices.some((choice) => choice.id === picked) ? picked : initialChoice(choices, revisionParam, snapshotParam);
  const choice = choices.find((candidate) => candidate.id === chosenId) ?? null;
  const ready = prepared !== null && prepared.choiceId === chosenId ? prepared : null;

  const compatible = ready && ready.analysis.state === 'ok' ? ready.analysis.result.compatibleModes ?? null : null;
  const modes = ready ? modeChoices(compatible, catalog.data ?? []) : [];
  const wanted = engineParam ? modes.find((mode) => mode.compat !== 'no' && mode.engine.namespace === engineParam.namespace && mode.engine.name === engineParam.name
    && mode.engine.version === engineParam.version && mode.engine.digest === engineParam.digest) : undefined;
  const fallbackKey = wanted?.key ?? modes.find((mode) => mode.compat === 'yes')?.key ?? modes.find((mode) => mode.compat === 'unknown')?.key ?? 'auto';
  const selectedKey = pickedMode && (pickedMode === 'auto' || modes.some((mode) => mode.key === pickedMode)) ? pickedMode : fallbackKey;
  const auto = selectedKey === 'auto';
  const mode = auto ? null : modes.find((candidate) => candidate.key === selectedKey) ?? null;

  const ceilings = planCeilingsOf(usage.data ?? null, pricing.data ?? null, user?.plan);
  const inputs = optionInputs(modeOfCatalog(catalog.data ?? [], mode), ceilings);
  const plans = planOptions(inputs, values);
  const invalid = plans.some((plan) => plan.invalid);
  const reduced = plans.filter((plan) => plan.reduced);
  const request = buildRequest({
    snapshot: ready?.snapshotId ?? '', settings, configuration: configuration?.ref ?? null, auto, policy, mode, options: requestOptions(plans),
  });
  const sendable = canLaunch && request !== null && !invalid && !sending && receipt === null;

  const prepare = async () => {
    if (!choice) return;
    if (ready) { setStep(2); return; }
    setPreparing(true);
    setPrepareIssue(null);
    try {
      const snapshotId = await snapshotOf(choice);
      const analysis = await casesApi.analyseSnapshot(snapshotId).then(
        (result) => ({ state: 'ok' as const, result }),
        (caught: unknown) => ({ state: 'failed' as const, caught }),
      );
      if (analysis.state === 'failed' && classifyAuthError(analysis.caught).status === 404) {
        setPrepareIssue({
          kind: 'not-found', title: 'Snapshot not found (404)', details: [], status: 404,
          text: 'Snapshots open for whoever made them. Pick a case revision, or make a new snapshot in the Workbench.',
        });
        return;
      }
      setPrepared({
        choiceId: choice.id, snapshotId,
        analysis: analysis.state === 'ok' ? analysis : { state: 'failed', refusal: refusalOf(analysis.caught, 'launch') },
      });
      setStep(2);
    } catch (caught) {
      setPrepareIssue(refusalOf(caught, 'launch'));
    } finally {
      setPreparing(false);
    }
  };

  const send = async () => {
    if (!request || !sendable) return;
    const fingerprint = JSON.stringify(request);
    const key = attempt.current?.fingerprint === fingerprint ? attempt.current.key : crypto.randomUUID();
    attempt.current = { fingerprint, key };
    setSending(true);
    setRefusal(null);
    try {
      setReceipt(await jobsApi.launch(request, key));
    } catch (caught) {
      setRefusal(refusalOf(caught, 'launch'));
    } finally {
      setSending(false);
    }
  };

  const bindingSpace = ready && ready.analysis.state === 'ok' ? ready.analysis.result.analysis.bindingSpace : null;
  const timeBudget = plans.find((plan) => plan.input.kind === 'time')?.effective ?? ceilings.seconds ?? 0;
  const forecast = forecastOf({ usage: usage.data ?? null, ceilings, seconds: settings === 'inline' && !auto ? timeBudget : ceilings.seconds ?? 0, bindingSpace, plan: user?.plan });

  const modeLabel = auto ? 'the AutoRouter' : mode ? `${mode.engine.name} · ${mode.mode}` : 'the engine you pick';
  const engineText = settings === 'saved' ? 'From the saved settings'
    : auto ? `AutoRouter · ${PROFILE_LABELS[policy.profile]}`
      : mode ? `${mode.engine.name} ${mode.engine.version} · mode ${mode.mode}${mode.federated ? ' · your deployment' : ''}` : 'None chosen';
  const settingsText = settings === 'saved'
    ? (configuration ? `Saved: ${configuration.ref.name} v${configuration.ref.version}` : 'Saved settings (none chosen)')
    : auto ? `Policy ${PROFILE_LABELS[policy.profile].toLowerCase()}, up to ${policy.maxCredits} capacity units`
      : plans.length ? plans.map((plan) => `${plan.input.label} ${plan.effective === null ? 'default' : `${plan.effective.toLocaleString('en-US')} ${plan.input.unit}`}${plan.reduced ? ' (reduced)' : ''}`).join(' · ') : 'Engine defaults';
  const stepNotes = [
    choice?.label ?? 'Pick one',
    settings === 'saved' ? 'From saved settings' : auto ? 'AutoRouter' : mode ? mode.engine.name : 'Pick one',
    settings === 'saved' ? 'Saved settings' : reduced.length ? 'Some reduced' : 'Within plan',
    'Review',
  ];

  if (receipt) {
    const followed = `${root}/jobs/${receipt.id}`;
    return (
      <JobFrame organization={organization} project={project} trail={[{ label: 'Jobs', to: `${root}/jobs` }, { label: 'New run' }]} width="lg">
        <section className="job-sent" aria-live="polite" aria-label="Run accepted">
          <span className="job-sent-mark" aria-hidden="true">✓</span>
          <div>
            <h1>Run accepted · {receipt.status === 'queued' ? 'queued' : receipt.status}</h1>
            <p>
              Job {shortJobId(receipt.id)}. {receipt.idempotent ? 'This exact run had already been sent, so no second run was started. ' : ''}
              {reduced.length > 0 && settings === 'inline' && !auto
                ? `${reduced.map((plan) => `${plan.input.label} was reduced to ${plan.effective} ${plan.input.unit}`).join(', ')}, what your plan allows; the job carries that note.`
                : 'Nothing was reduced.'}
            </p>
          </div>
          <Action to={followed} variant="primary">Follow the run</Action>
        </section>
      </JobFrame>
    );
  }

  const casesFailure = cases.status === 'error' ? classifyAuthError(cases.error) : null;

  return (
    <JobFrame organization={organization} project={project} trail={[{ label: 'Jobs', to: `${root}/jobs` }, { label: 'New run' }]} width="lg">
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>New run</h1>
          <p>Choose what to solve, which exact engine, and its settings. Before sending you’ll see what your plan reduces and what the run will use.</p>
        </div>
      </header>

      {!canLaunch && (
        <div className="proj-note is-info" role="note">
          <Lock aria-hidden="true" className="org-inline-icon" />
          <span>You’re {role === 'VIEWER' ? 'a ' : ''}<strong>{role ?? 'not a member'}</strong> of {organization.name}. You can look through the steps, but starting a run needs MEMBER.</span>
        </div>
      )}
      {casesFailure && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={cases.reload}>Try again</Action>}>
          The project’s cases couldn’t be loaded{casesFailure.status ? ` (${casesFailure.status})` : ''}. A snapshot from the address still works.
        </Notice>
      )}

      <ol className="job-steps" aria-label="Steps">
        {STEPS.map((label, index) => {
          const number = index + 1;
          const current = step === number;
          return (
            <li key={label}>
              <button type="button" aria-current={current ? 'step' : undefined} className={current ? 'is-current' : ''} disabled={number > 1 && !ready} onClick={() => setStep(number)}>
                <span className="job-step-dot" aria-hidden="true">{step > number ? '✓' : number}</span>
                <span><b>{label}</b><small>{stepNotes[index]}</small></span>
              </button>
            </li>
          );
        })}
      </ol>

      {cases.status === 'loading' && !snapshotParam
        ? <div role="status" aria-busy="true"><span className="sr-only">Loading the project’s cases…</span><Skeleton variant="panel" /></div>
        : (
          <section className="job-wizard" aria-label={`Step ${step} of 4: ${STEPS[step - 1]}`}>
            {step === 1 && (
              <SourceStep choices={choices} value={chosenId} onChange={(id) => { setPicked(id); setPrepareIssue(null); }} workbenchHref={`${root}/workbench`} />
            )}
            {step === 1 && prepareIssue && <RefusalNotice refusal={prepareIssue} usageTo />}

            {step === 2 && ready && (
              <EngineStep
                modes={modes}
                value={selectedKey}
                onChange={setPickedMode}
                hasPrepared
                compareHref="/engines"
                analysisNote={ready.analysis.state === 'failed'
                  ? <RefusalNotice refusal={ready.analysis.refusal} usageTo />
                  : undefined}
              />
            )}

            {step === 3 && ready && (
              <>
                {auto && settings === 'inline' && <AutoNote />}
                <SettingsStep
                  org={org} auto={auto} source={settings} onSource={setSettings} plans={plans} values={values}
                  onValue={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
                  policy={policy} onPolicy={setPolicy} configuration={configuration} onConfiguration={setConfiguration}
                  libraryHref={`/app/${org}/library`} modeLabel={modeLabel}
                />
              </>
            )}

            {step === 4 && ready && (
              <>
                <h2>Before you send</h2>
                <dl className="job-review">
                  <dt>Solve</dt><dd>{choice?.label}</dd>
                  <dt>Engine</dt><dd>{engineText}</dd>
                  <dt>Settings</dt><dd>{settingsText}</dd>
                </dl>
                <ForecastBars bars={forecast} />
                <span className="org-muted">Sending twice by accident won’t start two runs: each send carries a one-time key.</span>
                {refusal && (
                  <RefusalNotice
                    refusal={refusal}
                    usageTo
                    extra={refusal.kind === 'busy' ? <SlotCountdown key={refusal.retryAfter} seconds={refusal.retryAfter ?? 15} /> : undefined}
                  />
                )}
              </>
            )}

            {(preparing || sending) && (
              <span role="status" className="job-checking"><span className="job-spinner" aria-hidden="true" />Checking compatibility and your limits…</span>
            )}

            <div className="job-footer">
              <span className="job-footer-side">
                <Action to={`${root}/jobs`} variant="ghost">Cancel</Action>
                {step > 1 && <Action variant="secondary" onClick={() => setStep(step - 1)}>Back</Action>}
              </span>
              <span className="job-footer-side">
                {step < 4 && (
                  <Action
                    variant="primary" busy={preparing} disabled={step === 1 ? !choice : false}
                    onClick={() => (step === 1 ? void prepare() : setStep(step + 1))}
                  >
                    Continue
                  </Action>
                )}
                {step === 4 && (
                  <Action variant="primary" busy={sending} disabled={!sendable} onClick={() => void send()} title={!canLaunch ? 'Starting a run needs MEMBER' : undefined}>
                    Send run
                  </Action>
                )}
              </span>
            </div>
          </section>
        )}
    </JobFrame>
  );
}

/** Start a run (`job-launch`, `/app/:org/:project/jobs/new`): what to solve, the exact engine, its settings, and what the plan reduces. */
export function JobLaunch() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <LaunchBody key={`${organization.slug}/${project.slug}`} organization={organization} project={project} canLaunch={access.canCreate} role={access.role} />;
}
