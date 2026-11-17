// Archive or restore a composition from a list: read its revision, then change it with `If-Match`, as every write does. A
// change refused because someone else changed it first offers the reload (SPHERE's offerReloadIfChanged).

import { useCallback } from 'react';
import { readApiError } from '../../core/api/errors';
import { SYSTEM_TOAST } from '../../core/contexts/toastKinds';
import { useToast } from '../../core/contexts/useToast';
import customAlert from '../../core/utils/custom-alert';
import { offerReloadIfChanged } from '../../core/utils/offer-reload';
import { compositionsApi } from '../api/compositionsApi';

export function useArchiveComposition(onChanged: () => void) {
  const { addToast } = useToast();
  return useCallback(
    async (org: string, slug: string, name: string, archived: boolean) => {
      try {
        const { etag } = await compositionsApi.get(org, slug);
        await compositionsApi.update(org, slug, { archived }, etag);
        addToast({
          kind: SYSTEM_TOAST,
          title: archived ? 'Composition archived' : 'Composition restored',
          message: archived
            ? `${name} is archived: it leaves the active list and keeps its versions.`
            : `${name} is active again.`,
        });
        onChanged();
      } catch (caught) {
        if (offerReloadIfChanged(caught, { resource: name, reload: onChanged })) return;
        void customAlert(readApiError(caught).message, 'error');
      }
    },
    [addToast, onChanged]
  );
}
