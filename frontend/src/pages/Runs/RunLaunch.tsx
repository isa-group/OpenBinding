import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import type { PricingCatalog, UsageView } from '../../api/auth';
import { apiClient, type EngineCatalogEntry } from '../../api/client';
import { runsApi, type ExecutionOptimization, type JobReceipt } from '../../api/runs';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { randomUUID } from '../../utils/uuid';
import { classifyAuthError } from '../../shared/api/errors';
import { problemsApi } from '../../api/problems';
import { hasRanges, problemFactsApi } from '../../entities/problem/facts';
import { PRESET_PAGE, presetsApi } from '../../entities/preset/api';
import {
  presetEngineText,
  presetOptionsText,
  presetRegistrationText,
} from '../../entities/preset/preset';
import type { RunPresetList, RunPresetView } from '../../shared/api/types';
import { loadProblems } from '../Problems/problemsData';
import { problemsPath } from '../../routes/paths/problems';
import { runPath, runsPath } from '../../routes/paths/runs';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import type { CaseContent } from '../../features/workspace/model';
import { problemAccess } from '../Problems/useRouteProblem';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { refusalOf, type Refusal } from './runErrors';
import {
  EngineStep,
  ForecastBars,
  SettingsStep,
  SlotCountdown,
  SourceStep,
  type Prepared,
} from './LaunchSteps';
import {
  buildRequest,
  forecastOf,
  initialChoice,
  modeChoices,
  modeOfCatalog,
  optimizationFor,
  optionInputs,
  parseEngineParam,
  planCeilingsOf,
  planOptions,
  presetModeOf,
  presetSettingsOf,
  presetValues,
  requestOptions,
  sourceChoices,
} from './launchModel';
import { AttachedPreset, PresetPicker, SavePresetDialog } from './PresetPicker';
import { JobFrame, RefusalNotice } from './parts';

const STEPS = ['What', 'Engine', 'Settings', 'Send'] as const;

/**
 * Does the compiled revision hold a range, and how many criteria does it optimize? Both are read from its facts. Not being able to read
 * them is not a reason to stop: every mode is then offered, and the gateway decides about the optimization.
 */
async function readCompiled(
  org: string,
  problem: string,
  revision: number,
  compilation: string
): Promise<{ ranges: boolean; criteria: number | null }> {
  try {
    const facts = await problemFactsApi.get(org, problem, revision, compilation);
    return { ranges: hasRanges(facts), criteria: facts.objectives.criteria.length };
  } catch {
    return { ranges: false, criteria: null };
  }
}

function LaunchBody({
  organization,
  canLaunch,
  role,
}: {
  organization: Organization;
  canLaunch: boolean;
  role: Organization['effective_role'];
}) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const problemParam = params.get('problem');
  const revisionParam = params.get('revision');
  const engineParam = parseEngineParam(params.get('engine'));
  const presetParam = params.get('preset');
  const org = organization.slug;

  const cases = useResource<CaseContent[]>(`launch-problems:${org}`, () => loadProblems(org));
  const usage = useResource<UsageView | null>('launch-usage', () =>
    apiClient.getOwnUsage().catch(() => null)
  );
  const pricing = useResource<PricingCatalog | null>('launch-pricing', () =>
    apiClient.getPricingCatalog().catch(() => null)
  );
  const catalog = useResource<EngineCatalogEntry[]>('launch-engines', () =>
    apiClient.getEngines().catch(() => [])
  );
  const presets = useResource<RunPresetList | null>(`launch-presets:${org}`, () =>
    presetsApi.list(org, { limit: PRESET_PAGE }).catch(() => null)
  );

  const [step, setStep] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareIssue, setPrepareIssue] = useState<Refusal | null>(null);
  const [pickedMode, setPickedMode] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [receipt, setReceipt] = useState<JobReceipt | null>(null);
  const [attachedSlug, setAttachedSlug] = useState<string | null>(presetParam);
  /** The optimization of a preset that was detached: kept while the mode it names stays chosen. */
  const [inherited, setInherited] = useState<{
    modeKey: string;
    optimization: ExecutionOptimization;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<RunPresetView | null>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const choices = sourceChoices({
    cases: cases.data ?? [],
    problem: problemParam,
    revision: revisionParam,
  });
  const chosenId =
    picked && choices.some(choice => choice.id === picked)
      ? picked
      : initialChoice(choices, revisionParam);
  const choice = choices.find(candidate => candidate.id === chosenId) ?? null;
  const ready = prepared !== null && prepared.choiceId === chosenId ? prepared : null;

  const compatible =
    ready && ready.analysis.state === 'ok' ? ready.analysis.result.compatible_modes : null;
  const ranges = ready?.ranges === true;
  const modes = ready ? modeChoices(compatible, catalog.data ?? [], ranges) : [];
  const wanted = engineParam
    ? modes.find(
        mode =>
          mode.compat !== 'no' &&
          mode.engine.namespace === engineParam.namespace &&
          mode.engine.name === engineParam.name &&
          mode.engine.version === engineParam.version &&
          mode.engine.digest === engineParam.digest
      )
    : undefined;
  const fallbackKey =
    wanted?.key ??
    modes.find(mode => mode.compat === 'yes')?.key ??
    modes.find(mode => mode.compat === 'unknown')?.key ??
    '';
  const selectedKey =
    pickedMode && modes.some(mode => mode.key === pickedMode) ? pickedMode : fallbackKey;
  const mode = modes.find(candidate => candidate.key === selectedKey) ?? null;

  // The organization's run presets: `[]` while they load, `null` when they can't be read (the settings are then chosen here).
  const presetList = presets.data === undefined ? [] : (presets.data?.presets ?? null);
  const attached = attachedSlug
    ? (presetList?.find(preset => preset.slug === attachedSlug || preset.id === attachedSlug) ??
      null)
    : null;
  const attachedMode = attached ? presetModeOf(attached, modes) : null;

  const ceilings = planCeilingsOf(usage.data ?? null, pricing.data ?? null, user?.plan);
  const inputs = optionInputs(modeOfCatalog(catalog.data ?? [], mode), ceilings);
  const plans = planOptions(inputs, values);
  // A preset carries its own settings: the form's are neither checked nor sent while one is attached.
  const invalid = !attached && plans.some(plan => plan.invalid);
  const reduced = attached ? [] : plans.filter(plan => plan.reduced);
  const optimization =
    inherited && inherited.modeKey === selectedKey
      ? inherited.optimization
      : optimizationFor(modeOfCatalog(catalog.data ?? [], mode), ready?.criteria ?? null);
  const options = requestOptions(plans);
  const request = buildRequest({
    revision: ready ? (choice?.revision.id ?? '') : '',
    mode,
    options,
    optimization,
    preset: attached?.slug ?? null,
  });
  const sendable = canLaunch && request !== null && !invalid && !sending && receipt === null;

  const pickPreset = (slug: string | null) => {
    setAttachedSlug(slug);
    setInherited(null);
    setSaved(null);
    setRefusal(null);
  };

  /** "Edit": the preset's engine, mode and options move into the form, where they can be changed; nothing refers to the preset any more. */
  const detach = () => {
    if (!attached) return;
    const matched = presetModeOf(attached, modes);
    if (matched) setPickedMode(matched.key);
    setValues(
      presetValues(
        attached.options,
        optionInputs(modeOfCatalog(catalog.data ?? [], matched ?? mode), ceilings)
      )
    );
    setInherited(
      matched && attached.optimization
        ? {
            modeKey: matched.key,
            optimization: attached.optimization as unknown as ExecutionOptimization,
          }
        : null
    );
    setAttachedSlug(null);
    setRefusal(null);
  };

  const prepare = async () => {
    if (!choice) return;
    if (ready) {
      setStep(2);
      return;
    }
    setPreparing(true);
    setPrepareIssue(null);
    try {
      const analysis = await problemsApi
        .compilation(org, choice.caseSlug, choice.revision.revision)
        .then(
          result => ({ state: 'ok' as const, result }),
          (caught: unknown) => ({ state: 'failed' as const, caught })
        );
      if (analysis.state === 'failed' && classifyAuthError(analysis.caught).status === 404) {
        setPrepareIssue({
          kind: 'not-found',
          title: 'Problem version not found (404)',
          details: [],
          status: 404,
          text: 'It may have been deleted with its problem. Pick another version.',
        });
        return;
      }
      // What the engines will receive decides whether a mode that takes single values only can be offered; not knowing it offers every mode.
      const compiled =
        analysis.state === 'ok'
          ? await readCompiled(org, choice.caseSlug, choice.revision.revision, analysis.result.id)
          : { ranges: false, criteria: null };
      setPrepared({
        choiceId: choice.id,
        ranges: compiled.ranges,
        criteria: compiled.criteria,
        analysis:
          analysis.state === 'ok'
            ? analysis
            : { state: 'failed', refusal: refusalOf(analysis.caught, 'launch') },
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
    const key = attempt.current?.fingerprint === fingerprint ? attempt.current.key : randomUUID();
    attempt.current = { fingerprint, key };
    setSending(true);
    setRefusal(null);
    try {
      setReceipt(await runsApi.create(org, request, key));
    } catch (caught) {
      setRefusal(refusalOf(caught, 'launch'));
    } finally {
      setSending(false);
    }
  };

  const bindingSpace =
    ready && ready.analysis.state === 'ok' ? ready.analysis.result.analysis.bindingSpace : null;
  const forecast = forecastOf({ ceilings, bindingSpace, plan: user?.plan });

  const modeLabel = mode ? `${mode.engine.name} · ${mode.mode}` : 'the engine you pick';
  const manualEngineText = mode
    ? `${mode.engine.name} ${mode.engine.version} · mode ${mode.mode}${mode.federated ? ' · your deployment' : ''}`
    : 'None chosen';
  const manualSettingsText = plans.length
    ? plans
        .map(
          plan =>
            `${plan.input.label} ${plan.effective === null ? 'default' : `${plan.effective.toLocaleString('en-US')} ${plan.input.unit}`}${plan.reduced ? ' (reduced)' : ''}`
        )
        .join(' · ')
    : 'Engine defaults';
  const attachedRegistration = attached ? presetRegistrationText(attached.registration) : null;
  const engineText = attached
    ? `${presetEngineText(attached)}${attachedRegistration ? ` · ${attachedRegistration}` : ''}`
    : manualEngineText;
  const settingsText = attached ? presetOptionsText(attached.options) : manualSettingsText;
  const stepNotes = [
    choice?.label ?? 'Pick one',
    attached ? attached.name : mode ? mode.engine.name : 'Pick one',
    attached ? 'From the preset' : reduced.length ? 'Some reduced' : 'Within plan',
    'Review',
  ];
  const manageHref = `/app/${org}/settings/presets`;
  const canSave = canLaunch && !attached && request !== null && mode !== null && !invalid;

  if (receipt) {
    const followed = runPath(org, receipt.id);
    return (
      <JobFrame
        organization={organization}
        trail={[{ label: 'Runs', to: runsPath(org) }, { label: 'New run' }]}
        width="lg"
      >
        <section className="job-sent" aria-live="polite" aria-label="Run accepted">
          <span className="job-sent-mark" aria-hidden="true">
            ✓
          </span>
          <div>
            <h1>Run accepted · {receipt.status === 'queued' ? 'queued' : receipt.status}</h1>
            <p>
              Your run was sent.{' '}
              {receipt.idempotent
                ? 'This exact run had already been sent, so no second run was started. '
                : ''}
              {attached
                ? `It runs with the settings of the preset ${attached.name}; your plan’s ceilings apply to them and the run records any reduction.`
                : reduced.length > 0
                  ? `${reduced.map(plan => `${plan.input.label} was reduced to ${plan.effective} ${plan.input.unit}`).join(', ')}, what your plan allows; the run carries that note.`
                  : 'Nothing was reduced.'}
            </p>
          </div>
          <Action to={followed} variant="primary">
            Follow the run
          </Action>
        </section>
      </JobFrame>
    );
  }

  const casesFailure = cases.status === 'error' ? classifyAuthError(cases.error) : null;

  return (
    <JobFrame
      organization={organization}
      trail={[{ label: 'Runs', to: runsPath(org) }, { label: 'New run' }]}
      width="lg"
    >
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>New run</h1>
          <p>
            Choose what to solve, which exact engine, and its settings. Before sending you’ll see
            what your plan reduces and what the run will use.
          </p>
        </div>
      </header>

      {!canLaunch && (
        <div className="proj-note is-info" role="note">
          <Lock aria-hidden="true" className="org-inline-icon" />
          <span>
            You’re {role === 'VIEWER' ? 'a ' : ''}
            <strong>{role ?? 'not a member'}</strong> of {organization.name}. You can look through
            the steps, but starting a run needs MEMBER.
          </span>
        </div>
      )}
      {casesFailure && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={cases.reload}>
              Try again
            </Action>
          }
        >
          The organization’s problems couldn’t be loaded
          {casesFailure.status ? ` (${casesFailure.status})` : ''}.
        </Notice>
      )}

      <ol className="job-steps" aria-label="Steps">
        {STEPS.map((label, index) => {
          const number = index + 1;
          const current = step === number;
          return (
            <li key={label}>
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                className={current ? 'is-current' : ''}
                disabled={number > 1 && !ready}
                onClick={() => setStep(number)}
              >
                <span className="job-step-dot" aria-hidden="true">
                  {step > number ? '✓' : number}
                </span>
                <span>
                  <b>{label}</b>
                  <small>{stepNotes[index]}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {cases.status === 'loading' ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the organization’s problems…</span>
          <Skeleton variant="panel" />
        </div>
      ) : (
        <section className="job-wizard" aria-label={`Step ${step} of 4: ${STEPS[step - 1]}`}>
          {step === 1 && (
            <SourceStep
              choices={choices}
              value={chosenId}
              onChange={id => {
                setPicked(id);
                setPrepareIssue(null);
              }}
              problemsHref={problemsPath(org)}
            />
          )}
          {step === 1 && prepareIssue && <RefusalNotice refusal={prepareIssue} usageTo />}

          {step === 2 && ready && (
            <EngineStep
              modes={modes}
              value={selectedKey}
              onChange={setPickedMode}
              hasPrepared
              ranges={ranges}
              compareHref="/engines"
              preset={
                <PresetPicker
                  presets={presetList}
                  value={attached?.slug ?? null}
                  onChange={pickPreset}
                  manageHref={manageHref}
                />
              }
              attached={
                attached ? (
                  <AttachedPreset preset={attached} mode={attachedMode} onDetach={detach} />
                ) : undefined
              }
              analysisNote={
                ready.analysis.state === 'failed' ? (
                  <RefusalNotice refusal={ready.analysis.refusal} usageTo />
                ) : undefined
              }
            />
          )}

          {step === 3 && ready && attached && (
            <>
              <h2>Settings</h2>
              <p className="org-muted">
                The settings come from the preset {attached.name}:{' '}
                {presetOptionsText(attached.options)}.
              </p>
              <p className="org-muted">
                Your plan’s ceilings still apply: what is above them runs at the ceiling, and the
                run records it.
              </p>
              <span className="job-buttons">
                <Action variant="secondary" size="sm" onClick={detach}>
                  Edit
                </Action>
              </span>
            </>
          )}
          {step === 3 && ready && !attached && (
            <SettingsStep
              plans={plans}
              values={values}
              onValue={(name, value) => setValues(current => ({ ...current, [name]: value }))}
              modeLabel={modeLabel}
            />
          )}

          {step === 4 && ready && (
            <>
              <h2>Before you send</h2>
              <dl className="job-review">
                <dt>Solve</dt>
                <dd>{choice?.label}</dd>
                {attached && (
                  <>
                    <dt>Run preset</dt>
                    <dd>
                      {attached.name} ({attached.slug})
                    </dd>
                  </>
                )}
                <dt>Engine</dt>
                <dd>{engineText}</dd>
                <dt>Settings</dt>
                <dd>{settingsText}</dd>
              </dl>
              {canSave && !saved && (
                <span className="job-buttons">
                  <Action variant="secondary" size="sm" onClick={() => setSaving(true)}>
                    Save these settings as a preset
                  </Action>
                </span>
              )}
              {saved && (
                <Notice tone="success">
                  Saved as the run preset {saved.name}. Runs and studies of {organization.name} can
                  start from it.
                </Notice>
              )}
              {saving && mode && (
                <SavePresetDialog
                  org={org}
                  settings={presetSettingsOf(mode, options, optimization)}
                  summary={`${manualEngineText} · ${manualSettingsText}`}
                  onClose={() => setSaving(false)}
                  onSaved={preset => {
                    setSaving(false);
                    setSaved(preset);
                    presets.reload();
                  }}
                />
              )}
              <ForecastBars bars={forecast} />
              <span className="org-muted">
                Sending twice by accident won’t start two runs: each send carries a one-time key.
              </span>
              {refusal && (
                <RefusalNotice
                  refusal={refusal}
                  usageTo
                  extra={
                    refusal.kind === 'busy' ? (
                      <SlotCountdown key={refusal.retryAfter} seconds={refusal.retryAfter ?? 15} />
                    ) : undefined
                  }
                />
              )}
            </>
          )}

          {(preparing || sending) && (
            <span role="status" className="job-checking">
              <span className="job-spinner" aria-hidden="true" />
              Checking compatibility and your limits…
            </span>
          )}

          <div className="job-footer">
            <span className="job-footer-side">
              <Action to={runsPath(org)} variant="ghost">
                Cancel
              </Action>
              {step > 1 && (
                <Action variant="secondary" onClick={() => setStep(step - 1)}>
                  Back
                </Action>
              )}
            </span>
            <span className="job-footer-side">
              {step < 4 && (
                <Action
                  variant="primary"
                  busy={preparing}
                  disabled={step === 1 ? !choice : false}
                  onClick={() => (step === 1 ? void prepare() : setStep(step + 1))}
                >
                  Continue
                </Action>
              )}
              {step === 4 && (
                <Action
                  variant="primary"
                  busy={sending}
                  disabled={!sendable}
                  onClick={() => void send()}
                  title={!canLaunch ? 'Starting a run needs MEMBER' : undefined}
                >
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

/** Start a run (`run-launch`, `/app/:org/runs/new`): which problem version of the organization, the exact engine, its settings, and what the plan reduces. */
export function RunLaunch() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  const access = problemAccess(organization);
  return (
    <LaunchBody
      key={organization.slug}
      organization={organization}
      canLaunch={access.canCreate}
      role={access.role}
    />
  );
}
