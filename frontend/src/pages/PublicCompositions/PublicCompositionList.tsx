// Design follows SPHERE frontend/src/modules/pricing/pages/list/index.tsx (revision 73779a8a); no code copied
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { Action } from '../../modules/core/components/action-button';
import { EmptyState } from '../../modules/core/components/empty-state';
import { FilterPills } from '../../modules/core/components/filter-pills';
import { Notice } from '../../modules/core/components/notice';
import { PageHeader } from '../../modules/core/components/page-header';
import { Skeleton } from '../../modules/core/components/skeleton';
import { compositionsApi } from '../../modules/core/utils/composition/api';
import { KIND_OPTIONS, isKind, kindLabel } from '../../modules/core/utils/composition/kinds';
import { valueStatus } from '../../modules/core/utils/composition/values';
import { publicCompositionsPath, showcasePath } from '../../routes/paths/compositions';
import { classifyAuthError, marker } from '../../modules/core/api/errors';
import type { PublicCompositionList as PublicList } from '../../modules/core/api/types';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ValueBadge } from '../../modules/core/components/value-badge/ValueBadge';
import './PublicCompositions.css';

/** How many compositions one page lists. */
const PUBLIC_PAGE_SIZE = 24;
/** How long the search waits after the last keystroke before it asks again. */
const SEARCH_DELAY = 300;

const KIND_PILLS = [{ id: 'all', label: 'All kinds' }, ...KIND_OPTIONS];

type Row = PublicList['compositions'][number];

/** The page the address names: a whole number from 1, the first one otherwise. */
function pageOf(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 1 ? page : 1;
}

function CompositionCard({ row }: { row: Row }) {
  const updated = formatDate(row.updated_at);
  return (
    <li>
      <article className="pcl-card">
        <span className="pcl-card-meta">
          {kindLabel(row.kind)} · {row.organization.name}
        </span>
        <h2 className="pcl-card-title">
          <Link to={showcasePath(row.organization.slug, row.slug)} viewTransition>
            {row.name}
          </Link>
        </h2>
        {row.description && <p className="pcl-card-description">{row.description}</p>}
        <dl className="pcl-card-facts">
          <div>
            <dt>Latest version</dt>
            <dd>
              <code>{row.latest_version.label}</code>
              {row.version_count > 1 ? ` of ${row.version_count}` : ''}
            </dd>
          </div>
          <div>
            <dt>Values</dt>
            <dd>
              <ValueBadge status={valueStatus(row.latest_version)} />
            </dd>
          </div>
          {updated && (
            <div>
              <dt>Updated</dt>
              <dd>{updated}</dd>
            </div>
          )}
        </dl>
      </article>
    </li>
  );
}

/**
 * Public compositions (`pub-compositions`, `/compositions`): the compositions every organization has made public, newest change first,
 * each a card that opens its public page. Kind, search text and page live in the address, so a list can be shared and a sign-in comes
 * back to it. Anybody reads it; nothing here says that a private composition exists.
 */
export function PublicCompositionList() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const kindParam = params.get('kind');
  const kind = isKind(kindParam) ? kindParam : undefined;
  const q = params.get('q') ?? '';
  const page = pageOf(params.get('page'));
  const [text, setText] = useState(q);
  const filtered = Boolean(kind) || q.trim() !== '';

  const show = (next: { kind?: typeof kind; q?: string; page?: number }) =>
    void navigate(publicCompositionsPath({ kind, q, ...next }), { replace: true });

  useEffect(() => {
    if (text.trim() === q.trim()) return undefined;
    const timer = window.setTimeout(
      () => void navigate(publicCompositionsPath({ kind, q: text }), { replace: true }),
      SEARCH_DELAY
    );
    return () => window.clearTimeout(timer);
  }, [text, q, kind, navigate]);

  const list = useResource(`public-compositions:${kind ?? 'all'}:${q.trim()}:${page}`, () =>
    compositionsApi.publicList({
      kind,
      q: q.trim() || undefined,
      limit: PUBLIC_PAGE_SIZE,
      offset: (page - 1) * PUBLIC_PAGE_SIZE,
    })
  );
  const rows = list.data?.compositions ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PUBLIC_PAGE_SIZE));
  const failure = list.status === 'error' ? classifyAuthError(list.error) : null;
  const ready = list.status === 'ready';

  return (
    <div className="pcl-page">
      <PageHeader
        eyebrow="Compositions"
        title="Public compositions"
        lede="Compositions their organizations have made public: what each one binds, the values that binding gives and how far they can be trusted. Open one to read it, or fork it into an organization of yours."
      />

      <div className="pcl-toolbar">
        <div className="ui-field pcl-search">
          <label htmlFor="pcl-search" className="sr-only">
            Search public compositions
          </label>
          <input
            id="pcl-search"
            type="search"
            value={text}
            placeholder="Search by name or address…"
            onChange={event => setText(event.target.value)}
          />
        </div>
        <FilterPills
          ariaLabel="Kind"
          options={KIND_PILLS}
          value={kind ?? 'all'}
          onChange={id => show({ kind: isKind(id) ? id : undefined, page: 1 })}
        />
      </div>

      <div className="pcl-results" aria-live="polite" aria-busy={list.status === 'loading'}>
        {list.status === 'loading' && (
          <div role="status" className="pcl-grid">
            <span className="sr-only">Loading public compositions…</span>
            <Skeleton variant="card" />
            <Skeleton variant="card" />
            <Skeleton variant="card" />
          </div>
        )}
        {failure && (
          <Notice
            tone="error"
            action={
              <Action variant="secondary" size="sm" onClick={list.reload}>
                Retry
              </Action>
            }
          >
            {`Public compositions couldn’t be loaded${marker(failure)}.`}
          </Notice>
        )}

        {ready && total === 0 && !filtered && (
          <EmptyState dashed icon={<Layers />} title="No public compositions yet">
            When an organization makes one of its compositions public, it is listed here for anybody
            to read and fork.
          </EmptyState>
        )}
        {ready && total === 0 && filtered && (
          <EmptyState icon={<Layers />} title="No public composition matches">
            Nothing public has{' '}
            {[
              kind && `the kind ${kindLabel(kind)}`,
              q.trim() && `“${q.trim()}” in its name or address`,
            ]
              .filter(Boolean)
              .join(' and ')}
            .
          </EmptyState>
        )}
        {ready && total > 0 && rows.length === 0 && (
          <EmptyState
            icon={<Layers />}
            title="Nothing on this page"
            action={
              <Action to={publicCompositionsPath({ kind, q })} variant="secondary">
                First page
              </Action>
            }
          >
            {`There ${total === 1 ? 'is 1 public composition' : `are ${total} public compositions`}; this page lists none of them.`}
          </EmptyState>
        )}

        {rows.length > 0 && (
          <section className="pcl-section" aria-label="Public compositions">
            <span className="pcl-count">
              {total === 1 ? '1 composition' : `${total} compositions`}
            </span>
            <ul className="pcl-grid">
              {rows.map(row => (
                <CompositionCard key={`${row.organization.slug}/${row.slug}`} row={row} />
              ))}
            </ul>
          </section>
        )}

        {ready && pages > 1 && (
          <nav className="pcl-paging" aria-label="Pages">
            {page > 1 ? (
              <Action
                to={publicCompositionsPath({ kind, q, page: page - 1 })}
                variant="secondary"
                size="sm"
              >
                Previous
              </Action>
            ) : (
              <span />
            )}
            <span className="pcl-count">
              Page {page} of {pages}
            </span>
            {page < pages ? (
              <Action
                to={publicCompositionsPath({ kind, q, page: page + 1 })}
                variant="secondary"
                size="sm"
              >
                Next
              </Action>
            ) : (
              <span />
            )}
          </nav>
        )}
      </div>
    </div>
  );
}
