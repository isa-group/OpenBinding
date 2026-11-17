// Adapted from SPHERE frontend/src/modules/profile/components/create-collection-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a study instead of a collection. SPHERE's head is kept (the back link to the organization, the title, the
// organization selector beside the name, the slug preview, the description), then the problem versions as selectable cards
// (SPHERE's pricings selector), the engines and run presets, the settings and seeds, and a live "N cells" tile beside them.
// The organization is one where the account is MEMBER (OpenBinding's roles), preselected by `?org=`; `?problem=&revision=`
// select a version and `?engine=` an engine. The matrix rules, the optimization each engine carries and the refusals are
// OpenBinding's; the upload tab and visibility are not brought (a study is built from the organization's problems and is
// never public). It lands on the new study.

import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { UsageView } from '../../../../api/auth';
import { apiClient, type EngineCatalogEntry } from '../../../../api/client';
import { problemsApi } from '../../../../api/problems';
import { loadProblems } from '../../../problem/api/loadProblems';
import { planCeilingsOf } from '../../../run/api/runModel';
import { useResource } from '../../../../utils/useResource';
import type { RunPresetList } from '../../../core/api/types';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import SlugPreview from '../../../core/components/slug-preview';
import { SLUG_PATTERN, slugFromName } from '../../../core/utils/slug';
import { useAuth } from '../../../auth/hooks/useAuth';
import type { Organization } from '../../../organization/api/organizationsApi';
import OrganizationSelector from '../../../organization/components/organization-selector';
import { orgPath } from '../../../organization/types/paths';
import { PRESET_PAGE, presetsApi } from '../../../run/api/presetsApi';
import { studyPresetRefusal } from '../../../run/api/presetText';
import { studyPath } from '../../../../routes/paths/studies';
import { studiesApi } from '../../api/studiesApi';
import {
  MAX_CASES,
  MAX_CELLS,
  MAX_ENGINES,
  MAX_SETTINGS,
  defaultSelection,
  definitionEngines,
  emptyVariant,
  engineChoices,
  formulaOf,
  matrixSize,
  parametersKey,
  readSeeds,
  readVariant,
  revisionsOf,
  studyCriteriaCount,
  type CaseContent,
  type Variant,
} from '../../utils/studiesModel';
import { studyRefusal, type Refusal } from '../../utils/studyErrors';
import { INPUT } from '../../utils/ui';
import { CasesField, EnginesField, SettingsField } from '../builder-fields';
import { StudyRefusal } from '../study-refusal';

/** The fields of the form below the organization: they belong to it, so another organization starts them afresh. */
function BuilderBody({ organization }: { organization: Organization }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const org = organization.slug;

  const cases = useResource<CaseContent[]>(`builder-problems:${org}`, () => loadProblems(org));
  const engines = useResource<EngineCatalogEntry[]>('builder-engines', () =>
    apiClient.getEngines()
  );
  const usage = useResource<UsageView | null>('builder-usage', () =>
    apiClient.getOwnUsage().catch(() => null)
  );
  const pricing = useResource<Record<string, unknown> | null>('builder-pricing', () =>
    apiClient.getPricingCatalog().catch(() => null)
  );
  const presets = useResource<RunPresetList | null>(`builder-presets:${org}`, () =>
    presetsApi.list(org, { limit: PRESET_PAGE }).catch(() => null)
  );

  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedEngines, setPickedEngines] = useState<string[] | null>(null);
  const [pickedPresets, setPickedPresets] = useState<string[]>([]);
  const [variants, setVariants] = useState<Variant[]>([emptyVariant('v1')]);
  const [serial, setSerial] = useState(1);
  const [seedText, setSeedText] = useState('1, 2');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const caseList = cases.data ?? cases.stale;
  const defaults = useMemo(
    () =>
      defaultSelection({
        cases: caseList ?? [],
        caseSlug: params.get('problem'),
        revision: params.get('revision'),
      }),
    [caseList, params]
  );
  const selected = picked ?? defaults;

  const choices = engineChoices(engines.data ?? []);
  // `?engine=namespace/name` chooses the first mode of that engine until the person chooses otherwise.
  const wanted = params.get('engine');
  const engineDefaults = wanted
    ? choices
        .filter(choice => `${choice.ref.namespace}/${choice.ref.name}` === wanted)
        .slice(0, 1)
        .map(choice => choice.key)
    : [];
  const engineKeys = pickedEngines ?? engineDefaults;
  const chosen = choices.filter(choice => engineKeys.includes(choice.key));
  // The organization's run presets: `[]` while they load, `null` when they can't be read. Only one a study can take stays chosen.
  const presetList = presets.data === undefined ? [] : (presets.data?.presets ?? null);
  const chosenPresets = (presetList ?? [])
    .filter(preset => pickedPresets.includes(preset.slug) && studyPresetRefusal(preset) === null)
    .map(preset => preset.slug);
  const engineCount = chosen.length + chosenPresets.length;
  const readings = variants.map(readVariant);
  const settings = readings.map(reading => reading.parameters);
  const settingKeys = settings.map(parametersKey);
  const duplicateSettings = new Set(settingKeys).size !== settingKeys.length;
  const seeds = readSeeds(seedText);
  const caseCount = new Set(selected).size;
  const size = matrixSize({
    cases: caseCount,
    engines: engineCount,
    settings: variants.length,
    seeds: seeds.seeds.length,
  });

  const ceilings = planCeilingsOf(usage.data ?? null, pricing.data ?? null, user?.plan);
  const cells = size.cells;
  const effectiveAddress = address ?? slugFromName(name);

  const blockers: string[] = [];
  if (!name.trim()) blockers.push('Give the study a name.');
  else if (!SLUG_PATTERN.test(effectiveAddress))
    blockers.push('Give it an address of lowercase letters, numbers and hyphens.');
  if (caseCount === 0) blockers.push('Choose at least one problem version.');
  if (engineCount === 0) blockers.push('Choose at least one engine mode or run preset.');
  if (seeds.error) blockers.push(seeds.error);
  if (readings.some(reading => reading.error)) blockers.push('Fix the settings marked in red.');
  if (duplicateSettings) blockers.push('Two settings are identical.');
  if (size.cells > MAX_CELLS)
    blockers.push(
      `${size.cells.toLocaleString('en-US')} cells is over the ${MAX_CELLS.toLocaleString('en-US')} limit. Remove an engine, a setting or some seeds.`
    );
  if (caseCount > MAX_CASES) blockers.push(`A study takes at most ${MAX_CASES} problem versions.`);
  if (engineCount > MAX_ENGINES)
    blockers.push(`A study takes at most ${MAX_ENGINES} engine modes and run presets.`);
  if (variants.length > MAX_SETTINGS)
    blockers.push(`A study takes at most ${MAX_SETTINGS} settings.`);
  const ready = blockers.length === 0;

  const create = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setRefusal(null);
    try {
      const made = await studiesApi.create(org, {
        slug: effectiveAddress,
        name: name.trim(),
        description: description.trim(),
        definition: {
          revision_ids: selected,
          engines: definitionEngines(
            chosen,
            studyCriteriaCount(await compiledForms(org, caseList ?? [], selected)),
            chosenPresets
          ),
          parameter_sets: settings,
          seeds: seeds.seeds,
        },
      });
      void navigate(studyPath(org, made.slug, 'setup'), {
        state: {
          toast: `Study “${made.name}” created. Run it from here: every run freezes the definition it runs.`,
        },
      });
    } catch (caught) {
      setRefusal(studyRefusal(caught, 'create'));
      setSubmitting(false);
    }
  };

  if (cases.status === 'loading' && !caseList) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the organization’s problems…</span>
        <Skeleton variant="panel" />
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-2">
          <label htmlFor="study-name" className="mb-1 block text-sm text-tp-slate">
            Study name
          </label>
          <input
            id="study-name"
            placeholder="e.g. Engines × seeds"
            value={name}
            maxLength={160}
            onChange={event => {
              setName(event.target.value);
              setRefusal(null);
            }}
            className={INPUT}
          />
          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${name.trim() && address === null ? 'max-h-8 opacity-100' : 'max-h-0 opacity-0'}`}
          >
            <SlugPreview value={name} />
          </div>
        </div>
        <div className="flex-1">
          <label htmlFor="study-address" className="mb-1 block text-sm text-tp-slate">
            Address
          </label>
          <input
            id="study-address"
            value={effectiveAddress}
            spellCheck={false}
            onChange={event => {
              setAddress(event.target.value);
              setRefusal(null);
            }}
            aria-invalid={
              effectiveAddress && !SLUG_PATTERN.test(effectiveAddress) ? true : undefined
            }
            aria-describedby="study-address-hint"
            className={`${INPUT} font-mono`}
          />
          <p
            id="study-address-hint"
            className={`mt-1 text-xs ${effectiveAddress && !SLUG_PATTERN.test(effectiveAddress) ? 'text-red-700' : 'text-tp-steel'}`}
          >
            {effectiveAddress && !SLUG_PATTERN.test(effectiveAddress)
              ? 'Lowercase letters, numbers and hyphens.'
              : 'Used in the address of the study; it can’t be changed later.'}
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="study-description" className="mb-1 block text-sm text-tp-slate">
          Description <span className="text-tp-steel">(optional)</span>
        </label>
        <textarea
          id="study-description"
          rows={2}
          maxLength={2000}
          value={description}
          onChange={event => setDescription(event.target.value)}
          className={INPUT}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="flex min-w-0 flex-col gap-4">
          <CasesField
            cases={caseList ?? []}
            selected={selected}
            onChange={ids => {
              setPicked(ids);
              setRefusal(null);
            }}
            org={org}
          />
          <EnginesField
            choices={choices}
            selected={engineKeys}
            onChange={keys => {
              setPickedEngines(keys);
              setRefusal(null);
            }}
            failed={engines.status === 'error'}
            presets={{
              presets: presetList,
              selected: chosenPresets,
              manageHref: orgPath(org, 'presets'),
              onChange: slugs => {
                setPickedPresets(slugs);
                setRefusal(null);
              },
            }}
          />
          <SettingsField
            variants={variants}
            onChange={next => {
              setVariants(next);
              setRefusal(null);
            }}
            seeds={seedText}
            onSeeds={text => {
              setSeedText(text);
              setRefusal(null);
            }}
            seedsError={seeds.error}
            seedCount={seeds.seeds.length}
            ceiling={ceilings.seconds}
            duplicate={duplicateSettings}
            onAdd={() => {
              setVariants([...variants, emptyVariant(`v${serial + 1}`)]);
              setSerial(serial + 1);
            }}
          />
        </div>

        <aside
          className="flex flex-col gap-3 lg:sticky lg:top-20 lg:self-start"
          aria-label="Matrix and plan"
          aria-live="polite"
        >
          <section className="flex flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-4">
            <span className="text-[11px] text-tp-steel">4 · Matrix</span>
            <span className="text-tp-ink">
              <b className="text-2xl font-semibold">{cells.toLocaleString('en-US')}</b> cells
            </span>
            <span className="text-xs text-tp-slate">{formulaOf(size)}</span>
            <span className="flex flex-wrap gap-1" aria-hidden="true">
              {Array.from({ length: Math.min(cells, 48) }, (_, position) => (
                <i key={position} className="h-2.5 w-2.5 rounded-sm bg-tp-primary/70" />
              ))}
            </span>
            <span
              className="h-1.5 overflow-hidden rounded-full bg-tp-hairline-soft"
              aria-hidden="true"
            >
              <i
                className={`block h-full rounded-full ${cells > MAX_CELLS ? 'bg-tp-severity-error' : 'bg-tp-accent'}`}
                style={{
                  width: `${Math.min(100, Math.max(cells > 0 ? 1 : 0, Math.round((cells / MAX_CELLS) * 100)))}%`,
                }}
              />
            </span>
            <small className="text-[11px] text-tp-steel">
              Up to {MAX_CELLS.toLocaleString('en-US')} cells, {MAX_CASES} problem versions,{' '}
              {MAX_ENGINES} engine modes and {MAX_SETTINGS} settings per study
            </small>
          </section>
          <p className="text-xs text-tp-steel">
            Cells start as run slots free up
            {ceilings.seconds !== null
              ? `; your plan lets one solve run for up to ${ceilings.seconds} s`
              : ''}
            .
          </p>
          {refusal && <StudyRefusal refusal={refusal} usageTo />}
          {!refusal && blockers.length > 0 && (
            <ul
              className="list-disc space-y-1 pl-5 text-xs text-tp-slate"
              aria-label="Still needed"
            >
              {blockers.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <Action
            variant="primary"
            busy={submitting}
            disabled={!ready}
            onClick={() => void create()}
          >
            Create study
          </Action>
        </aside>
      </div>
    </>
  );
}

/** The compiled forms of the chosen problem versions (the IR of each one's current compilation); a version that can't be read is left out. */
async function compiledForms(
  org: string,
  cases: readonly CaseContent[],
  ids: readonly string[]
): Promise<unknown[]> {
  const chosen = revisionsOf(cases, ids);
  const slugOf = new Map(
    cases.flatMap(entry => entry.revisions.map(revision => [revision.id, entry.item.slug] as const))
  );
  const forms = await Promise.all(
    chosen.map(async revision => {
      const problem = slugOf.get(revision.id);
      if (!problem) return null;
      try {
        const compilation = await problemsApi.compilation(org, problem, revision.revision);
        return (await problemsApi.ir(org, problem, revision.revision, compilation.id)).ir;
      } catch {
        return null;
      }
    })
  );
  return forms.filter(form => form !== null);
}

/** The form of `/studies/new`: the organization first, then the problem versions, engines, settings and seeds. */
export default function CreateStudyForm() {
  const [searchParams] = useSearchParams();
  const initialOrg = searchParams.get('org');
  const [organization, setOrganization] = useState<Organization | null>(null);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => event.preventDefault()}
      noValidate
      aria-label="New study"
    >
      {initialOrg && (
        <Link
          to={orgPath(initialOrg, 'studies')}
          className="mb-2 inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm text-tp-steel transition-colors hover:text-tp-ink"
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
          Back to organization
        </Link>
      )}

      <h1 className="mb-1 text-center font-display text-2xl text-tp-ink">New study</h1>
      <p className="mb-3 text-center text-sm text-tp-steel">
        Pick the problems, engines, settings and seeds. Every combination becomes one cell.
      </p>

      <OrganizationSelector
        value={organization}
        onChange={setOrganization}
        initialSlug={initialOrg}
        minRole="MEMBER"
      />

      {organization ? (
        <BuilderBody key={organization.slug} organization={organization} />
      ) : (
        <Notice tone="info">
          Choose the organization the study belongs to: its problems are the ones a study can run.
          Creating a study needs MEMBER there.
        </Notice>
      )}
      <div className="h-12" />
    </form>
  );
}
