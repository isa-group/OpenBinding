import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { casesApi } from '../../api/cases';
import { apiClient } from '../../api/client';
import { libraryApi, type Artifact, type ArtifactRef, type ArtifactUse, type ArtifactVersion } from '../../api/library';
import type { CaseRevision, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { MembersOnlyGate, ProjectGate, ProjectSkeleton } from '../Project/parts';
import { planLimit } from '../Project/projectModel';
import { classifyAuthError, composeRefusal, isMissing, marker, resolveRefusal, type Issue } from './caseErrors';
import {
  ALIAS_PATTERN, aliasFrom, newestFirst, refLabel, resourceUses, ROLES, type RoleDef, type RoleKey,
} from './casesModel';
import { estimateComposition } from './compositionModel';
import { CaseFrame, CaseMissing, Power, ReadOnlyNote, SizeMeter } from './parts';
import { useLoadedMap } from './useLoadedMap';
import { useRouteCase, type RouteCaseContent } from './useRouteCase';

/** One library version picked (or about to be) for one part of the composition. */
interface Slot {
  id: string;
  role: RoleKey;
  artifactId: string;
  versionId: string;
  ref?: ArtifactRef;
  alias: string;
  /** The revision this version was taken from, when it was. */
  origin?: number;
}

interface Start {
  slots: Slot[];
  /** Library items the start came from that the library list doesn't hold (public, from another organization…). */
  extras: Array<{ id: string; label: string }>;
  issues: Issue[];
  revision: number | null;
}

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'done'; issues: Issue[] };

interface Made {
  revision: CaseRevision;
  /** The same inputs were sealed before: nothing new exists. */
  existing: boolean;
  /** The gateway says the revision is bigger than the plan allows to run (402). */
  tooBig: boolean;
}

const ROLE_KEYS = new Set<string>(ROLES.map((role) => role.key));

/** Every part always shows at least one row, empty when nothing is picked. */
function withRows(slots: Slot[]): Slot[] {
  const rows = [...slots];
  for (const role of ROLES) {
    if (!rows.some((slot) => slot.role === role.key)) rows.push({ id: `empty:${role.key}`, role: role.key, artifactId: '', versionId: '', alias: '' });
  }
  return ROLES.flatMap((role) => rows.filter((slot) => slot.role === role.key));
}

/** The exact library versions a revision names, looked up one by one with POST /v1/artifacts/resolve. */
async function startFrom(revision: CaseRevision | undefined): Promise<Start> {
  if (!revision) return { slots: [], extras: [], issues: [], revision: null };
  const uses = resourceUses(revision.document).filter((use) => ROLE_KEYS.has(use.role));
  const answers = await Promise.allSettled(uses.map((use) => casesApi.resolveVersion(use.ref)));
  const slots: Slot[] = [];
  const extras: Start['extras'] = [];
  const issues: Issue[] = [];
  answers.forEach((answer, index) => {
    const use = uses[index];
    if (answer.status === 'rejected') {
      issues.push(resolveRefusal(answer.reason, refLabel(use.ref)));
      return;
    }
    const version: ArtifactVersion = answer.value;
    slots.push({ id: `${use.role}/${use.alias}`, role: use.role as RoleKey, artifactId: version.artifact_id, versionId: version.id, ref: version.ref, alias: use.alias, origin: revision.revision });
    extras.push({ id: version.artifact_id, label: `${version.ref.name} (${version.ref.namespace})` });
  });
  return { slots, extras, issues, revision: revision.revision };
}

const artifactLabel = (artifact: Artifact) => (artifact.display_name && artifact.display_name !== artifact.name ? `${artifact.display_name} · ${artifact.name}` : artifact.name);

function RoleSection({ role, rows, artifacts, versions, drafts, readOnly, onPickArtifact, onPickVersion, onAlias, onRemove, onAdd, invalid }: {
  role: RoleDef;
  rows: Slot[];
  artifacts: Array<{ id: string; label: string }>;
  versions: Record<string, { status: string; value?: ArtifactVersion[] }>;
  drafts: Record<string, { status: string; value?: Array<{ id: string; revision: number }> }>;
  readOnly: boolean;
  onPickArtifact: (slot: Slot, artifactId: string) => void;
  onPickVersion: (slot: Slot, versionId: string) => void;
  onAlias: (slot: Slot, alias: string) => void;
  onRemove: (slot: Slot) => void;
  onAdd: () => void;
  invalid: boolean;
}) {
  const headingId = `role-title-${role.key}`;
  return (
    <section id={`role-${role.key}`} aria-labelledby={headingId} className={`case-role${invalid ? ' is-invalid' : ''}`}>
      <div className="case-role-head">
        <span className="case-role-n" aria-hidden="true">{role.number}</span>
        <h2 id={headingId}>{role.label}</h2>
        <span className={`case-req${role.required ? ' is-required' : ''}`}>{role.requirement}</span>
        <span className="case-role-help">{role.help}</span>
      </div>
      {rows.map((slot, index) => {
        const list = versions[slot.artifactId];
        const loadedVersions = list?.status === 'ready' ? list.value ?? [] : [];
        const loadedDrafts = drafts[slot.artifactId]?.status === 'ready' ? drafts[slot.artifactId].value ?? [] : [];
        const label = `${role.label}${rows.length > 1 ? ` ${index + 1}` : ''}`;
        return (
          <div className="case-slot" key={slot.id}>
            <div className="case-slot-fields">
              <label className="case-field">
                <span>Library item</span>
                <select aria-label={`${label}: library item`} value={slot.artifactId} disabled={readOnly} onChange={(event) => onPickArtifact(slot, event.target.value)}>
                  <option value="">Choose an item…</option>
                  {artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.label}</option>)}
                </select>
              </label>
              <label className="case-field">
                <span>Version</span>
                <select
                  aria-label={`${label}: version`}
                  value={slot.versionId}
                  disabled={readOnly || !slot.artifactId || list?.status === 'loading' || list === undefined}
                  onChange={(event) => onPickVersion(slot, event.target.value)}
                >
                  <option value="">{!slot.artifactId ? 'Pick an item first' : list === undefined || list.status === 'loading' ? 'Looking up the exact versions…' : list.status === 'error' ? 'Versions couldn’t be read' : loadedVersions.length === 0 ? 'No sealed version yet' : 'Choose a version…'}</option>
                  {loadedVersions.map((version) => (
                    <option key={version.id} value={version.id} disabled={version.withdrawn}>
                      {refLabel(version.ref)} · {version.withdrawn ? 'withdrawn' : version.public ? 'published' : 'not published'}
                    </option>
                  ))}
                  {loadedDrafts.map((draft) => <option key={draft.id} value={`draft:${draft.id}`} disabled>draft {draft.revision} · can’t be pinned</option>)}
                </select>
              </label>
              <label className="case-field">
                <span>Local name</span>
                <input aria-label={`${label}: local name`} value={slot.alias} disabled={readOnly} spellCheck={false} onChange={(event) => onAlias(slot, event.target.value)} />
              </label>
            </div>
            <div className="case-slot-foot">
              <span className="case-fp">
                {slot.ref
                  ? <>{slot.origin ? `Version used by revision ${slot.origin} · ` : ''}<code>{shortDigest(slot.ref.versionDigest)}</code></>
                  : 'Nothing chosen'}
              </span>
              {!readOnly && (rows.length > 1 || slot.artifactId) && (
                <button type="button" className="case-link-button" onClick={() => onRemove(slot)}>Remove</button>
              )}
            </div>
          </div>
        );
      })}
      {role.many && !readOnly && rows.every((slot) => slot.artifactId) && (
        <button type="button" className="case-link-button case-add" onClick={onAdd}>Add another {role.label.toLowerCase()}</button>
      )}
    </section>
  );
}

function ComposerBody({ organization, project, content, reloadCase, canCreate, role }: {
  organization: Organization; project: Project; content: RouteCaseContent; reloadCase: () => void; canCreate: boolean; role: Organization['effective_role'];
}) {
  const { item } = content;
  const revisions = newestFirst(content.revisions);
  const root = `/app/${organization.slug}/${project.slug}`;
  const base = `${root}/cases/${item.slug}`;
  const [params] = useSearchParams();
  const wanted = Number(params.get('from'));
  const source = revisions.find((revision) => revision.revision === wanted) ?? revisions[0];
  const counter = useRef(0);

  const [startKey, setStartKey] = useState(0);
  const [edits, setEdits] = useState<Slot[] | null>(null);
  const [profileChoice, setProfileChoice] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [made, setMade] = useState<Made | null>(null);
  const [createIssue, setCreateIssue] = useState<Issue | null>(null);
  const [busy, setBusy] = useState(false);

  const library = useResource(`compose-library:${organization.slug}`, () => libraryApi.list(organization.slug, true));
  const profiles = useResource('compose-profiles', () => apiClient.getProfiles().catch(() => []));
  const usage = useResource('compose-usage', () => apiClient.getOwnUsage().catch(() => null));
  const catalog = useResource('compose-catalog', () => apiClient.getPricingCatalog().catch(() => null));
  const start = useResource<Start>(`compose-start:${item.slug}:${source?.id ?? 'none'}:${startKey}`, () => startFrom(source));

  const readOnly = !canCreate;
  // While the start is read again (after a revision was created) the previous reading stays on screen.
  const startData = start.data ?? start.stale;
  const slots = withRows(edits ?? startData?.slots ?? []);
  const picked = slots.filter((slot) => slot.versionId && slot.ref);

  const labels = new Map<string, string>();
  for (const artifact of library.data ?? []) if (!artifact.archived) labels.set(artifact.id, artifactLabel(artifact));
  for (const extra of startData?.extras ?? []) if (!labels.has(extra.id)) labels.set(extra.id, extra.label);
  /** The library items that can fill one part, plus the ones already in it that the library list doesn't hold. */
  const artifacts = (key: RoleKey) => {
    const kinds = ROLES.find((candidate) => candidate.key === key)?.kinds ?? [];
    const ids = new Set((library.data ?? []).filter((artifact) => !artifact.archived && kinds.includes(artifact.kind)).map((artifact) => artifact.id));
    for (const slot of slots) if (slot.role === key && slot.artifactId) ids.add(slot.artifactId);
    return [...ids].map((id) => ({ id, label: labels.get(id) ?? id })).sort((a, b) => a.label.localeCompare(b.label));
  };

  const artifactIds = [...new Set(slots.map((slot) => slot.artifactId).filter(Boolean))];
  const versions = useLoadedMap(artifactIds, (id) => libraryApi.versions(id));
  const drafts = useLoadedMap(artifactIds, (id) => libraryApi.drafts(id).then((all) => all.map((draft) => ({ id: draft.id, revision: draft.revision }))).catch(() => []));
  const contents = useLoadedMap(
    picked.map((slot) => slot.versionId),
    async (versionId) => {
      const slot = slots.find((candidate) => candidate.versionId === versionId);
      const text = await libraryApi.content(slot?.artifactId ?? '', versionId);
      return JSON.parse(text) as unknown;
    },
  );

  const documentsOf = (key: RoleKey) => picked.filter((slot) => slot.role === key).flatMap((slot) => (contents[slot.versionId]?.status === 'ready' ? [contents[slot.versionId].value] : []));
  const reading = picked.some((slot) => !contents[slot.versionId] || contents[slot.versionId].status === 'loading');
  const unreadable = picked.filter((slot) => contents[slot.versionId]?.status === 'error');
  const stats = estimateComposition({
    applications: documentsOf('application'), catalogs: documentsOf('candidateCatalog'), constraintSets: documentsOf('constraintSet'), optimizations: documentsOf('optimization'),
  });
  const size = reading || unreadable.length > 0 ? null : stats.log10;

  const capability = usage.data?.capabilities && 'maxInstanceComplexityLog10' in usage.data.capabilities ? usage.data.capabilities.maxInstanceComplexityLog10 : undefined;
  const ceilingKnown = capability !== undefined || (catalog.data !== null && catalog.data !== undefined && Boolean(usage.data?.plan));
  const ceiling = capability !== undefined ? capability : planLimit(catalog.data, usage.data?.plan, 'maxInstanceComplexityLog10');
  const overPlan = size !== null && ceiling !== null && size > ceiling;

  const profile = profileChoice ?? (typeof (source?.document.spec as { profile?: unknown } | undefined)?.profile === 'string' ? String((source?.document.spec as { profile: string }).profile) : null) ?? profiles.data?.[0]?.id ?? 'qos-binding/v1';

  const profileOptions: Array<{ id: string; digest: string }> = profiles.data?.length ? profiles.data : [{ id: profile, digest: '' }];

  const touch = () => { setCheck({ state: 'idle' }); setMade(null); setCreateIssue(null); };
  const change = (next: Slot[]) => { setEdits(next); touch(); };
  const patch = (slot: Slot, update: Partial<Slot>) => change(slots.map((candidate) => (candidate.id === slot.id ? { ...candidate, ...update } : candidate)));

  const pickArtifact = (slot: Slot, artifactId: string) => {
    const known = (library.data ?? []).find((artifact) => artifact.id === artifactId)?.name ?? (labels.get(artifactId) ?? '').split(' (')[0];
    patch(slot, { artifactId, versionId: '', ref: undefined, origin: undefined, alias: !artifactId ? '' : !slot.versionId || !slot.alias ? aliasFrom(known) : slot.alias });
  };
  const pickVersion = (slot: Slot, versionId: string) => {
    const version = (versions[slot.artifactId]?.value ?? []).find((candidate) => candidate.id === versionId);
    patch(slot, { versionId, ref: version?.ref, origin: undefined });
  };
  const addRow = (key: RoleKey) => change([...slots, { id: `row-${key}-${counter.current += 1}`, role: key, artifactId: '', versionId: '', alias: '' }]);
  const removeRow = (slot: Slot) => change(slots.filter((candidate) => candidate.id !== slot.id));
  const clearAll = () => { setEdits([]); touch(); };
  const restart = () => { setEdits(null); setStartKey((key) => key + 1); touch(); };

  const focusRole = (key: string) => {
    const section = document.getElementById(`role-${key}`);
    section?.scrollIntoView?.({ block: 'center' });
    section?.querySelector<HTMLElement>('select')?.focus();
  };

  const validate = async () => {
    setCheck({ state: 'checking' });
    setMade(null);
    setCreateIssue(null);
    const issues: Issue[] = [];
    for (const def of ROLES) {
      const count = picked.filter((slot) => slot.role === def.key).length;
      if (def.required && count === 0) {
        issues.push({ source: 'check', title: `${def.label} is missing`, text: 'Pick a version to continue.', action: { kind: 'role', label: `Choose ${def.label.toLowerCase()}`, role: def.key } });
      }
      if (!def.many && count > 1) {
        issues.push({ source: 'check', title: `Only one ${def.label.toLowerCase()} is allowed`, text: 'Remove the extra ones; the profile takes exactly one.', action: { kind: 'role', label: `Go to ${def.label.toLowerCase()}`, role: def.key } });
      }
      if (slots.some((slot) => slot.role === def.key && slot.artifactId && !slot.versionId)) {
        issues.push({ source: 'check', title: `${def.label}: choose a version`, text: 'An item is picked without a version. Choose a sealed version, or remove the row.', action: { kind: 'role', label: `Go to ${def.label.toLowerCase()}`, role: def.key } });
      }
    }
    const aliases = picked.map((slot) => slot.alias.trim());
    if (aliases.some((alias) => !ALIAS_PATTERN.test(alias)) || new Set(aliases).size !== aliases.length) {
      issues.push({ source: 'check', title: 'Local names must be unique', text: 'Use letters, numbers, dots, hyphens and underscores, starting with a letter or number. Each version needs its own name.' });
    }
    const answers = await Promise.allSettled(picked.map((slot) => casesApi.resolveVersion(slot.ref as ArtifactRef)));
    answers.forEach((answer, index) => {
      if (answer.status === 'rejected') issues.push(resolveRefusal(answer.reason, refLabel(picked[index].ref as ArtifactRef)));
    });
    setCheck({ state: 'done', issues });
  };

  const ok = check.state === 'done' && check.issues.length === 0;

  const create = async () => {
    if (!ok || busy || readOnly) return;
    setBusy(true);
    setCreateIssue(null);
    const uses: ArtifactUse[] = picked.map((slot) => ({ role: slot.role, alias: slot.alias.trim(), artifact: slot.ref as ArtifactRef, bindings: {} }));
    try {
      const revision = await casesApi.createRevision(organization.slug, project.slug, item.slug, {
        apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: item.slug }, spec: { profile, resources: {} },
      }, uses);
      const existing = revisions.some((candidate) => candidate.id === revision.id);
      setMade({ revision, existing, tooBig: false });
      reloadCase();
      if (revision.source_snapshot_id) {
        casesApi.analyseSnapshot(revision.source_snapshot_id).catch((caught: unknown) => {
          if (classifyAuthError(caught).kind === 'quota') setMade((current) => (current ? { ...current, tooBig: true } : current));
        });
      }
    } catch (caught) {
      setCreateIssue(composeRefusal(caught));
    } finally {
      setBusy(false);
    }
  };

  const issues = [...(edits === null ? startData?.issues ?? [] : []), ...(check.state === 'done' ? check.issues : []), ...(createIssue ? [createIssue] : [])];
  const nothingPicked = picked.length === 0;
  const libraryFailure = library.status === 'error' ? classifyAuthError(library.error) : null;
  const connect = [
    { from: 'Rules', what: 'the qualities they limit', ready: picked.some((slot) => slot.role === 'constraintSet') && picked.some((slot) => slot.role === 'candidateCatalog') },
    { from: 'Goal', what: 'the qualities to optimize', ready: picked.some((slot) => slot.role === 'optimization') && picked.some((slot) => slot.role === 'candidateCatalog') },
  ];
  const tasksLink = (() => {
    if (!picked.some((slot) => slot.role === 'application') || !picked.some((slot) => slot.role === 'candidateCatalog')) return { state: 'waiting', tone: '' };
    if (reading) return { state: 'reading the contents…', tone: '' };
    if (stats.missing.length > 0) return { state: `no candidates for ${stats.missing.join(', ')}`, tone: 'is-bad' };
    if (stats.serviceTasks > 0) return { state: '✓ every task has candidates', tone: 'is-good' };
    return { state: 'checked when you create', tone: '' };
  })();

  return (
    <CaseFrame organization={organization} project={project} trail={[{ label: 'Cases', to: `${root}/cases` }, { label: item.name, to: base }, { label: 'New revision' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>New revision of {item.name}</h1>
          <p>Pick exact versions for each part. Nothing changes until you validate and create the revision; once created it’s sealed.</p>
        </div>
        <div className="proj-actions">
          <Action variant="secondary" onClick={restart} disabled={readOnly || !source}>{source ? `Start from revision ${source.revision}` : 'Start from a revision'}</Action>
          <Action variant="secondary" onClick={clearAll} disabled={readOnly}>Clear</Action>
        </div>
      </header>

      {readOnly && <ReadOnlyNote role={role}>You can look at the composition, but creating revisions needs MEMBER.</ReadOnlyNote>}
      {libraryFailure && (
        <Notice tone="warning">
          {libraryFailure.status === 403
            ? `This credential can’t read the library${marker(libraryFailure)}. Use a session or a key that includes it.`
            : `The library couldn’t be read${marker(libraryFailure)}. Versions already in this revision still work.`}
        </Notice>
      )}
      {start.status === 'loading' && source && (
        <div className="case-loading" role="status"><span className="case-spinner" aria-hidden="true" />Looking up the exact versions…</div>
      )}

      <div className="case-composer">
        <div className="case-compose-main">
          <section className="proj-panel case-profile" aria-label="Language profile">
            <label className="case-field">
              <span>Language profile</span>
              <select value={profile} disabled={readOnly} onChange={(event) => { setProfileChoice(event.target.value); touch(); }}>
                {profileOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.id}{entry.digest ? ` · ${shortDigest(entry.digest)}` : ''}</option>
                ))}
              </select>
            </label>
            <div className="case-field"><span>Dialects</span><span className="case-static">Chosen from the picked versions</span></div>
            <Link to="/language" viewTransition>What’s in this profile</Link>
          </section>

          {nothingPicked && start.status !== 'loading' && (
            <div className="case-dashed" role="note">Empty composition. Application, candidate catalog and goal are required; rules are optional.</div>
          )}

          {ROLES.map((def) => (
            <RoleSection
              key={def.key}
              role={def}
              rows={slots.filter((slot) => slot.role === def.key)}
              artifacts={artifacts(def.key)}
              versions={versions}
              drafts={drafts}
              readOnly={readOnly}
              onPickArtifact={pickArtifact}
              onPickVersion={pickVersion}
              onAlias={(slot, alias) => patch(slot, { alias })}
              onRemove={removeRow}
              onAdd={() => addRow(def.key)}
              invalid={check.state === 'done' && check.issues.some((issue) => issue.action?.role === def.key)}
            />
          ))}

          <section className="proj-panel" aria-labelledby="links-title">
            <h2 id="links-title" className="case-h2">How the parts connect</h2>
            <ul className="case-connect">
              {connect.map((link) => (
                <li key={link.from}>
                  <span className="case-pill">{link.from}</span><span aria-hidden="true">uses</span><span className="case-pill">{link.what}</span>
                  <span aria-hidden="true">from</span><span className="case-pill is-catalog">Candidate catalog</span>
                  <small>{link.ready ? 'both picked · the gateway checks it when you create' : 'waiting'}</small>
                </li>
              ))}
              <li>
                <span className="case-pill">Application</span><span aria-hidden="true">uses</span><span className="case-pill">{`providers for ${stats.serviceTasks || 'its'} tasks`}</span>
                <span aria-hidden="true">from</span><span className="case-pill is-catalog">Candidate catalog</span>
                <small className={tasksLink.tone}>{tasksLink.state}</small>
              </li>
            </ul>
          </section>
        </div>

        <aside className="case-compose-aside" aria-label="Size, preview and check">
          <section className="proj-panel" aria-labelledby="size-title">
            <span className="org-eyebrow" id="size-title">Problem size</span>
            <SizeMeter size={size} ceiling={ceiling} ceilingKnown={ceilingKnown} />
            <span className="org-muted">
              {unreadable.length > 0 ? 'A picked version’s content couldn’t be read, so its size can’t be estimated.'
                : overPlan ? 'Above your plan’s ceiling: you can create the revision, but running it will be refused (402). Fewer candidates or a larger plan fix it.'
                  : size !== null ? 'Fits your plan. This is an upper bound: the gateway counts the exact combinations when it compiles.'
                    : reading ? 'Reading the contents of the picked versions…' : 'Pick an application and a candidate catalog to estimate it.'}
            </span>
          </section>

          <section className="proj-panel" aria-labelledby="preview-title">
            <span className="org-eyebrow" id="preview-title">Preview</span>
            <dl className="case-preview">
              <div><dt>Tasks</dt><dd>{stats.tasks ? `${stats.tasks} (${stats.serviceTasks} get a provider)` : '—'}</dd></div>
              <div><dt>Candidates</dt><dd>{stats.candidates || '—'}</dd></div>
              <div><dt>Rules</dt><dd>{picked.some((slot) => slot.role === 'constraintSet') ? `${stats.must} must, ${stats.should} should` : 'none'}</dd></div>
              <div><dt>Goal</dt><dd>{stats.criteria ? `${stats.criteria} ${stats.criteria === 1 ? 'criterion' : 'criteria'}` : '—'}</dd></div>
            </dl>
            {source && <Link to={`${base}/revisions/${source.revision}`} viewTransition>Full view of the current revision</Link>}
          </section>

          <section className="proj-panel" aria-labelledby="check-title">
            <span className="org-eyebrow" id="check-title">Check and create</span>
            {check.state === 'checking' && <span role="status" className="case-checking"><span className="case-spinner" aria-hidden="true" />Checking the whole composition…</span>}
            {ok && !made && !createIssue && (
              <div className="case-ok" role="status">
                Everything fits together. {overPlan ? '' : 'Ready to create.'}
              </div>
            )}
            {ok && overPlan && ceiling !== null && !made && (
              <div className="case-warn" role="status">Valid, but too big to run on your plan (402 instance complexity). Your plan allows up to <Power log10={ceiling} />.</div>
            )}
            {issues.map((issue, index) => (
              <div className="case-issue" role="alert" key={`${issue.title}-${index}`}>
                <b>{issue.title}</b>
                <span>{issue.text}</span>
                {issue.details && issue.details.length > 0 && <ul>{issue.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
                {issue.action?.kind === 'role' && issue.action.role && <button type="button" className="case-link-button" onClick={() => focusRole(issue.action?.role ?? '')}>{issue.action.label}</button>}
                {issue.action?.kind === 'dialects' && <Link to="/language" viewTransition>{issue.action.label}</Link>}
                {issue.action?.kind === 'revisions' && <Link to={base} viewTransition>{issue.action.label}</Link>}
              </div>
            ))}
            {made && (
              <div className="case-ok is-made" role="status">
                <b>{made.existing ? `These exact inputs already match revision ${made.revision.revision}` : `Revision ${made.revision.revision} created and sealed`}</b>
                <span>{made.existing ? 'Nothing new was sealed: a revision is identified by its inputs.' : `Its fingerprint is ${shortDigest(made.revision.digest)}.`}</span>
                {made.tooBig && ceiling !== null && <span className="case-warn-text">It is too big to run on your plan (402 instance complexity). Your plan allows up to <Power log10={ceiling} />.</span>}
                <span className="case-links">
                  <Link to={base} viewTransition>See revisions</Link>
                  <Link to={`${base}/revisions/${made.revision.revision}`} viewTransition>Open it</Link>
                  <Link to={`${root}/jobs/new?case=${encodeURIComponent(item.slug)}&revision=${made.revision.revision}`} viewTransition>Run it</Link>
                </span>
              </div>
            )}
            <span className="proj-buttons">
              <Action variant="secondary" onClick={() => void validate()} disabled={readOnly || check.state === 'checking'}>Validate</Action>
              <Action variant="primary" onClick={() => void create()} disabled={!ok || readOnly} busy={busy}>Create revision</Action>
            </span>
            {readOnly && <small className="org-muted"><Lock aria-hidden="true" className="org-inline-icon" /> Creating needs MEMBER.</small>}
          </section>
        </aside>
      </div>
    </CaseFrame>
  );
}

/** Compose (`case-composer`, `/app/:org/:project/cases/:case/compose`): four parts, exact library versions, a live size meter and the check before sealing. */
export function CaseComposer() {
  const route = useRouteCase();
  const { orgSlug, projectSlug, caseSlug, organization, project, access, waiting, failure, reload, content, loaded, caseFailure } = route;
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  const root = `/app/${organization.slug}/${project.slug}`;
  // Composing writes, and reads the organization’s library: both are for members.
  if (access.publicRead) return <MembersOnlyGate root={root} />;
  const trail = [{ label: 'Cases', to: `${root}/cases` }, { label: caseSlug, to: `${root}/cases/${caseSlug}` }, { label: 'New revision' }];
  if (content.status === 'loading' && !loaded) {
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the case…</span><Skeleton variant="card" /><Skeleton variant="panel" /></div>
      </CaseFrame>
    );
  }
  if (caseFailure || !loaded) {
    const missing = isMissing(caseFailure);
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <CaseMissing
          title={missing ? `No case with this address in ${project.name} (404)` : `The case couldn’t be loaded${caseFailure ? marker(caseFailure) : ''}`}
          actions={<><Action to={`${root}/cases`} variant="primary">All cases</Action><Action variant="secondary" onClick={content.reload}>Retry</Action></>}
        >
          {missing ? 'It may have been deleted or renamed.' : 'The gateway didn’t answer for this case. Try again in a moment.'}
        </CaseMissing>
      </CaseFrame>
    );
  }
  return <ComposerBody organization={organization} project={project} content={loaded} reloadCase={content.reload} canCreate={access.canCreate} role={access.role} />;
}
