// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a problem's sealed versions, which are immutable and private to the organization: no per-version visibility, no
// delete and no permanent link. Each row says when it was sealed, where it came from, how large its package is and how many
// combinations its current compilation has, and offers SPHERE's compare with the previous version, the package download and
// a copy of its exact reference, plus OpenBinding's Run (MEMBER) and Source. The pair compared, the view, the category and
// the file live in the address (`?from=&to=&diff=file&only=&file=`).

import { formatDistanceToNow, parseISO } from 'date-fns';
import { useState } from 'react';
import { FiColumns, FiCopy, FiDownload, FiFileText, FiPlay } from 'react-icons/fi';
import { Link, useSearchParams } from 'react-router-dom';
import { problemsApi } from '../../api/problemsApi';
import { readApiError } from '../../../core/api/errors';
import { useCopy } from '../../../core/hooks/useCopy';
import { problemPath } from '../../../../routes/paths/problems';
import { formatBytes } from '../../../core/utils/format';
import { useResource } from '../../../core/hooks/useResource';
import { ORIGIN_LABELS, type ProblemContent } from '../../types';
import { saveBytes } from '../../utils/download';
import { exactReference, powerText } from '../../utils/problemsModel';
import VersionCompare from './version-compare';

type Version = ProblemContent['revisions'][number];

const iconButton =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink disabled:cursor-wait disabled:opacity-60';

function VersionRow({
  org,
  slug,
  revision,
  previous,
  latest,
  shown,
  runHref,
  onCompare,
}: {
  org: string;
  slug: string;
  revision: Version;
  previous: Version | undefined;
  latest: boolean;
  shown: boolean;
  /** Where a run of the version is launched; `null` hides it (a viewer). */
  runHref: string | null;
  onCompare: (from: number, to: number) => void;
}) {
  const { copy, status } = useCopy();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const href = problemPath(org, slug, undefined, { version: revision.revision });
  const key = `r${revision.revision}`;
  // The size of the version's binding space, from the compilation of the installed toolchain the revision lists (no facts read).
  const detail = useResource(`revision-detail:${org}/${slug}/${revision.id}`, () =>
    problemsApi.revision(org, slug, revision.revision)
  );
  const space =
    detail.data?.compilations.find(compilation => compilation.current)?.binding_space ?? null;
  const change = !previous
    ? 'First version'
    : previous.package_digest === revision.package_digest
      ? `Same package as v${previous.revision}`
      : `A different package from v${previous.revision}`;

  const download = async () => {
    setBusy(true);
    setFailure('');
    try {
      saveBytes(
        await problemsApi.source(org, slug, revision.revision),
        `${slug}-v${revision.revision}.bim.zip`,
        'application/vnd.bim+zip'
      );
    } catch (caught) {
      setFailure(
        `The package of version ${revision.revision} couldn’t be downloaded: ${readApiError(caught).message}`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      aria-label={`Version ${revision.revision}`}
      aria-current={shown ? 'true' : undefined}
      className={`flex flex-col gap-3 px-4 py-3 transition-colors lg:flex-row lg:items-start lg:justify-between ${shown ? 'bg-tp-primary/5' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to={href}
            title="View this version"
            className="cursor-pointer text-sm font-medium text-tp-ink hover:text-tp-accent hover:underline"
          >
            Version {revision.revision}
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
          {revision.origin && (
            <span className="rounded-full bg-tp-surface px-2 py-0.5 text-[10px] font-medium text-tp-steel">
              {ORIGIN_LABELS[revision.origin]}
            </span>
          )}
          <span className="text-[11px] text-tp-steel">
            {formatDistanceToNow(parseISO(revision.created_at))} ago
          </span>
        </div>
        <p className="mt-1 text-[11px] text-tp-steel">
          {change} · {formatBytes(revision.package_size)?.split(' (')[0] ?? ''}
          {space !== null && ` · ≈ ${powerText(space)} combinations`}
        </p>
        {revision.sphere && revision.sphere.sources.length > 0 && (
          <p className="pv-sphere mt-1 text-[11px] [overflow-wrap:anywhere] text-tp-steel">
            Generated from SPHERE:{' '}
            {revision.sphere.sources
              .map(source =>
                source.versionLabel
                  ? `${source.title}, version ${source.versionLabel}`
                  : source.title
              )
              .join('; ')}
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
            onClick={() => onCompare(previous.revision, revision.revision)}
            className={iconButton}
          >
            <FiColumns className="h-4 w-4" aria-hidden="true" />
            Compare with v{previous.revision}
          </button>
        )}
        {runHref && (
          <Link to={runHref} className={iconButton}>
            <FiPlay className="h-4 w-4" aria-hidden="true" />
            Run
          </Link>
        )}
        <Link
          to={problemPath(org, slug, 'source', { version: revision.revision })}
          className={iconButton}
        >
          <FiFileText className="h-4 w-4" aria-hidden="true" />
          Source
        </Link>
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy}
          className={iconButton}
        >
          <FiDownload className="h-4 w-4" aria-hidden="true" />
          Download package
        </button>
        <button
          type="button"
          onClick={() => void copy(exactReference(slug, revision), key)}
          aria-label={`Copy exact reference of version ${revision.revision}`}
          className={iconButton}
        >
          <FiCopy className="h-4 w-4" aria-hidden="true" />
          {status(key) === 'copied'
            ? 'Copied'
            : status(key) === 'failed'
              ? 'Copy failed'
              : 'Copy reference'}
        </button>
      </div>
    </li>
  );
}

/** The Versions tab of the problem page: the versions newest first, and the comparison of two of them. */
export default function VersionsTab({
  org,
  content,
  shown,
  runOf,
  canCreate,
}: {
  org: string;
  content: ProblemContent;
  /** The version the page shows. */
  shown: number | null;
  runOf: (revision: number) => string;
  canCreate: boolean;
}) {
  const { item, revisions } = content;
  const [query, setQuery] = useSearchParams();
  const comparing = query.has('from') || query.has('to');

  const setPair = (from: number | null, to: number | null) =>
    setQuery(
      current => {
        const next = new URLSearchParams(current);
        if (from !== null && to !== null) {
          next.set('from', String(from));
          next.set('to', String(to));
        } else for (const name of ['from', 'to', 'diff', 'only', 'file']) next.delete(name);
        return next;
      },
      { replace: true }
    );

  if (revisions.length === 0)
    return (
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-6 text-sm text-tp-steel">
        No version yet. Upload a package, or write one in the problem editor.
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-tp-steel">
          {revisions.length > 1
            ? 'Pick two versions to see what changed between them.'
            : `${item.name} has one sealed version so far. Seal another one to compare them.`}
        </p>
        {revisions.length > 1 && (
          <button
            type="button"
            onClick={() =>
              comparing
                ? setPair(null, null)
                : setPair(revisions[1].revision, revisions[0].revision)
            }
            aria-pressed={comparing}
            className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${comparing ? 'border-tp-primary bg-tp-primary/5 text-tp-accent' : 'border-tp-hairline-strong text-tp-ink hover:border-tp-primary/40'}`}
          >
            <FiColumns className="h-3.5 w-3.5" aria-hidden="true" />
            {comparing ? 'Hide comparison' : 'Compare versions'}
          </button>
        )}
      </div>
      {comparing && revisions.length > 1 && <VersionCompare org={org} content={content} />}
      <section
        aria-labelledby="cd-revisions"
        className="rounded-xl border border-tp-hairline bg-tp-canvas"
      >
        <h2 id="cd-revisions" className="sr-only">
          Versions
        </h2>
        <ol aria-label={`Versions of ${item.name}`} className="divide-y divide-tp-hairline">
          {revisions.map((revision, index) => (
            <VersionRow
              key={revision.id}
              org={org}
              slug={item.slug}
              revision={revision}
              previous={revisions[index + 1]}
              latest={index === 0}
              shown={revision.revision === shown}
              runHref={canCreate ? runOf(revision.revision) : null}
              onCompare={setPair}
            />
          ))}
        </ol>
      </section>
    </div>
  );
}
