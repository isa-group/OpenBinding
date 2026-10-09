import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { UsageView } from '../../api/auth';
import { apiClient, type EngineCatalogEntry } from '../../api/client';
import { libraryApi, type Artifact, type ArtifactVersion } from '../../api/library';
import { platformApi, type Organization, type Project, type Study } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { ForecastBars } from '../Jobs/LaunchSteps';
import { forecastBar, type ForecastBar } from '../Jobs/jobsModel';
import { planCeilingsOf } from '../Jobs/launchModel';
import { RefusalNotice } from '../Jobs/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { loadCases } from '../Project/projectData';
import { SLUG_PATTERN, slugFromName, type CaseContent } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { AdoptPanel, CasesField, EnginesField, SettingsField } from './BuilderFields';
import { StudyFrame } from './parts';
import {
  MAX_CASES, MAX_CELLS, MAX_ENGINES, MAX_SETTINGS, collectionMembers, defaultSelection, emptyVariant, engineChoices, formulaOf,
  matrixSize, parametersKey, plural, readSeeds, readVariant, solverEstimate, studyContentSize, type Variant,
} from './studiesModel';
import { studyRefusal, type Refusal } from './studyErrors';

type Mode = 'new' | 'adopt';

interface PinnedCollection {
  name: string;
  ids: string[];
}

const usedOf = (usage: UsageView | null | undefined, id: string): { used: number | null; limit: number | null } => {
  const entry = usage?.limits?.[id];
  return entry ? { used: entry.used, limit: entry.limit } : { used: usage ? 0 : null, limit: null };
};

/** What one run of this study adds to the sponsor's and the account's allowances. */
function forecastFor(input: { usage: UsageView | null; cells: number; seconds: number | null; secondsComplete: boolean; sponsor: boolean }): ForecastBar[] {
  const runs = usedOf(input.usage, 'studyRuns');
  const solves = usedOf(input.usage, 'taskStarts');
  const time = usedOf(input.usage, 'solverSeconds');
  const studies = usedOf(input.usage, 'studies');
  const bars: ForecastBar[] = [];
  if (input.sponsor) bars.push(forecastBar('Study definitions of the sponsor', studies.used, studies.limit, 1, ''));
  bars.push(forecastBar('Study runs this month', runs.used, runs.limit, 1, ''));
  bars.push(forecastBar('Solves this month, once run', solves.used, solves.limit, input.cells, ''));
  if (input.seconds !== null) {
    const timeBar = forecastBar('Solver time this month, once run', time.used, time.limit, Math.round(input.seconds), ' s');
    bars.push(input.secondsComplete ? timeBar : { ...timeBar, text: `${timeBar.text} · some engines name no budget, so this is a lower bound` });
  }
  return bars;
}

function BuilderBody({ organization, project, canCreate }: { organization: Organization; project: Project; canCreate: boolean }) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;
  const wantedCollection = params.get('collection');

  const cases = useResource<CaseContent[]>(`builder-cases:${org}/${slug}`, () => loadCases(org, slug));
  const engines = useResource<EngineCatalogEntry[]>('builder-engines', () => apiClient.getEngines());
  const usage = useResource<UsageView | null>('builder-usage', () => apiClient.getOwnUsage().catch(() => null));
  const pricing = useResource<Record<string, unknown> | null>('builder-pricing', () => apiClient.getPricingCatalog().catch(() => null));
  const library = useResource<Artifact[]>(`builder-library:${org}`, () => libraryApi.list(org, true).catch(() => []));
  const pinned = useResource<PinnedCollection | null>(`builder-pinned:${org}/${slug}/${wantedCollection ?? ''}`, async () => {
    if (!wantedCollection) return null;
    try {
      const [collection, revisions] = await Promise.all([
        platformApi.collection(org, slug, wantedCollection),
        platformApi.collectionRevisions(org, slug, wantedCollection),
      ]);
      const latest = revisions.reduce<(typeof revisions)[number] | undefined>((best, item) => (!best || item.revision > best.revision ? item : best), undefined);
      const ids = (latest?.items ?? []).flatMap((item) => (item.target_kind === 'case' && typeof item.target_ref.caseRevisionId === 'string' ? [item.target_ref.caseRevisionId] : []));
      return { name: collection.name, ids };
    } catch {
      return null;
    }
  });

  const [mode, setMode] = useState<Mode>('new');
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedEngines, setPickedEngines] = useState<string[]>([]);
  const [variants, setVariants] = useState<Variant[]>([emptyVariant('v1')]);
  const [serial, setSerial] = useState(1);
  const [seedText, setSeedText] = useState('1, 2');
  const [collectionArtifact, setCollectionArtifact] = useState('');
  const [collectionVersion, setCollectionVersion] = useState('');
  const [adoptArtifact, setAdoptArtifact] = useState('');
  const [adoptVersion, setAdoptVersion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [created, setCreated] = useState<Study | null>(null);

  const caseList = cases.data ?? cases.stale;
  const defaults = useMemo(
    () => defaultSelection({ cases: caseList ?? [], caseSlug: params.get('case'), revision: params.get('revision'), collectionIds: pinned.data?.ids ?? [] }),
    [caseList, params, pinned.data],
  );
  const selected = picked ?? defaults;

  const artifacts = library.data ?? [];
  const collections = artifacts.filter((item) => item.kind === 'Collection' && !item.archived);
  const studyArtifacts = artifacts.filter((item) => item.kind === 'Study' && !item.archived);
  const collectionVersions = useResource<ArtifactVersion[]>(`builder-coll-versions:${collectionArtifact}`, () => (collectionArtifact ? libraryApi.versions(collectionArtifact).catch(() => []) : Promise.resolve([])));
  const adoptVersions = useResource<ArtifactVersion[]>(`builder-adopt-versions:${adoptArtifact}`, () => (adoptArtifact ? libraryApi.versions(adoptArtifact).catch(() => []) : Promise.resolve([])));
  const members = useResource<string[] | null>(`builder-coll-members:${collectionArtifact}/${collectionVersion}`, () => (
    collectionArtifact && collectionVersion ? libraryApi.content(collectionArtifact, collectionVersion).then(collectionMembers, () => null) : Promise.resolve(null)
  ));
  const adoptContent = useResource<ReturnType<typeof studyContentSize>>(`builder-adopt-size:${adoptArtifact}/${adoptVersion}`, () => (
    adoptArtifact && adoptVersion ? libraryApi.content(adoptArtifact, adoptVersion).then(studyContentSize, () => null) : Promise.resolve(null)
  ));

  const choices = engineChoices(engines.data ?? []);
  const chosen = choices.filter((choice) => pickedEngines.includes(choice.key));
  const readings = variants.map(readVariant);
  const settings = readings.map((reading) => reading.parameters);
  const settingKeys = settings.map(parametersKey);
  const duplicateSettings = new Set(settingKeys).size !== settingKeys.length;
  const seeds = readSeeds(seedText);
  const joined = collectionVersion && members.data ? members.data : [];
  const caseCount = new Set([...selected, ...joined]).size;
  const size = matrixSize({ cases: caseCount, engines: chosen.length, settings: variants.length, seeds: seeds.seeds.length });
  const adoptedSize = adoptContent.data ?? null;

  const ceilings = planCeilingsOf(usage.data ?? null, pricing.data ?? null, user?.plan);
  const estimate = solverEstimate({ cases: caseCount, seeds: seeds.seeds.length, engines: chosen, settings, ceiling: ceilings.seconds });
  const sponsor = organization.billing_sponsor_user_id === user?.id;
  const cells = mode === 'adopt' ? adoptedSize?.cells ?? 0 : size.cells;
  const bars = forecastFor({ usage: usage.data ?? null, cells, seconds: mode === 'adopt' ? null : estimate.seconds, secondsComplete: estimate.complete, sponsor });
  const left = usage.data?.limits?.studyRuns?.remaining;

  const effectiveName = name || (mode === 'adopt' ? studyArtifacts.find((item) => item.id === adoptArtifact)?.display_name ?? '' : '');
  const effectiveAddress = address ?? slugFromName(effectiveName);

  const blockers: string[] = [];
  if (!effectiveName.trim()) blockers.push('Give the study a name.');
  else if (!SLUG_PATTERN.test(effectiveAddress)) blockers.push('Give it an address of lowercase letters, numbers and hyphens.');
  if (mode === 'new') {
    if (caseCount === 0) blockers.push('Choose at least one case revision, or a sealed collection.');
    if (chosen.length === 0) blockers.push('Choose at least one engine mode.');
    if (seeds.error) blockers.push(seeds.error);
    if (readings.some((reading) => reading.error)) blockers.push('Fix the settings marked in red.');
    if (duplicateSettings) blockers.push('Two settings are identical.');
    if (size.cells > MAX_CELLS) blockers.push(`${size.cells.toLocaleString('en-US')} cells is over the ${MAX_CELLS.toLocaleString('en-US')} limit. Remove an engine, a setting or some seeds.`);
    if (caseCount > MAX_CASES) blockers.push(`A study takes at most ${MAX_CASES} case revisions.`);
    if (chosen.length > MAX_ENGINES) blockers.push(`A study takes at most ${MAX_ENGINES} engine modes.`);
    if (variants.length > MAX_SETTINGS) blockers.push(`A study takes at most ${MAX_SETTINGS} settings.`);
  } else if (!adoptVersion) {
    blockers.push('Choose the sealed version to reuse.');
  }
  const ready = canCreate && blockers.length === 0;

  const create = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setRefusal(null);
    const head = { slug: effectiveAddress, name: effectiveName.trim(), description: description.trim() };
    try {
      const made = mode === 'adopt'
        ? await platformApi.createStudy(org, slug, { ...head, definition_version_id: adoptVersion })
        : await platformApi.createStudy(org, slug, {
          ...head,
          definition: {
            case_revision_ids: selected,
            ...(collectionVersion ? { collection_version_id: collectionVersion } : {}),
            engines: chosen.map((choice) => ({ ...choice.ref, mode: choice.mode })),
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
  const collectionNote = !collectionVersion ? null
    : members.status === 'loading' ? 'Reading the collection…'
      : members.data ? `${plural(members.data.length, 'case revision')} join the study from this collection.`
        : 'Its cases are counted by the gateway when the study is created.';

  return (
    <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies', to: `${root}/studies` }, { label: 'New study' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>New study</h1>
          <p>Pick the cases, engines, settings and seeds. Every combination becomes one cell.</p>
        </div>
      </header>

      {!canCreate && <Notice tone="warning">Creating studies needs MEMBER; you’re a VIEWER of {organization.name}. You can look through the form, but nothing can be created.</Notice>}

      {created && (
        <section className="st-made" aria-labelledby="st-made-title">
          <div>
            <h2 id="st-made-title">Study created</h2>
            <p>Its definition was sealed as a library version, so runs can always be traced to it. Open it to run the matrix.</p>
          </div>
          <div className="proj-actions">
            <Action to={`${root}/studies/${encodeURIComponent(created.slug)}`} variant="primary">Open the study</Action>
            <Action to={`${root}/studies`} variant="secondary">All studies</Action>
          </div>
        </section>
      )}

      {!created && loading && <div role="status" aria-busy="true"><span className="sr-only">Loading the project’s cases…</span><Skeleton variant="panel" /></div>}

      {!created && !loading && (
        <>
          <fieldset className="proj-seg" aria-label="Start from" disabled={!canCreate}>
            <label className={mode === 'new' ? 'is-checked' : ''}>
              <input type="radio" name="study-start" checked={mode === 'new'} onChange={() => { setMode('new'); setRefusal(null); }} />Define a new matrix
            </label>
            <label className={mode === 'adopt' ? 'is-checked' : ''}>
              <input type="radio" name="study-start" checked={mode === 'adopt'} onChange={() => { setMode('adopt'); setRefusal(null); }} />Reuse a shared definition
            </label>
          </fieldset>

          {pinned.data && (
            <Notice tone="info">The cases of the collection {pinned.data.name} are chosen below. Add engines, settings and seeds to finish the matrix.</Notice>
          )}
          {wantedCollection && pinned.status === 'ready' && !pinned.data && (
            <Notice tone="warning">The collection “{wantedCollection}” couldn’t be read, so no cases were chosen for you.</Notice>
          )}

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

              {mode === 'new' ? (
                <>
                  <CasesField
                    cases={caseList ?? []}
                    selected={selected}
                    onChange={(ids) => { setPicked(ids); setRefusal(null); }}
                    root={root}
                    collections={collections}
                    collectionArtifact={collectionArtifact}
                    onCollectionArtifact={(id) => { setCollectionArtifact(id); setCollectionVersion(''); }}
                    collectionVersions={(collectionVersions.data ?? collectionVersions.stale ?? []).filter((item) => !item.withdrawn)}
                    collectionVersion={collectionVersion}
                    onCollectionVersion={setCollectionVersion}
                    collectionNote={collectionNote}
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
                </>
              ) : (
                <AdoptPanel
                  studies={studyArtifacts}
                  artifact={adoptArtifact}
                  onArtifact={(id) => { setAdoptArtifact(id); setAdoptVersion(''); setRefusal(null); }}
                  versions={(adoptVersions.data ?? adoptVersions.stale ?? []).filter((item) => !item.withdrawn)}
                  version={adoptVersion}
                  onVersion={(id) => { setAdoptVersion(id); setRefusal(null); }}
                  size={adoptedSize}
                  loading={adoptContent.status === 'loading'}
                />
              )}
            </div>

            <aside className="st-builder-aside" aria-label="Matrix and plan" aria-live="polite">
              <section className="st-matrix">
                <span className="st-eyebrow">4 · Matrix</span>
                <span className="st-cells"><b>{cells.toLocaleString('en-US')}</b> cells</span>
                <span className="st-formula">{mode === 'new' ? formulaOf(size) : adoptedSize ? formulaOf(adoptedSize) : 'The size of the shared definition is read from the library.'}</span>
                <span className="st-squares" aria-hidden="true">
                  {Array.from({ length: Math.min(cells, 48) }, (_, position) => <i key={position} />)}
                </span>
                <span className="st-cap" aria-hidden="true"><i className={cells > MAX_CELLS ? 'is-over' : undefined} style={{ width: `${Math.min(100, Math.max(cells > 0 ? 1 : 0, Math.round((cells / MAX_CELLS) * 100)))}%` }} /></span>
                <small className="org-muted">Up to {MAX_CELLS.toLocaleString('en-US')} cells, {MAX_CASES} case revisions, {MAX_ENGINES} engine modes and {MAX_SETTINGS} settings per study</small>
              </section>
              <section className="st-plan" aria-label="What a run uses">
                <ForecastBars bars={bars} />
                <p className="st-plan-note">
                  Each run uses 1 of your study runs this month{typeof left === 'number' ? ` (${left.toLocaleString('en-US')} left)` : ''}.
                  {' '}Cells start as job slots free up{ceilings.seconds !== null ? `; your plan lets one solve run for up to ${ceilings.seconds} s` : ''}.
                </p>
              </section>
              {refusal && <RefusalNotice refusal={refusal} usageTo />}
              {!refusal && blockers.length > 0 && canCreate && (
                <ul className="st-blockers" aria-label="Still needed">
                  {blockers.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
              <Action variant="primary" busy={submitting} disabled={!ready} onClick={() => void create()}>
                {mode === 'adopt' ? 'Create from this definition' : 'Create study'}
              </Action>
            </aside>
          </div>
        </>
      )}
    </StudyFrame>
  );
}

/** A new study (`study-builder`, `/app/:org/:project/studies/new`): the cases, engines, settings and seeds that become one cell each. */
export function StudyBuilder() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <BuilderBody key={`${organization.slug}/${project.slug}`} organization={organization} project={project} canCreate={access.canCreate} />;
}
