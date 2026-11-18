// Adapted from SPHERE frontend/src/modules/pricing/pages/create/index.tsx and
// frontend/src/modules/pricing/components/create-pricing-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a run instead of a pricing. SPHERE's form page (`max-w-[900px]`, the back link, the centred display title, the
// organization selector first, preselected by `?org=`) holds OpenBinding's launch steps as cards: what to solve, the exact
// engine (or a run preset of the organization), the settings against the plan and "Before you send"; the launch carries a
// one-time Idempotency-Key, and a receipt card leads to the run page. A VIEWER the address names looks through the steps
// but cannot send.

import { useCallback, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useSearchParams } from 'react-router-dom';
import type { PricingDocument, UsageView } from '../../../core/api/account';
import { type EngineCatalogEntry } from '../../../engine/api/engineClient';
import { problemsApi } from '../../../problem/api/problemsClient';
import type { CaseContent } from '../../../problem/api/loadProblems';
import { randomUUID } from '../../../core/utils/uuid';
import { useResource } from '../../../core/hooks/useResource';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { classifyAuthError } from '../../../core/api/errors';
import type { RunPresetList, RunPresetView } from '../../../core/api/types';
import { hasRanges, problemFactsApi } from '../../../core/utils/problem/facts';
import { useAuth } from '../../../auth/hooks/useAuth';
import OrganizationSelector from '../../../organization/components/organization-selector';
import type { Organization } from '../../../organization/api/organizationsApi';
import { useOrganization } from '../../../organization/hooks/useOrganization';
import { orgPath } from '../../../organization/types/paths';
import { problemsPath } from '../../../../routes/paths/problems';
import { runPath, runsPath } from '../../../../routes/paths/runs';
import { loadProblemVersions } from '../../api/launchApi';
import { PRESET_PAGE, presetsApi } from '../../api/presetsApi';
import { presetEngineText, presetOptionsText, presetRegistrationText } from '../../api/presetText';
import { useRunsApi, type ExecutionOptimization, type JobReceipt } from '../../api/runsApi';
import {
  EngineStep,
  ForecastBars,
  SettingsStep,
  SlotCountdown,
  SourceStep,
  StepCard,
  type Prepared,
} from '../../components/launch-steps';
import { AttachedPreset, PresetPicker, SavePresetDialog } from '../../components/preset-picker';
import { RefusalNotice } from '../../components/run-status';
import { refusalOf, type Refusal } from '../../utils/runErrors';
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
} from '../../utils/launchModel';
import { engineClient } from '../../../engine/api/engineClient';
import { planClient } from '../../../settings/api/planClient';

const ROLES = ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'];
const atLeastMember = (role: string | null | undefined) =>
  role ? ROLES.indexOf(role) >= ROLES.indexOf('MEMBER') : false;

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

const reviewClass =
  'grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr] [&_dd]:mb-2 [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-tp-ink sm:[&_dd]:mb-0 [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-tp-steel sm:[&_dt]:text-sm';

function LaunchBody({ organization }: { organization: Organization }) {
  const { user } = useAuth();
  const { create } = useRunsApi();
  const [params] = useSearchParams();
  const problemParam = params.get('problem');
  const revisionParam = params.get('revision');
  const engineParam = parseEngineParam(params.get('engine'));
  const presetParam = params.get('preset');
  const org = organization.slug;
  const role = organization.effective_role ?? null;
  const canLaunch = atLeastMember(role);

  const cases = useResource<CaseContent[]>(`launch-problems:${org}`, () =>
    loadProblemVersions(org)
  );
  const usage = useResource<UsageView | null>('launch-usage', () =>
    planClient.getOwnUsage().catch(() => null)
  );
  const pricing = useResource<PricingDocument | null>('launch-pricing', () =>
    planClient
      .getPlansPricing()
      .then(answer => answer.document)
      .catch(() => null)
  );
  const catalog = useResource<EngineCatalogEntry[]>('launch-engines', () =>
    engineClient.getEngines().catch(() => [])
  );
  const presets = useResource<RunPresetList | null>(`launch-presets:${org}`, () =>
    presetsApi.list(org, { limit: PRESET_PAGE }).catch(() => null)
  );

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
    if (!choice || ready) return;
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
      setReceipt(await create(org, request, key));
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
  const canSave = canLaunch && !attached && request !== null && mode !== null && !invalid;

  if (receipt) {
    return (
      <section
        aria-live="polite"
        aria-label="Run accepted"
        className="flex flex-col items-center gap-3 rounded-xl border border-tp-severity-success-border bg-tp-canvas p-8 text-center"
      >
        <span
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-tp-severity-success-bg text-xl text-tp-success-text"
        >
          ✓
        </span>
        <h2 className="font-display text-xl text-tp-ink">
          Run accepted · {receipt.status === 'queued' ? 'queued' : receipt.status}
        </h2>
        <p className="max-w-[576px] text-sm text-tp-slate">
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
        <Action to={runPath(org, receipt.id)} variant="primary">
          Follow the run
        </Action>
      </section>
    );
  }

  const casesFailure = cases.status === 'error' ? classifyAuthError(cases.error) : null;

  return (
    <div className="flex flex-col gap-4">
      {!canLaunch && (
        <div
          role="note"
          className="rounded-lg border border-tp-severity-info-border bg-tp-severity-info-bg px-3.5 py-2.5 text-sm text-tp-ink"
        >
          You’re {role === 'VIEWER' ? 'a ' : ''}
          <strong>{role ?? 'not a member'}</strong> of {organization.name}. You can look through the
          steps, but starting a run needs MEMBER.
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

      {cases.status === 'loading' ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Loading the organization’s problems…</span>
          {[0, 1].map(index => (
            <div key={index} className="h-28 animate-pulse rounded-xl bg-tp-surface" />
          ))}
        </div>
      ) : (
        <>
          <StepCard number={1} title="What to solve" note={choice?.label}>
            <SourceStep
              choices={choices}
              value={chosenId}
              onChange={id => {
                setPicked(id);
                setPrepareIssue(null);
              }}
              problemsHref={problemsPath(org)}
            />
            {prepareIssue && <RefusalNotice refusal={prepareIssue} usageTo />}
            {!ready && (
              <span className="flex justify-end">
                <Action
                  variant="primary"
                  busy={preparing}
                  disabled={!choice}
                  onClick={() => void prepare()}
                >
                  Continue
                </Action>
              </span>
            )}
          </StepCard>

          {ready && (
            <>
              <StepCard
                number={2}
                title="Engine"
                note={attached ? attached.name : mode ? mode.engine.name : undefined}
              >
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
                      manageHref={orgPath(org, 'presets')}
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
              </StepCard>

              <StepCard
                number={3}
                title="Settings"
                note={
                  attached ? 'From the preset' : reduced.length ? 'Some reduced' : 'Within plan'
                }
              >
                {attached ? (
                  <>
                    <p className="text-sm text-tp-slate">
                      The settings come from the preset {attached.name}:{' '}
                      {presetOptionsText(attached.options)}.
                    </p>
                    <p className="text-xs text-tp-steel">
                      Your plan’s ceilings still apply: what is above them runs at the ceiling, and
                      the run records it.
                    </p>
                    <span className="flex gap-2">
                      <Action variant="secondary" size="sm" onClick={detach}>
                        Edit
                      </Action>
                    </span>
                  </>
                ) : (
                  <SettingsStep
                    plans={plans}
                    values={values}
                    onValue={(name, value) => setValues(current => ({ ...current, [name]: value }))}
                    modeLabel={modeLabel}
                  />
                )}
              </StepCard>

              <StepCard number={4} title="Before you send">
                <dl className={reviewClass}>
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
                  <span className="flex gap-2">
                    <Action variant="secondary" size="sm" onClick={() => setSaving(true)}>
                      Save as preset
                    </Action>
                  </span>
                )}
                {saved && (
                  <Notice tone="success">
                    Saved as the run preset {saved.name}. Runs and studies of {organization.name}{' '}
                    can start from it.
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
                <span className="text-xs text-tp-steel">
                  Sending twice by accident won’t start two runs: each send carries a one-time key.
                </span>
                {refusal && (
                  <RefusalNotice
                    refusal={refusal}
                    usageTo
                    extra={
                      refusal.kind === 'busy' ? (
                        <SlotCountdown
                          key={refusal.retryAfter}
                          seconds={refusal.retryAfter ?? 15}
                        />
                      ) : undefined
                    }
                  />
                )}
              </StepCard>
            </>
          )}

          {(preparing || sending) && (
            <span role="status" className="flex items-center gap-2 text-sm text-tp-steel">
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-tp-hairline border-t-tp-primary"
                aria-hidden="true"
              />
              Checking compatibility and your limits…
            </span>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Action to={runsPath(org)} variant="ghost">
              Cancel
            </Action>
            {ready && (
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
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Start a run (`run-launch`, `/runs/new?org=&problem=&revision=&engine=&preset=`): the organization first, then which
 * problem version, the exact engine, its settings, and what the plan reduces.
 */
export default function RunLaunchPage() {
  const [params, setParams] = useSearchParams();
  const initialOrg = params.get('org');
  const { organizations } = useOrganization();
  const [chosen, setChosen] = useState<Organization | null>(null);
  // The organization the address names, when the account reads it but may not launch there: shown read-only.
  const named = organizations.find(item => item.slug === initialOrg) ?? null;
  const readOnly = named && !atLeastMember(named.effective_role) ? named : null;
  const organization = chosen ?? readOnly;

  const choose = useCallback(
    (next: Organization | null) => {
      setChosen(next);
      if (!next || next.slug === initialOrg) return;
      // Another organization: what the address chose (a problem, a version, a preset) belongs to the one before.
      setParams(
        previous => {
          const kept = new URLSearchParams();
          kept.set('org', next.slug);
          const engine = previous.get('engine');
          if (engine) kept.set('engine', engine);
          return kept;
        },
        { replace: true }
      );
    },
    [initialOrg, setParams]
  );

  return (
    <div className="mx-auto mt-4 w-full max-w-[900px] px-4 pb-12">
      <Helmet>
        <title>OpenBinding - New run</title>
      </Helmet>
      <div className="flex flex-col gap-4">
        {initialOrg && (
          <Link
            to={runsPath(initialOrg)}
            className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm text-tp-steel transition-colors hover:text-tp-ink"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to the runs
          </Link>
        )}
        <div className="text-center">
          <h1 className="font-display text-2xl text-tp-ink">New run</h1>
          <p className="mt-1 text-sm text-tp-steel">
            Choose what to solve, which exact engine, and its settings. Before sending you’ll see
            what your plan reduces and what the run will use.
          </p>
        </div>
        <OrganizationSelector
          value={chosen}
          onChange={choose}
          initialSlug={initialOrg}
          minRole="MEMBER"
        />
        {organization ? (
          <LaunchBody key={organization.slug} organization={organization} />
        ) : (
          <p className="text-center text-sm text-tp-steel">
            Choose the organization the run belongs to: its problems and run presets are offered
            here.
          </p>
        )}
      </div>
    </div>
  );
}
