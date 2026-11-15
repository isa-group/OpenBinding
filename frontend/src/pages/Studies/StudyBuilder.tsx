import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { UsageView } from '../../api/auth';
import { apiClient, type EngineCatalogEntry } from '../../api/client';
import { platformApi, type Organization, type Study } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { planCeilingsOf } from '../Jobs/launchModel';
import { RefusalNotice } from '../Jobs/parts';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { problemsApi } from '../../api/problems';
import { loadProblems } from '../Cases/problemsData';
import { SLUG_PATTERN, slugFromName, type CaseContent } from '../../features/workspace/model';
import { studiesPath, studyPath } from '../../routes/paths/studies';
import { problemAccess } from '../Cases/useRouteProblem';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { CasesField, EnginesField, SettingsField } from './BuilderFields';
import { StudyFrame } from './parts';
import {
  MAX_CASES, MAX_CELLS, MAX_ENGINES, MAX_SETTINGS, defaultSelection, definitionEngines, emptyVariant, engineChoices, formulaOf,
  matrixSize, parametersKey, readSeeds, readVariant, revisionsOf, studyCriteriaCount, type Variant,
} from './studiesModel';
import { studyRefusal, type Refusal } from './studyErrors';

function BuilderBody({ organization, canCreate }: { organization: Organization; canCreate: boolean }) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const org = organization.slug;

  const cases = useResource<CaseContent[]>(`builder-problems:${org}`, () => loadProblems(org));
  const engines = useResource<EngineCatalogEntry[]>('builder-engines', () => apiClient.getEngines());
  const usage = useResource<UsageView | null>('builder-usage', () => apiClient.getOwnUsage().catch(() => null));
  const pricing = useResource<Record<string, unknown> | null>('builder-pricing', () => apiClient.getPricingCatalog().catch(() => null));

  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedEngines, setPickedEngines] = useState<string[]>([]);
  const [variants, setVariants] = useState<Variant[]>([emptyVariant('v1')]);
  const [serial, setSerial] = useState(1);
  const [seedText, setSeedText] = useState('1, 2');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [created, setCreated] = useState<Study | null>(null);

  const caseList = cases.data ?? cases.stale;
  const defaults = useMemo(
    () => defaultSelection({ cases: caseList ?? [], caseSlug: params.get('case'), revision: params.get('revision') }),
    [caseList, params],
  );
  const selected = picked ?? defaults;

  const choices = engineChoices(engines.data ?? []);
  const chosen = choices.filter((choice) => pickedEngines.includes(choice.key));
  const readings = variants.map(readVariant);
  const settings = readings.map((reading) => reading.parameters);
  const settingKeys = settings.map(parametersKey);
  const duplicateSettings = new Set(settingKeys).size !== settingKeys.length;
  const seeds = readSeeds(seedText);
  const caseCount = new Set(selected).size;
  const size = matrixSize({ cases: caseCount, engines: chosen.length, settings: variants.length, seeds: seeds.seeds.length });

  const ceilings = planCeilingsOf(usage.data ?? null, pricing.data ?? null, user?.plan);
  const cells = size.cells;

  const effectiveName = name;
  const effectiveAddress = address ?? slugFromName(effectiveName);

  const blockers: string[] = [];
  if (!effectiveName.trim()) blockers.push('Give the study a name.');
  else if (!SLUG_PATTERN.test(effectiveAddress)) blockers.push('Give it an address of lowercase letters, numbers and hyphens.');
  if (caseCount === 0) blockers.push('Choose at least one problem version.');
  if (chosen.length === 0) blockers.push('Choose at least one engine mode.');
  if (seeds.error) blockers.push(seeds.error);
  if (readings.some((reading) => reading.error)) blockers.push('Fix the settings marked in red.');
  if (duplicateSettings) blockers.push('Two settings are identical.');
  if (size.cells > MAX_CELLS) blockers.push(`${size.cells.toLocaleString('en-US')} cells is over the ${MAX_CELLS.toLocaleString('en-US')} limit. Remove an engine, a setting or some seeds.`);
  if (caseCount > MAX_CASES) blockers.push(`A study takes at most ${MAX_CASES} problem versions.`);
  if (chosen.length > MAX_ENGINES) blockers.push(`A study takes at most ${MAX_ENGINES} engine modes.`);
  if (variants.length > MAX_SETTINGS) blockers.push(`A study takes at most ${MAX_SETTINGS} settings.`);
  const ready = canCreate && blockers.length === 0;

  const create = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setRefusal(null);
    const head = { slug: effectiveAddress, name: effectiveName.trim(), description: description.trim() };
    try {
      const made = await platformApi.createStudy(org, {
        ...head,
        definition: {
          revision_ids: selected,
          engines: definitionEngines(chosen, studyCriteriaCount(await compiledForms(org, caseList ?? [], selected))),
          parameter_sets: settings,
          seeds: seeds.seeds,
        },
      });
      setCreated(made);
    } catch (caught) {
      setRefusal(studyRefusal(caught, 'create'));
    } finally {
      setSubmitting(false);
    }
  };

  const loading = cases.status === 'loading' && !caseList;

  return (
    <StudyFrame organization={organization} trail={[{ label: 'Studies', to: studiesPath(org) }, { label: 'New study' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>New study</h1>
          <p>Pick the problems, engines, settings and seeds. Every combination becomes one cell.</p>
        </div>
      </header>

      {!canCreate && <Notice tone="warning">Creating studies needs MEMBER; you’re a VIEWER of {organization.name}. You can look through the form, but nothing can be created.</Notice>}

      {created && (
        <section className="st-made" aria-labelledby="st-made-title">
          <div>
            <h2 id="st-made-title">Study created</h2>
            <p>Open it to run the matrix. Every run freezes the definition it runs, so it can always be traced back.</p>
          </div>
          <div className="proj-actions">
            <Action to={studyPath(org, created.slug)} variant="primary">Open the study</Action>
            <Action to={studiesPath(org)} variant="secondary">All studies</Action>
          </div>
        </section>
      )}

      {!created && loading && <div role="status" aria-busy="true"><span className="sr-only">Loading the organization’s problems…</span><Skeleton variant="panel" /></div>}

      {!created && !loading && (
        <>
          <div className="st-builder">
            <div className="st-builder-main">
              <div className="st-identity">
                <FormField label="Study name" value={effectiveName} maxLength={160} disabled={!canCreate} onChange={(event) => { setName(event.target.value); setRefusal(null); }} />
                <FormField
                  label="Address"
                  value={effectiveAddress}
                  mono
                  spellCheck={false}
                  disabled={!canCreate}
                  onChange={(event) => { setAddress(event.target.value); setRefusal(null); }}
                  error={effectiveAddress && !SLUG_PATTERN.test(effectiveAddress) ? 'Lowercase letters, numbers and hyphens.' : undefined}
                  hint="Used in the address of the study; it can’t be changed later."
                />
              </div>
              <label className="st-description">
                <span>Description <span className="proj-optional">(optional)</span></span>
                <textarea className="proj-textarea" rows={2} maxLength={2000} value={description} disabled={!canCreate} onChange={(event) => setDescription(event.target.value)} />
              </label>

              <CasesField
                cases={caseList ?? []}
                selected={selected}
                onChange={(ids) => { setPicked(ids); setRefusal(null); }}
                org={org}
              />
              <EnginesField choices={choices} selected={pickedEngines} onChange={(keys) => { setPickedEngines(keys); setRefusal(null); }} failed={engines.status === 'error'} />
              <SettingsField
                variants={variants}
                onChange={(next) => { setVariants(next); setRefusal(null); }}
                seeds={seedText}
                onSeeds={(text) => { setSeedText(text); setRefusal(null); }}
                seedsError={seeds.error}
                seedCount={seeds.seeds.length}
                ceiling={ceilings.seconds}
                duplicate={duplicateSettings}
                onAdd={() => { setVariants([...variants, emptyVariant(`v${serial + 1}`)]); setSerial(serial + 1); }}
              />
            </div>

            <aside className="st-builder-aside" aria-label="Matrix and plan" aria-live="polite">
              <section className="st-matrix">
                <span className="st-eyebrow">4 · Matrix</span>
                <span className="st-cells"><b>{cells.toLocaleString('en-US')}</b> cells</span>
                <span className="st-formula">{formulaOf(size)}</span>
                <span className="st-squares" aria-hidden="true">
                  {Array.from({ length: Math.min(cells, 48) }, (_, position) => <i key={position} />)}
                </span>
                <span className="st-cap" aria-hidden="true"><i className={cells > MAX_CELLS ? 'is-over' : undefined} style={{ width: `${Math.min(100, Math.max(cells > 0 ? 1 : 0, Math.round((cells / MAX_CELLS) * 100)))}%` }} /></span>
                <small className="org-muted">Up to {MAX_CELLS.toLocaleString('en-US')} cells, {MAX_CASES} problem versions, {MAX_ENGINES} engine modes and {MAX_SETTINGS} settings per study</small>
              </section>
              <section className="st-plan" aria-label="How a run proceeds">
                <p className="st-plan-note">
                  Cells start as run slots free up{ceilings.seconds !== null ? `; your plan lets one solve run for up to ${ceilings.seconds} s` : ''}.
                </p>
              </section>
              {refusal && <RefusalNotice refusal={refusal} usageTo />}
              {!refusal && blockers.length > 0 && canCreate && (
                <ul className="st-blockers" aria-label="Still needed">
                  {blockers.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
              <Action variant="primary" busy={submitting} disabled={!ready} onClick={() => void create()}>
                Create study
              </Action>
            </aside>
          </div>
        </>
      )}
    </StudyFrame>
  );
}

/** The compiled forms of the chosen problem versions (the IR of each one's current compilation); a version that can't be read is left out. */
async function compiledForms(org: string, cases: readonly CaseContent[], ids: readonly string[]): Promise<unknown[]> {
  const chosen = revisionsOf(cases, ids);
  const slugOf = new Map(cases.flatMap((entry) => entry.revisions.map((revision) => [revision.id, entry.item.slug] as const)));
  const forms = await Promise.all(chosen.map(async (revision) => {
    const problem = slugOf.get(revision.id);
    if (!problem) return null;
    try {
      const compilation = await problemsApi.compilation(org, problem, revision.revision);
      return (await problemsApi.ir(org, problem, revision.revision, compilation.id)).ir;
    } catch {
      return null;
    }
  }));
  return forms.filter((form) => form !== null);
}

/** A new study (`study-builder`, `/app/:org/studies/new`): the problem versions, engines, settings and seeds that become one cell each. */
export function StudyBuilder() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} subject="organization" />;
  return <BuilderBody key={organization.slug} organization={organization} canCreate={problemAccess(organization).canCreate} />;
}
