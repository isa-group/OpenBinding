// Adapted from SPHERE frontend/src/modules/pricing/pages/user-list/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the compositions the account reads as a member, across its organizations, on the resource list view with the
// owner, kind and range filters; a card the account may change offers Archive or Restore; a "New composition" button.

import { useCallback, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import ResourceListView from '../../../core/components/resource-list-view';
import { Link } from 'react-router-dom';
import Iconify from '../../../core/components/iconify';
import { compositionPath, newCompositionPath } from '../../../../routes/paths/compositions';
import { useCompositionsApi, type CompositionView } from '../../api/compositionsApi';
import CompositionCard from '../../components/composition-card';
import { KIND_FILTER, RANGE_FILTERS } from '../../components/composition-card/filters';
import { archiveMenu } from '../../components/composition-card/menu';
import { useArchiveComposition } from '../../hooks/useArchiveComposition';
import { roleAtLeast, useCompositionRole } from '../../hooks/useCompositionRole';

const ROWS = 4;
const COLS = 3;
const PER_PAGE = ROWS * COLS;

export default function UserCompositionListPage() {
  const { getMyCompositions } = useCompositionsApi();
  const roleIn = useCompositionRole();
  const [refreshKey, setRefreshKey] = useState(0);
  const archive = useArchiveComposition(useCallback(() => setRefreshKey(key => key + 1), []));

  const fetchItems = useCallback(
    async (params: Record<string, string>, signal: AbortSignal) => {
      const page = await getMyCompositions(params, signal);
      return { items: page.compositions, total: page.total, facets: page.facets };
    },
    [getMyCompositions]
  );

  return (
    <>
      <Helmet>
        <title>OpenBinding - My compositions</title>
      </Helmet>
      <ResourceListView<CompositionView>
        fetchItems={fetchItems}
        refreshKey={refreshKey}
        itemKey={item => item.id}
        renderItem={item => (
          <CompositionCard
            data={item}
            showVisibility
            to={compositionPath(item.organization.slug, item.slug)}
            menuItems={archiveMenu(
              item,
              roleAtLeast(roleIn(item.organization.slug), 'MEMBER'),
              archive
            )}
          />
        )}
        title="My compositions"
        subtitle="The compositions of the organizations you belong to."
        noun={['composition', 'compositions']}
        perPage={PER_PAGE}
        choiceFilters={[KIND_FILTER]}
        rangeFilters={RANGE_FILTERS}
        actions={
          <Link
            to={newCompositionPath()}
            className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
          >
            <Iconify icon="mdi:plus" width={16} />
            New composition
          </Link>
        }
      />
    </>
  );
}
