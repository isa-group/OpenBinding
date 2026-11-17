// Pattern only, after SPHERE frontend/src/modules/pricing/components/yaml-source-panel/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the Source tab of the problem page: the version on show as the instance that describes it, the package as uploaded
// and the form the engines read, each with its fingerprint, in a segmented Instance / Package / Compiled viewer over
// OpenBinding's source views instead of one YAML panel (the package is opened only when its view is chosen); then the
// fingerprint of every file and resource, the language the compiler read and what the engines receive.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  problemsApi,
  type CompilationIr,
  type Problem,
  type ProblemCompilation,
  type ProblemRevision,
  type ProblemRevisionDetail,
} from '../../api/problemsApi';
import { parseBindingSpace } from '../../../../components/BindingSpaceBadge/bindingSpace';
import { SourceView } from '../../../../components/rendering/SourceView';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { useCopy } from '../../../core/hooks/useCopy';
import { classifyAuthError, marker, type AuthFailure } from '../../../core/api/errors';
import type { ProblemFacts } from '../../../core/api/types';
import { problemFactsApi, rangeCandidates } from '../../../core/utils/problem/facts';
import { formatBytes } from '../../../../utils/format';
import { formatFeature } from '../../../../utils/featureRange';
import { useResource } from '../../../../utils/useResource';
import { sourceFailureKind } from '../../utils/problemErrors';
import { powerText } from '../../utils/problemsModel';
import { readZipArchive, type ZipArchive } from '../../utils/zipExplorer';

type Compiled =
  | { state: 'ok'; compilation: ProblemCompilation; ir: CompilationIr; facts: ProblemFacts }
  | { state: 'failed'; failure: AuthFailure };

type Segment = 'instance' | 'package' | 'compiled';

const SEGMENTS: ReadonlyArray<{ key: Segment; label: string; what: string }> = [
  { key: 'instance', label: 'Instance', what: 'What was described (instance.json)' },
  { key: 'package', label: 'Package', what: 'The .bim.zip as uploaded' },
  { key: 'compiled', label: 'Compiled form', what: 'What engines read (installed toolchain)' },
];

const CARD = 'rounded-xl border border-tp-hairline bg-tp-canvas p-4';
const H2 = 'text-lg font-medium text-tp-ink';
const linkButton = 'cursor-pointer text-xs font-medium text-tp-accent hover:underline';

function CopyButton({ text, label, copyKey }: { text: string; label: string; copyKey: string }) {
  const { copy, status } = useCopy();
  return (
    <button
      type="button"
      className={linkButton}
      onClick={() => void copy(text, copyKey)}
      aria-label={label}
    >
      {status(copyKey) === 'copied'
        ? 'Copied'
        : status(copyKey) === 'failed'
          ? 'Copy failed'
          : 'Copy digest'}
    </button>
  );
}

function Pins({ detail }: { detail: ProblemRevisionDetail }) {
  const files = detail.files.map(file => [file.path, file.digest] as const);
  const resources = Object.entries(detail.resource_digests);
  const table = (caption: string, what: string, rows: ReadonlyArray<readonly [string, string]>) => (
    <DataTable label={caption} minWidth={320} caption={caption}>
      <thead>
        <tr>
          <th scope="col">{what}</th>
          <th scope="col">Fingerprint</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, digest]) => (
          <tr key={name}>
            <th scope="row">
              <code className="font-mono">{name}</code>
            </th>
            <td>
              <CopyButton
                text={digest}
                label={`Copy digest of ${name}`}
                copyKey={`${what}:${name}`}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-tp-link">
        Per-file and per-resource fingerprints
      </summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {table(`Files (${files.length})`, 'File', files)}
        {table(`Resources (${resources.length})`, 'Resource', resources)}
      </div>
    </details>
  );
}

/** The package as uploaded: its files, one shown at a time (the archive is read only when this view opens). */
function PackageFiles({
  org,
  problem,
  revision,
}: {
  org: string;
  problem: string;
  revision: ProblemRevision;
}) {
  const [file, setFile] = useState<string | null>(null);
  const key = `${org}/${problem}/${revision.id}`;
  const archive = useResource<ZipArchive>(`archive:${key}`, async () =>
    readZipArchive(await problemsApi.source(org, problem, revision.revision))
  );
  const entries = (archive.data ?? archive.stale)?.entries.filter(entry => !entry.dir) ?? [];
  const chosen = entries.find(entry => entry.path === file) ?? entries[0];
  const text = useResource<string>(`archive-file:${key}:${chosen?.path ?? ''}`, async () =>
    chosen ? chosen.readText() : ''
  );
  if (archive.status === 'loading') return <Skeleton variant="tile" />;
  if (archive.status === 'error')
    return (
      <Notice
        tone="warning"
        action={
          <Action variant="secondary" size="sm" onClick={archive.reload}>
            Retry
          </Action>
        }
      >
        The package couldn’t be opened{marker(classifyAuthError(archive.error))}.
      </Notice>
    );
  return (
    <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
      <ul aria-label="Files in the package" className="flex flex-col gap-1">
        {entries.map(entry => (
          <li key={entry.path}>
            <button
              type="button"
              aria-pressed={entry.path === chosen?.path}
              onClick={() => setFile(entry.path)}
              className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                entry.path === chosen?.path
                  ? 'bg-tp-primary/10 text-tp-accent'
                  : 'text-tp-ink hover:bg-tp-surface'
              }`}
            >
              <code className="font-mono [overflow-wrap:anywhere]">{entry.path}</code>
              <small className="shrink-0 text-tp-steel">
                {formatBytes(entry.size)?.split(' (')[0] ?? ''}
              </small>
            </button>
          </li>
        ))}
      </ul>
      {chosen && (
        <SourceView
          source={text.data ?? text.stale ?? ''}
          label={chosen.path}
          language={chosen.path.endsWith('.json') ? 'json' : 'text'}
          filename={chosen.name}
          maxHeight="30rem"
        />
      )}
    </div>
  );
}

function Summary({ analysis }: { analysis: Compiled | undefined }) {
  if (!analysis)
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Reading what the engines receive…</span>
        <Skeleton variant="tile" />
      </div>
    );
  if (analysis.state === 'failed' && analysis.failure.code === 'revision_not_recompilable') {
    return (
      <Notice tone="error">
        The installed toolchain refuses this package (422 · revision_not_recompilable), so it can’t
        be compiled again. The package and its fingerprints are still exact.
      </Notice>
    );
  }
  if (analysis.state === 'failed') {
    return (
      <Notice tone="warning">{`The gateway’s analysis of this version isn’t available right now${marker(analysis.failure)}.`}</Notice>
    );
  }
  const { compilation, facts } = analysis;
  const combos = parseBindingSpace(compilation.analysis.bindingSpace);
  const figures = [
    { value: String(compilation.analysis.tasks), label: 'tasks' },
    { value: String(compilation.analysis.candidates), label: 'candidates' },
    { value: String(compilation.analysis.constraints), label: 'rules' },
    { value: String(facts.objectives.criteria.length), label: 'goal terms' },
    { value: powerText(compilation.analysis.bindingSpace), label: 'combinations' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="What the engines receive">
        {figures.map(figure => (
          <li key={figure.label} className="rounded-xl border border-tp-hairline bg-tp-canvas p-3">
            <b className="block text-lg font-semibold text-tp-ink">{figure.value}</b>
            <span className="text-[11px] text-tp-steel">{figure.label}</span>
          </li>
        ))}
      </ul>
      {combos.bigVal > 1n && (
        <span className="text-xs text-tp-steel">Exactly {combos.exact} possible bindings.</span>
      )}
      <span className="text-xs text-tp-steel">
        {compilation.compatible_modes.length === 1
          ? '1 engine mode can run it.'
          : `${compilation.compatible_modes.length} engine modes can run it.`}
      </span>
      <RangeNotice facts={facts} compilation={compilation} />
    </div>
  );
}

/** The ranges a package carries, and what that means for the engines: only a mode that declares interval values can run it. */
function RangeNotice({
  facts,
  compilation,
}: {
  facts: ProblemFacts;
  compilation: ProblemCompilation;
}) {
  const ranged = rangeCandidates(facts);
  if (ranged.length === 0) return null;
  const modes = compilation.compatible_modes;
  const refused = modes
    ? modes.filter(
        mode =>
          typeof mode === 'object' &&
          mode !== null &&
          (mode as { compatible?: unknown }).compatible === false
      ).length
    : null;
  return (
    <section className="flex flex-col gap-2" aria-label="Range features">
      <Notice
        tone="warning"
        title={
          ranged.length === 1
            ? '1 candidate has range features'
            : `${ranged.length} candidates have range features`
        }
      >
        Engines that only accept single values can’t run it
        {refused ? ` (${refused} of ${modes?.length ?? 0} modes listed refuse it)` : ''}. Only a
        mode that declares interval values accepts ranges.{' '}
        <Link className="cursor-pointer underline" to="/engines">
          See the engines
        </Link>
      </Notice>
      <ul className="flex flex-col gap-1.5" aria-label="Candidates with ranges">
        {ranged.map(entry => (
          <li
            key={`${entry.task}/${entry.candidate}`}
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <code className="font-mono font-semibold">{entry.candidate}</code>
            {entry.features.map(feature => (
              <span
                key={feature.name}
                className="rounded-full border border-tp-hairline bg-tp-surface px-2 py-0.5 tabular-nums"
                title={formatFeature(feature.value, { long: true })}
              >
                {feature.name} {formatFeature(feature.value)}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The Source tab of the problem page, for the version on show. */
export default function SourceTab({
  org,
  item,
  revision,
}: {
  org: string;
  item: Problem;
  revision: ProblemRevision;
}) {
  const { copy, status } = useCopy();
  const [segment, setSegment] = useState<Segment>('package');
  const key = `${org}/${item.slug}/${revision.id}`;
  const detail = useResource<ProblemRevisionDetail>(`revision-detail:${key}`, () =>
    problemsApi.revision(org, item.slug, revision.revision)
  );
  const compiled = useResource<Compiled>(`compiled:${key}`, async () => {
    try {
      const compilation = await problemsApi.compilation(org, item.slug, revision.revision);
      // The IR is fetched for the compiled view only: what this tab reads is the facts.
      const [ir, facts] = await Promise.all([
        problemsApi.ir(org, item.slug, revision.revision, compilation.id),
        problemFactsApi.get(org, item.slug, revision.revision, compilation.id),
      ]);
      return { state: 'ok', compilation, ir, facts };
    } catch (caught) {
      return { state: 'failed', failure: classifyAuthError(caught) };
    }
  });

  const failure = detail.status === 'error' ? classifyAuthError(detail.error) : null;

  if (detail.status === 'loading') {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the source…</span>
        <Skeleton variant="card" />
        <Skeleton variant="panel" />
      </div>
    );
  }
  if (failure || !detail.data) {
    const kind = failure ? sourceFailureKind(failure) : 'missing';
    return (
      <>
        {kind === 'key' && (
          <Notice tone="warning">
            This API key doesn’t include “read problems” (403). Use a session or a key with that
            permission.
          </Notice>
        )}
        {kind === 'missing' && (
          <Notice tone="warning" title="Version not found">
            It may have been deleted with its problem. We answer the same way when you can’t see it
            (404).
          </Notice>
        )}
        {(kind === 'other' || kind === 'recompile') && failure && (
          <Notice
            tone="error"
            action={
              <Action variant="secondary" size="sm" onClick={detail.reload}>
                Retry
              </Action>
            }
          >
            The source couldn’t be loaded{marker(failure)}.
          </Notice>
        )}
      </>
    );
  }

  const data = detail.data;
  const ir = compiled.data?.state === 'ok' ? compiled.data.ir : null;
  const digests: Record<Segment, string | null> = {
    instance: data.instance_digest ?? null,
    package: data.package_digest,
    compiled: ir?.ir_digest ?? null,
  };
  const current = SEGMENTS.find(entry => entry.key === segment) ?? SEGMENTS[1];

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Source" className={CARD}>
        <div
          role="group"
          aria-label="Source to view"
          className="mb-4 inline-grid grid-cols-3 gap-1 rounded-xl bg-tp-surface p-1"
        >
          {SEGMENTS.map(entry => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={segment === entry.key}
              onClick={() => setSegment(entry.key)}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium transition-all ${
                segment === entry.key
                  ? 'border-tp-primary/30 bg-tp-canvas text-tp-ink shadow-sm'
                  : 'border-transparent text-tp-steel hover:text-tp-ink'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-tp-steel">
          <span>{current.what}</span>
          <span aria-hidden="true">·</span>
          <span>{digests[segment] ? 'fingerprint stored' : 'fingerprint not stored'}</span>
          {digests[segment] && (
            <CopyButton
              text={digests[segment]!}
              label={`Copy the ${current.label.toLowerCase()} fingerprint`}
              copyKey={`segment:${segment}`}
            />
          )}
        </p>
        {segment === 'instance' && (
          <SourceView
            source={data.document}
            label="instance.json"
            language="json"
            filename={`${item.slug}-v${revision.revision}-instance.json`}
            maxHeight="30rem"
          />
        )}
        {segment === 'package' && (
          <PackageFiles org={org} problem={item.slug} revision={revision} />
        )}
        {segment === 'compiled' &&
          (ir ? (
            <SourceView
              source={ir.ir as object}
              label="Compiled form (JSON)"
              language="json"
              filename={`${item.slug}-v${revision.revision}-compiled.json`}
              maxHeight="30rem"
            />
          ) : compiled.data ? (
            <Notice tone="warning">
              The compiled form isn’t available for this version
              {compiled.data.state === 'failed' ? marker(compiled.data.failure) : ''}.
            </Notice>
          ) : (
            <Skeleton variant="tile" />
          ))}
      </section>

      <section aria-labelledby="sd-fingerprints" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="sd-fingerprints" className={H2}>
            Fingerprints
          </h2>
          <Action
            variant="secondary"
            size="sm"
            onClick={() =>
              void copy(
                [
                  ...(data.instance_digest ? [`instance ${data.instance_digest}`] : []),
                  `package ${data.package_digest}`,
                  ...(ir ? [`compiled ${ir.ir_digest}`] : []),
                ].join('\n'),
                'all'
              )
            }
          >
            {status('all') === 'copied'
              ? 'Copied'
              : status('all') === 'failed'
                ? 'Copy failed'
                : 'Copy all fingerprints'}
          </Action>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {SEGMENTS.map(entry => {
            const digest = digests[entry.key];
            return (
              <div key={entry.key} className={`${CARD} flex flex-col gap-1`}>
                <span className="text-sm font-semibold text-tp-ink">{entry.label}</span>
                <span className="text-xs text-tp-slate">{digest ? 'Stored' : 'not stored'}</span>
                <span className="text-xs text-tp-steel">{entry.what}</span>
                {digest && (
                  <button
                    type="button"
                    className={`${linkButton} self-start`}
                    onClick={() => void copy(digest, entry.key)}
                    aria-label={`Copy full ${entry.label.toLowerCase()} fingerprint`}
                  >
                    {status(entry.key) === 'copied'
                      ? 'Copied'
                      : status(entry.key) === 'failed'
                        ? 'Copy failed'
                        : 'Copy full fingerprint'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <Pins detail={data} />
      </section>

      <section aria-labelledby="sd-language" className="flex flex-col gap-3">
        <h2 id="sd-language" className={H2}>
          Exact language used
        </h2>
        {compiled.data?.state === 'ok' &&
        Object.keys(compiled.data.compilation.resources).length > 0 ? (
          <DataTable label="Resources" caption="Resources" minWidth={480}>
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Role</th>
                <th scope="col">Kind</th>
                <th scope="col">Language</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(compiled.data.compilation.resources).map(([id, contract]) => (
                <tr key={id}>
                  <th scope="row">
                    <code className="font-mono">{id}</code>
                  </th>
                  <td>{contract.role ?? '—'}</td>
                  <td>{contract.kind ?? '—'}</td>
                  <td>{contract.apiVersion ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <p className="text-sm text-tp-steel">
            The compilation isn’t available, so the language it used can’t be listed.
          </p>
        )}
      </section>

      <section aria-labelledby="sd-engines" className="flex flex-col gap-3">
        <h2 id="sd-engines" className={H2}>
          What the engines receive
        </h2>
        <Summary analysis={compiled.data} />
      </section>
    </div>
  );
}
