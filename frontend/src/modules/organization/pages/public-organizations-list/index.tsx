// Adapted from SPHERE frontend/src/modules/organization/pages/public-organizations-list/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's public organizations (root organizations that publish a composition), named by slug; the page and
// the search kept in the address; a Retry on a failed load; the card's arrow on the accent.

import { useDeferredValue, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { FiArrowLeft, FiArrowRight, FiArrowUpRight, FiSearch } from 'react-icons/fi';
import { Link, useSearchParams } from 'react-router-dom';
import { isAbortError } from '../../../core/api/http';
import OrgAvatar from '../../../core/components/org-avatar';
import {
  avatarProps,
  getPublicOrganizations,
  type PublicOrganization,
} from '../../api/organizationsApi';
import { orgPath } from '../../types/paths';

const PAGE_SIZE = 12;

function OrganizationCard({ organization }: { organization: PublicOrganization }) {
  return (
    <Link
      to={orgPath(organization.slug)}
      className="group flex min-h-56 cursor-pointer flex-col rounded-xl border border-tp-hairline bg-tp-canvas p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-tp-hairline-strong hover:shadow-elevation-2"
    >
      <div className="flex items-start justify-between gap-4">
        <OrgAvatar name={organization.name} {...avatarProps(organization.avatar)} size={48} />
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-tp-hairline text-tp-steel transition-colors group-hover:border-tp-accent group-hover:bg-tp-accent group-hover:text-tp-on-primary">
          <FiArrowUpRight className="h-4 w-4" />
        </span>
      </div>

      <div className="mt-6 flex-1">
        <p className="text-[11px] font-semibold tracking-[0.16em] text-tp-accent uppercase">
          Root organization
        </p>
        <h2 className="mt-2 text-xl font-medium tracking-tight text-tp-ink transition-colors group-hover:text-tp-accent">
          {organization.name}
        </h2>
        <p className="mt-1 text-sm text-tp-steel">@{organization.slug}</p>
        <p className="mt-4 line-clamp-2 text-sm leading-6 text-tp-slate">
          {organization.description ||
            'Explore this organization and the compositions it publishes in OpenBinding.'}
        </p>
      </div>
    </Link>
  );
}

function OrganizationGridSkeleton() {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="h-56 animate-pulse rounded-xl border border-tp-hairline bg-tp-surface"
        />
      ))}
    </div>
  );
}

export default function PublicOrganizationsPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [organizations, setOrganizations] = useState<PublicOrganization[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const deferredSearch = useDeferredValue(search.trim());
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const update = (next: { q?: string; page?: number }) =>
    setParams(
      current => {
        const merged = new URLSearchParams(current);
        if (next.q !== undefined) {
          if (next.q) merged.set('q', next.q);
          else merged.delete('q');
        }
        const nextPage = next.page ?? page;
        if (nextPage > 1) merged.set('page', String(nextPage));
        else merged.delete('page');
        return merged;
      },
      { replace: true }
    );

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SPHERE's loading flag, set when the request starts
    setIsLoading(true);
    setError('');

    getPublicOrganizations(
      { q: deferredSearch || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
      controller.signal
    )
      .then(result => {
        setOrganizations(result.items);
        setTotal(result.total);
      })
      .catch(fetchError => {
        if (isAbortError(fetchError)) return;
        setOrganizations([]);
        setTotal(0);
        setError('Public organizations could not be loaded. Please try again.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [deferredSearch, page, attempt]);

  return (
    <>
      <Helmet>
        <title>OpenBinding - Public organizations</title>
        <meta
          name="description"
          content="Explore the root organizations that publish compositions in OpenBinding."
        />
      </Helmet>

      <section className="mx-auto w-full max-w-7xl px-4 py-10 md:px-6 md:py-16">
        <div className="grid gap-8 border-b border-tp-hairline pb-10 lg:grid-cols-[1fr_24rem] lg:items-end">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold tracking-[0.2em] text-tp-accent uppercase">
              Explore OpenBinding
            </p>
            <h1 className="mt-4 font-display text-4xl leading-tight tracking-tight text-tp-ink sm:text-5xl lg:text-6xl">
              Public organizations
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-tp-slate sm:text-lg">
              Discover the root organizations publishing compositions, the problems they bind and
              the studies behind them.
            </p>
          </div>

          <label className="block">
            <span className="sr-only">Search organizations</span>
            <span className="relative block">
              <FiSearch className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-tp-steel" />
              <input
                type="search"
                value={search}
                onChange={event => update({ q: event.target.value, page: 1 })}
                placeholder="Search organizations..."
                className="h-12 w-full rounded-lg border border-tp-hairline-strong bg-tp-canvas pr-4 pl-11 text-sm text-tp-ink transition-colors outline-none placeholder:text-tp-muted focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/10"
              />
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-4 py-7">
          <p className="text-sm text-tp-steel" aria-live="polite">
            {isLoading
              ? 'Finding organizations…'
              : `${total} ${total === 1 ? 'organization' : 'organizations'}`}
          </p>
          <p className="text-xs font-medium tracking-[0.14em] text-tp-steel uppercase">
            Root level only
          </p>
        </div>

        {isLoading ? (
          <OrganizationGridSkeleton />
        ) : error ? (
          <div
            className="flex flex-col items-center gap-4 rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center text-sm text-red-700"
            role="alert"
          >
            <p>{error}</p>
            <button
              type="button"
              onClick={() => setAttempt(value => value + 1)}
              className="cursor-pointer rounded-md border border-red-300 bg-tp-canvas px-4 py-2 font-medium text-red-700 transition-colors hover:bg-red-100"
            >
              Retry
            </button>
          </div>
        ) : organizations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-tp-hairline-strong bg-tp-surface px-6 py-16 text-center">
            <h2 className="text-lg font-medium text-tp-ink">No organizations found</h2>
            <p className="mt-2 text-sm text-tp-steel">
              {deferredSearch
                ? 'Try a different search term.'
                : 'No organization publishes a composition yet.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {organizations.map(organization => (
              <OrganizationCard key={organization.id} organization={organization} />
            ))}
          </div>
        )}

        {totalPages > 1 ? (
          <nav
            className="mt-10 flex items-center justify-between border-t border-tp-hairline pt-6"
            aria-label="Organization pages"
          >
            <button
              type="button"
              onClick={() => update({ page: Math.max(1, page - 1) })}
              disabled={page === 1}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FiArrowLeft className="h-4 w-4" />
              Previous
            </button>
            <span className="text-sm text-tp-steel">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => update({ page: Math.min(totalPages, page + 1) })}
              disabled={page === totalPages}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-tp-hairline-strong px-4 py-2 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
              <FiArrowRight className="h-4 w-4" />
            </button>
          </nav>
        ) : null}
      </section>
    </>
  );
}
