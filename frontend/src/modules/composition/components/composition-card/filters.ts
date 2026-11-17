// The filters every composition list offers beside the owners: the kinds and the gateway's three ranges.

import type { ChoiceFilter, RangeFilter } from '../../../core/components/resource-list-view';
import { KIND_OPTIONS } from '../../../core/utils/composition/kinds';

export const KIND_FILTER: ChoiceFilter = {
  param: 'kinds',
  label: 'Kind',
  options: KIND_OPTIONS.map(kind => ({ value: kind.id, label: kind.label })),
};

export const RANGE_FILTERS: RangeFilter[] = [
  { name: 'tasks', label: 'Tasks' },
  { name: 'providers', label: 'Providers' },
  { name: 'cost', label: 'Cost', format: value => value.toLocaleString('en') },
];
