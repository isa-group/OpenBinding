// Pattern only, after SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Open a package in the problem editor: SPHERE's destination toggle and target list choose a template of the gateway, or
// (signed in) a version of a problem of one of the account's organizations, or the blank package. Opening goes through
// the address, so the back button returns to the package before.

import { useEffect, useState } from 'react';
import { FiFileText, FiFolder, FiLayers } from 'react-icons/fi';
import { bimApi } from '../../../../api/bim';
import { problemsApi, type Problem, type ProblemRevision } from '../../../../api/problems';
import { EditorDialog } from '../../../core/components/editor-chrome';
import OrganizationSelector from '../../../organization/components/organization-selector';
import type { Organization } from '../../../organization/api/organizationsApi';

/** How many problems the picker lists: the gateway's ceiling for one page. */
const PICKER_LIMIT = 200;

const SELECT =
  'h-10 w-full cursor-pointer rounded-md border border-tp-hairline-strong bg-tp-canvas px-3 text-sm text-tp-ink outline-none focus:border-tp-accent focus:ring-2 focus:ring-tp-accent/10 disabled:cursor-not-allowed disabled:bg-tp-surface';
const PRIMARY =
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-tp-accent px-4 py-2 text-sm font-semibold text-tp-on-primary transition-colors hover:bg-tp-accent-hover disabled:cursor-not-allowed disabled:opacity-45';

export type OpenChoice =
  | { kind: 'template'; template: string }
  | { kind: 'revision'; org: string; problem: string; revision: number }
  | { kind: 'blank' };

type Loaded<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

/** A list read once per key; an older answer never replaces a newer one. */
function useLoaded<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string; value: Loaded<T> } | null>(null);
  useEffect(() => {
    if (key === null) return undefined;
    let active = true;
    Promise.resolve()
      .then(load)
      .then(
        data => {
          if (active) setState({ key, value: { status: 'ready', data } });
        },
        () => {
          if (active) setState({ key, value: { status: 'error' } });
        }
      );
    return () => {
      active = false;
    };
    // The key names what is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state.value : { status: 'loading' };
}

function Part({
  active,
  icon,
  title,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${active ? 'border-tp-primary/30 bg-tp-canvas text-tp-ink shadow-sm' : 'border-transparent text-tp-steel hover:text-tp-ink'}`}
    >
      <span className={active ? 'text-tp-accent' : ''}>{icon}</span>
      {title}
    </button>
  );
}

function Templates({ onOpen }: { onOpen: (choice: OpenChoice) => void }) {
  const templates = useLoaded('templates', () => bimApi.templates());
  if (templates.status === 'loading')
    return <p className="text-center text-sm text-tp-steel">Reading the templates…</p>;
  if (templates.status === 'error')
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        The templates couldn’t be listed.
      </p>
    );
  if (templates.data.length === 0)
    return <p className="text-center text-sm text-tp-steel">This deployment ships no templates.</p>;
  return (
    <ul aria-label="Templates" className="max-h-72 space-y-2 overflow-y-auto">
      {templates.data.map(path => (
        <li key={path}>
          <button
            type="button"
            onClick={() => onOpen({ kind: 'template', template: path })}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2 text-left transition-colors hover:border-tp-primary/40 hover:bg-tp-surface"
          >
            <FiFileText className="h-4 w-4 shrink-0 text-tp-steel" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-tp-ink">{path}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Versions({
  initialOrg,
  onOpen,
}: {
  initialOrg: string | null;
  onOpen: (choice: OpenChoice) => void;
}) {
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [problem, setProblem] = useState('');
  const [revision, setRevision] = useState('');
  const org = organization?.slug ?? null;
  const problems = useLoaded<Problem[]>(org ? `problems:${org}` : null, async () =>
    org ? (await problemsApi.list(org, { limit: PICKER_LIMIT })).problems : []
  );
  const revisions = useLoaded<ProblemRevision[]>(
    org && problem ? `revisions:${org}/${problem}` : null,
    () => (org && problem ? problemsApi.revisions(org, problem) : Promise.resolve([]))
  );
  const versions =
    revisions.status === 'ready' ? [...revisions.data].sort((a, b) => b.revision - a.revision) : [];
  const chosen = versions.find(item => String(item.revision) === revision) ?? versions[0];
  const list = problems.status === 'ready' ? problems.data : [];

  return (
    <div className="space-y-3">
      <OrganizationSelector
        value={organization}
        onChange={next => {
          setOrganization(next);
          setProblem('');
          setRevision('');
        }}
        initialSlug={initialOrg}
      />
      {org && problems.status === 'error' && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          The organization’s problems couldn’t be listed.
        </p>
      )}
      {org && problems.status === 'ready' && list.length === 0 && (
        <p className="text-sm text-tp-steel">The organization has no problems yet.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1 block text-sm text-tp-slate">Problem</span>
          <select
            className={SELECT}
            value={problem}
            disabled={!org}
            onChange={event => {
              setProblem(event.target.value);
              setRevision('');
            }}
          >
            <option value="">
              {org && problems.status === 'loading' ? 'Loading problems…' : 'Choose a problem…'}
            </option>
            {list.map(item => (
              <option key={item.id} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-tp-slate">Version</span>
          <select
            className={SELECT}
            value={chosen ? String(chosen.revision) : ''}
            disabled={!problem || versions.length === 0}
            onChange={event => setRevision(event.target.value)}
          >
            {versions.length === 0 && (
              <option value="">
                {problem && revisions.status === 'loading' ? 'Loading versions…' : 'No version'}
              </option>
            )}
            {versions.map(item => (
              <option key={item.id} value={String(item.revision)}>
                Version {item.revision}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          className={PRIMARY}
          disabled={!org || !problem || !chosen}
          onClick={() =>
            org && chosen && onOpen({ kind: 'revision', org, problem, revision: chosen.revision })
          }
        >
          Open version
        </button>
      </div>
    </div>
  );
}

/** Open a package: a template, a version of a problem of one of the account's organizations, or the blank package. */
export default function OpenModal({
  part: initialPart,
  signedIn,
  initialOrg,
  onOpen,
  onClose,
}: {
  part: 'template' | 'version';
  signedIn: boolean;
  /** The organization the address names, preselected. */
  initialOrg: string | null;
  onOpen: (choice: OpenChoice) => void;
  onClose: () => void;
}) {
  const [part, setPart] = useState<'template' | 'version'>(signedIn ? initialPart : 'template');
  return (
    <EditorDialog title="Open a package" onClose={onClose} wide>
      <div className="mt-4 space-y-4">
        {signedIn ? (
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-tp-surface p-1">
            <Part
              active={part === 'template'}
              icon={<FiLayers className="h-4 w-4" aria-hidden="true" />}
              title="A template"
              onClick={() => setPart('template')}
            />
            <Part
              active={part === 'version'}
              icon={<FiFolder className="h-4 w-4" aria-hidden="true" />}
              title="A problem version"
              onClick={() => setPart('version')}
            />
          </div>
        ) : null}
        {part === 'template' ? (
          <Templates onOpen={onOpen} />
        ) : (
          <Versions initialOrg={initialOrg} onOpen={onOpen} />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-tp-hairline pt-3">
          <p className="text-xs text-tp-steel">
            Or a blank package: one task, one candidate and one goal.
          </p>
          <button
            type="button"
            onClick={() => onOpen({ kind: 'blank' })}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 py-1.5 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
          >
            Start blank
          </button>
        </div>
      </div>
    </EditorDialog>
  );
}
