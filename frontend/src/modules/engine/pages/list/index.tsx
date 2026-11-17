// Adapted from SPHERE frontend/src/modules/pricing/pages/list/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the engine revisions on the resource list view, titled "Engines", with OpenBinding's Family, Mode, Capability and
// Visibility filters read from the catalog the reader can see. The gateway answers the whole catalog at once, so the search,
// the filters and the page are applied here. A visitor sees the public engines; a signed-in account also its private ones,
// with what the gateway says about their registration, and the links to its own engines and to register one. A block alert
// says whose engines are shown, and a rejected session (401) that fell back to the public list says so.

import { useCallback, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { HttpError } from '../../../core/api/http';
import BlockAlert from '../../../core/components/block-alert';
import ResourceListView, { type ChoiceFilter } from '../../../core/components/resource-list-view';
import { useAuth } from '../../../auth/hooks/useAuth';
import { MY_ENGINES_PATH, registerEnginePath } from '../../../../routes/paths/engines';
import {
  useEnginesApi,
  type EngineCatalogEntry,
  type EngineRegistrationRevision,
  type EngineRevision,
  type EnginesApi,
} from '../../api/enginesApi';
import {
  catalogFilterOptions,
  engineRows,
  filterRows,
  type EngineRow,
} from '../../api/enginesModel';
import EngineCard from '../../components/engine-card';

const PER_PAGE = 12;

interface CatalogData {
  engines: EngineCatalogEntry[];
  fellBackToPublic: boolean;
  revisions: EngineRevision[];
  registrations: EngineRegistrationRevision[];
}

/** Public engines for a visitor; for a signed-in account the visible list plus what the gateway says about each revision. */
async function loadCatalog(api: EnginesApi, signedIn: boolean): Promise<CatalogData> {
  try {
    if (!signedIn)
      return {
        engines: await api.getPublicEngines(),
        fellBackToPublic: false,
        revisions: [],
        registrations: [],
      };
    const catalog = await api.getCatalogEngines();
    if (catalog.fellBackToPublic) return { ...catalog, revisions: [], registrations: [] };
    // Visibility and publication are extras: the list is useful without them.
    const [revisions, registrations] = await Promise.all([
      api.engineRevisions().catch(() => []),
      api.listEngineRegistrations().catch(() => []),
    ]);
    return { ...catalog, revisions, registrations };
  } catch (error) {
    if (error instanceof HttpError && error.status === 403)
      throw new Error(
        'This API key can’t list engines (403 · insufficient_api_key_permission). Missing permission: engines:read. A key is always limited to what you choose when you create it; create a key that includes this permission. Engines outside a key’s exact list answer 404, so they never appear.'
      );
    throw error;
  }
}

const list = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : []);

/** `/engines`: every engine revision the reader can see, as SPHERE's list of pricings. */
export default function EngineListPage() {
  const api = useEnginesApi();
  const { user } = useAuth();
  const username = user?.username ?? null;
  const [data, setData] = useState<CatalogData | null>(null);
  // One catalog per reader: the list view's pages and filters read it again from here; a failed one is asked for again.
  const loaded = useRef<{ key: string; promise: Promise<CatalogData>; failed: boolean } | null>(
    null
  );

  const catalog = useCallback(() => {
    const key = username ?? '';
    const current = loaded.current;
    if (current && current.key === key && !current.failed) return current.promise;
    const entry = { key, promise: loadCatalog(api, username !== null), failed: false };
    loaded.current = entry;
    entry.promise.then(
      answer => {
        if (loaded.current === entry) setData(answer);
      },
      () => {
        entry.failed = true;
      }
    );
    return entry.promise;
  }, [api, username]);

  const rowsOf = useCallback(
    (answer: CatalogData): EngineRow[] =>
      engineRows(answer.engines, {
        username,
        revisions: answer.revisions,
        registrations: answer.registrations,
      }),
    [username]
  );

  const fetchItems = useCallback(
    async (params: Record<string, string>) => {
      const rows = filterRows(rowsOf(await catalog()), {
        q: params.q,
        families: list(params.family),
        modes: list(params.mode),
        capabilities: list(params.capability),
        visibility: list(params.visibility),
      });
      const offset = Number(params.offset) || 0;
      const limit = Number(params.limit) || PER_PAGE;
      return { items: rows.slice(offset, offset + limit), total: rows.length };
    },
    [catalog, rowsOf]
  );

  const filters: ChoiceFilter[] = useMemo(() => {
    const options = catalogFilterOptions(data ? rowsOf(data) : []);
    return [
      { param: 'family', label: 'Family', options: options.families },
      { param: 'mode', label: 'Mode', options: options.modes },
      { param: 'capability', label: 'Capability', options: options.capabilities },
      { param: 'visibility', label: 'Visibility', options: options.visibilities },
    ].filter(filter => filter.options.length > 0);
  }, [data, rowsOf]);

  const fellBack = Boolean(data?.fellBackToPublic);
  const banner = fellBack ? (
    <BlockAlert variant="warning">
      Your session expired (401), so the catalog fell back to the public view. Your private engines
      are hidden until you{' '}
      <Link to="/authentication" className="cursor-pointer font-medium underline">
        log in
      </Link>{' '}
      again.
    </BlockAlert>
  ) : user ? (
    <BlockAlert variant="info">
      Showing engines visible to your account: public revisions plus private ones you own. API keys
      see only the engines in their exact list.
    </BlockAlert>
  ) : (
    <BlockAlert variant="info">
      Showing public engines.{' '}
      <Link to="/authentication" className="cursor-pointer font-medium underline">
        Log in
      </Link>{' '}
      to also see private engines you own.
    </BlockAlert>
  );

  return (
    <>
      <Helmet>
        <title>OpenBinding - Engines</title>
      </Helmet>
      <ResourceListView<EngineRow>
        key={username ?? 'visitor'}
        fetchItems={fetchItems}
        itemKey={row => row.key}
        renderItem={row => <EngineCard row={row} />}
        title="Engines"
        subtitle="Every engine is addressed by its exact identity: namespace, name and version. Pick the revision and mode you’ll run or study."
        noun={['engine revision', 'engine revisions']}
        perPage={PER_PAGE}
        ownerFilter={false}
        choiceFilters={filters}
        banner={banner}
        actions={
          user && (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={MY_ENGINES_PATH}
                className="flex cursor-pointer items-center rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface"
              >
                My engines
              </Link>
              <Link
                to={registerEnginePath()}
                className="flex cursor-pointer items-center rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
              >
                Register engine
              </Link>
            </div>
          )
        }
      />
    </>
  );
}
