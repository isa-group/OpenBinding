// Adapted from SPHERE frontend/src/modules/pricing/pages/list/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the public compositions on the resource list view, with the kind and range filters; OpenBinding's title.

import { useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import ResourceListView from '../../../core/components/resource-list-view';
import { compositionPath } from '../../../../routes/paths/compositions';
import { useCompositionsApi, type PublicCompositionView } from '../../api/compositionsApi';
import CompositionCard from '../../components/composition-card';
import { KIND_FILTER, RANGE_FILTERS } from '../../components/composition-card/filters';

const ROWS = 4;
const COLS = 3;
const PER_PAGE = ROWS * COLS;

export default function CompositionListPage() {
  const { getPublicCompositions } = useCompositionsApi();

  const fetchItems = useCallback(
    async (params: Record<string, string>, signal: AbortSignal) => {
      const page = await getPublicCompositions(params, signal);
      return { items: page.compositions, total: page.total, facets: page.facets };
    },
    [getPublicCompositions]
  );

  return (
    <>
      <Helmet>
        <title>OpenBinding - Public compositions</title>
      </Helmet>
      <ResourceListView<PublicCompositionView>
        fetchItems={fetchItems}
        itemKey={item => `${item.organization.slug}/${item.slug}`}
        renderItem={item => (
          <CompositionCard data={item} to={compositionPath(item.organization.slug, item.slug)} />
        )}
        title="Public compositions"
        subtitle="Browse every public service composition in OpenBinding."
        noun={['composition', 'compositions']}
        perPage={PER_PAGE}
        choiceFilters={[KIND_FILTER]}
        rangeFilters={RANGE_FILTERS}
      />
    </>
  );
}
