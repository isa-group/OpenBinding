// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition's versions, which are immutable and referenced: no per-version visibility and no delete. Each row
// says its values and how far they can be trusted, the problem version it links and where it came from, and offers SPHERE's
// compare with the previous version, Download YAML, Open in editor and Copy link (the permanent link of a private
// composition), plus OpenBinding's re-evaluation with the installed toolchain (MEMBER). The pair compared and the view live
// in the address (`?from=&to=&diff=file`).

import { formatDistanceToNow, parseISO } from 'date-fns';
import { useMemo, useState } from 'react';
import { FiColumns, FiCopy, FiDownload, FiEdit2, FiRefreshCw } from 'react-icons/fi';
import { Link, useSearchParams } from 'react-router-dom';
import { problemsApi } from '../../../../api/problems';
import { useResource } from '../../../../utils/useResource';
import { readApiError } from '../../../core/api/errors';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { useCopy } from '../../../core/hooks/useCopy';
import { formatValue, valueModels, valueStatus } from '../../../core/utils/composition/values';
import { pickVersion } from '../../../core/utils/composition/versionRef';
import { compositionPath, editorPath, permalinkPath } from '../../../../routes/paths/compositions';
import { problemPath } from '../../../../routes/paths/problems';
import { runPath } from '../../../../routes/paths/runs';
import { compositionsApi } from '../../api/compositionsApi';
import { saveText } from '../../utils/download';
import CompositionVersionDiffView from '../version-diff';

const shortId = (id: string) => id.slice(0, 8);

const OUTCOME_NOTE: Partial<
  Record<NonNullable<CompositionVersionView['current_evaluation']>['outcome'], string>
> = {
  binding_invalid: 'binding invalid for its problem',
  semantics_changed: 'its problem changed meaning',
};

/** The problem revision a linked version is judged against, when the gateway named it to this reader. */
const revisionKey = (version: CompositionVersionView) =>
  version.problem && version.problem.problem.id !== null
    ? `${version.problem.problem.slug}@${version.problem.revision.revision}`
    : null;

const iconButton =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink disabled:cursor-wait disabled:opacity-60';

interface RowProps {
  org: string;
  composition: CompositionView;
  version: CompositionVersionView;
  previous: CompositionVersionView | undefined;
  latest: boolean;
  shown: boolean;
  member: boolean;
  canReevaluate: boolean;
  onCompare: (from: CompositionVersionView, to: CompositionVersionView) => void;
  onReevaluated: (message: string) => void;
}

function VersionRow({
  org,
  composition,
  version,
  previous,
  latest,
  shown,
  member,
  canReevaluate,
  onCompare,
  onReevaluated,
}: RowProps) {
  const [busy, setBusy] = useState<'download' | 'reevaluate' | null>(null);
  const [failure, setFailure] = useState('');
  const { copy, status } = useCopy();
  const values = valueModels(version);
  const outcome = version.current_evaluation?.outcome;
  const link = version.problem;
  const forked = version.forked_from;
  const derivation = version.derivation;
  const page = compositionPath(org, composition.slug, undefined, { version: version.label });
  // A private composition's address opens only for its members; its permanent link says the same to everybody.
  const shareable =
    composition.visibility === 'public'
      ? `${window.location.origin}${page}`
      : `${window.location.origin}${permalinkPath(composition.id, version.label)}`;

  const download = async () => {
    setBusy('download');
    setFailure('');
    try {
      saveText(
        await compositionsApi.content(org, composition.slug, version.id),
        `${composition.slug}-${version.label}.yaml`
      );
    } catch (caught) {
      setFailure(
        `The text of ${version.label} couldn’t be downloaded: ${readApiError(caught).message}`
      );
    } finally {
      setBusy(null);
    }
  };

  const reevaluate = async () => {
    setBusy('reevaluate');
    setFailure('');
    try {
      const { created, evaluation } = await compositionsApi.reevaluate(
        org,
        composition.slug,
        version.id
      );
      onReevaluated(
        created
          ? `Version ${version.label} re-evaluated with the installed toolchain: ${evaluation.outcome.replace('_', ' ')}.`
          : `Version ${version.label} was already evaluated with the installed toolchain.`
      );
    } catch (caught) {
      setFailure(
        `Version ${version.label} couldn’t be re-evaluated: ${readApiError(caught).message}`
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <li
      aria-label={`Version ${version.label}`}
      aria-current={shown ? 'true' : undefined}
      className={`flex flex-col gap-3 px-4 py-3 transition-colors lg:flex-row lg:items-start lg:justify-between ${shown ? 'bg-tp-primary/5' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to={page}
            title="View this version"
            className="cursor-pointer font-mono text-sm font-medium text-tp-ink hover:text-tp-accent hover:underline"
          >
            {version.label}
          </Link>
          {shown && (
            <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-medium text-tp-accent">
              Current
            </span>
          )}
          {latest && (
            <span className="rounded-full bg-tp-surface px-2 py-0.5 text-[10px] font-medium text-tp-steel">
              Latest
            </span>
          )}
          {forked && (
            <span className="rounded-full bg-tp-surface px-2 py-0.5 text-[10px] font-medium text-tp-steel">
              Forked
            </span>
          )}
          <span className="text-[11px] text-tp-steel">
            {formatDistanceToNow(parseISO(version.created_at))} ago
          </span>
          <ValueBadge status={valueStatus(version)} />
          {outcome && OUTCOME_NOTE[outcome] && (
            <span className="text-[11px] text-tp-steel">{OUTCOME_NOTE[outcome]}</span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-tp-steel">
          {values.length === 0
            ? 'No values'
            : values
                .map(value => `${value.name} ${formatValue(value.value, value.unit)}`)
                .join(' · ')}
          {' · '}
          {!link ? (
            'no problem (declared)'
          ) : member && link.problem.id !== null ? (
            <Link
              to={problemPath(org, link.problem.slug, undefined, {
                version: link.revision.revision,
              })}
              className="underline decoration-dotted hover:text-tp-ink"
            >{`${link.problem.slug}@${link.revision.revision}`}</Link>
          ) : (
            <code className="font-mono">{`${link.problem.slug}@${link.revision.revision}`}</code>
          )}
        </p>
        {(forked || derivation) && (
          <p className="mt-1 text-[11px] text-tp-steel">
            {forked &&
              (forked.name || forked.slug
                ? `Forked from ${forked.name ?? forked.slug}${forked.label ? ` (version ${forked.label})` : ''}${forked.organization ? ` · ${forked.organization.displayName}` : ''}`
                : 'Forked from a composition that is not shared with you')}
            {derivation?.source === 'run' && derivation.run && (
              <>
                Derived from{' '}
                {member ? (
                  <Link
                    to={runPath(org, derivation.run.id)}
                    className="underline decoration-dotted hover:text-tp-ink"
                  >
                    run {shortId(derivation.run.id)}
                  </Link>
                ) : (
                  `run ${shortId(derivation.run.id)}`
                )}
                {derivation.point !== null ? `, point ${derivation.point}` : ''}
              </>
            )}
            {derivation?.source === 'binding' &&
              `Derived from a binding of problem version ${derivation.revision.revision}`}
          </p>
        )}
        {failure && (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {failure}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {previous && (
          <button
            type="button"
            onClick={() => onCompare(previous, version)}
            title="Compare with the previous version"
            className={iconButton}
          >
            <FiColumns className="h-4 w-4" aria-hidden="true" />
            Compare with previous
          </button>
        )}
        {member && (
          <Link
            to={editorPath({ source: { org, slug: composition.slug }, version: version.label })}
            target="_blank"
            rel="noreferrer"
            className={iconButton}
          >
            <FiEdit2 className="h-4 w-4" aria-hidden="true" />
            Open in editor
          </Link>
        )}
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy === 'download'}
          className={iconButton}
        >
          <FiDownload className="h-4 w-4" aria-hidden="true" />
          Download YAML
        </button>
        <button
          type="button"
          onClick={() => void copy(shareable, version.id)}
          className={iconButton}
        >
          <FiCopy className="h-4 w-4" aria-hidden="true" />
          {status(version.id) === 'copied'
            ? 'Link copied'
            : status(version.id) === 'failed'
              ? 'Copy failed'
              : 'Copy link'}
        </button>
        {canReevaluate && (
          <button
            type="button"
            onClick={() => void reevaluate()}
            disabled={busy === 'reevaluate'}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-tp-hairline-strong px-2 text-xs text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-wait disabled:opacity-60"
          >
            <FiRefreshCw className="h-4 w-4" aria-hidden="true" />
            Re-evaluate
          </button>
        )}
      </div>
    </li>
  );
}

interface VersionsTabProps {
  org: string;
  composition: CompositionView;
  /** Light rows, newest first. */
  versions: CompositionVersionView[];
  /** The version the page shows. */
  shown: string | null;
  /** Re-evaluate: MEMBER. */
  canCreate: boolean;
  /** The reader is a member of the composition's organization. */
  member: boolean;
  /** The composition and its versions must be read again (a re-evaluation changed a current evaluation). */
  onChanged: (message: string) => void;
}

export default function CompositionVersionsTab({
  org,
  composition,
  versions,
  shown,
  canCreate,
  member,
  onChanged,
}: VersionsTabProps) {
  const [query, setQuery] = useSearchParams();
  const fromParam = query.get('from');
  const toParam = query.get('to');
  const view = query.get('diff') === 'file' ? 'file' : 'structured';

  // The pair compared: `?to=` (the latest by default) and `?from=` (the version before it by default).
  const pair = useMemo(() => {
    if (versions.length < 2 || (!fromParam && !toParam)) return null;
    const later = pickVersion(versions, toParam) ?? versions[0];
    const index = versions.indexOf(later);
    const before = versions[index + 1] ?? versions[index - 1];
    const earlier = pickVersion(versions, fromParam) ?? before;
    return { from: earlier, to: later };
  }, [versions, fromParam, toParam]);

  const labelOf = (id: string) => versions.find(version => version.id === id)?.label ?? id;
  const setPair = (from: string | null, to: string | null) =>
    setQuery(
      current => {
        const next = new URLSearchParams(current);
        if (from && to) {
          next.set('from', labelOf(from));
          next.set('to', labelOf(to));
        } else {
          next.delete('from');
          next.delete('to');
          next.delete('diff');
        }
        return next;
      },
      { replace: true }
    );

  // Which compilation the installed toolchain made of each linked problem revision: a version evaluated on another one can be
  // evaluated again. Only a MEMBER may, so only a MEMBER asks.
  const revisions = canCreate
    ? [
        ...new Map(
          versions.flatMap(version => {
            const key = revisionKey(version);
            return key && version.problem
              ? [
                  [
                    key,
                    {
                      problem: version.problem.problem.slug,
                      revision: version.problem.revision.revision,
                    },
                  ] as const,
                ]
              : [];
          })
        ).entries(),
      ]
    : [];
  const installed = useResource<Map<string, string | null>>(
    `composition-installed:${org}/${revisions.map(([key]) => key).join(',') || 'none'}`,
    async () =>
      new Map(
        await Promise.all(
          revisions.map(async ([key, { problem, revision }]): Promise<[string, string | null]> => {
            const detail = await problemsApi.revision(org, problem, revision).catch(() => null);
            return [
              key,
              detail
                ? (detail.compilations.find(compilation => compilation.current)
                    ?.compilation_digest ?? '')
                : null,
            ];
          })
        )
      )
  );
  const needsEvaluation = (version: CompositionVersionView) => {
    const key = revisionKey(version);
    const digest = key ? installed.data?.get(key) : null;
    // null: the revision could not be read, so nobody can tell; '': the installed toolchain has not compiled it yet.
    return (
      canCreate &&
      digest !== null &&
      digest !== undefined &&
      version.current_evaluation?.compilation?.compilation_digest !== digest
    );
  };

  const canCompare = versions.length > 1;

  if (versions.length === 0)
    return (
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-6 text-sm text-tp-steel">
        No version yet. Seal the first one in the editor.
      </div>
    );

  return (
    <div className="space-y-4">
      {canCompare && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-tp-steel">
            Pick two versions to see what changed between them.
          </p>
          <button
            type="button"
            onClick={() =>
              pair ? setPair(null, null) : setPair((versions[1] ?? versions[0]).id, versions[0].id)
            }
            aria-pressed={pair !== null}
            className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${pair ? 'border-tp-primary bg-tp-primary/5 text-tp-accent' : 'border-tp-hairline-strong text-tp-ink hover:border-tp-primary/40'}`}
          >
            <FiColumns className="h-3.5 w-3.5" aria-hidden="true" />
            {pair ? 'Hide comparison' : 'Compare versions'}
          </button>
        </div>
      )}
      {pair && (
        <CompositionVersionDiffView
          org={org}
          composition={composition}
          versions={versions}
          from={pair.from.id}
          to={pair.to.id}
          onPair={setPair}
          member={member}
          view={view}
          onView={next =>
            setQuery(
              current => {
                const search = new URLSearchParams(current);
                if (next === 'file') search.set('diff', 'file');
                else search.delete('diff');
                return search;
              },
              { replace: true }
            )
          }
        />
      )}
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas">
        <ol aria-label={`Versions of ${composition.name}`} className="divide-y divide-tp-hairline">
          {versions.map((version, index) => (
            <VersionRow
              key={version.id}
              org={org}
              composition={composition}
              version={version}
              previous={versions[index + 1]}
              latest={index === 0}
              shown={version.id === shown}
              member={member}
              canReevaluate={needsEvaluation(version)}
              onCompare={(from, to) => setPair(from.id, to.id)}
              onReevaluated={onChanged}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}
