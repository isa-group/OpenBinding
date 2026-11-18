// Pattern only, after SPHERE frontend/src/modules/organization/pages/organization-detail/index.tsx (revision 73779a8a), whose
// beta tabs (TAB_META's `beta`) this one follows, https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García
// Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// The organization's connections, on the tab card recipe: its SPHERE key (SphereKeyCard). SPACE follows with F8.

import { useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import BlockAlert from '../../../core/components/block-alert';
import { useResource } from '../../../core/hooks/useResource';
import TabCard from '../../pages/organization-detail/components/TabCard';
import { useConnectionsApi } from '../../api/connectionsApi';
import SphereKeyCard from './SphereKeyCard';

/** The Connections tab (beta, ADMIN): the organization's links to the services it reads pricings from. */
export default function ConnectionsTab({ org }: { org: string }) {
  const api = useConnectionsApi();
  const [etag, setEtag] = useState<string | null>(null);
  const connections = useResource(`organization-connections:${org}`, () => api.list(org));
  const sphere = connections.data?.find(connection => connection.kind === 'sphere') ?? null;

  return (
    <TabCard
      id="connections"
      title="Connections"
      lede="The services this organization reads pricings from, with its own credentials."
    >
      {connections.status === 'error' ? (
        <div className="flex flex-col items-start gap-3">
          <BlockAlert
            variant="error"
            message={`The connections couldn’t be read${readApiError(connections.error).message ? `: ${readApiError(connections.error).message}` : '.'}`}
          />
          <button
            type="button"
            onClick={connections.reload}
            className="cursor-pointer rounded-[8px] border border-tp-hairline-strong px-3.5 py-2 text-xs font-medium text-tp-ink hover:bg-tp-surface"
          >
            Try again
          </button>
        </div>
      ) : connections.status === 'loading' ? (
        <p role="status" className="text-sm text-tp-steel">
          Reading the connections…
        </p>
      ) : (
        <SphereKeyCard
          connection={sphere}
          etag={etag}
          onSave={async (key, ifMatch) => {
            const saved = await api.putSphere(org, key, ifMatch);
            setEtag(saved.etag);
            connections.reload();
          }}
          onRemove={async () => {
            await api.removeSphere(org);
            setEtag(null);
            connections.reload();
          }}
          onReload={connections.reload}
        />
      )}
      <div className="flex flex-col gap-2 text-xs text-tp-steel">
        <p>
          Public SPHERE pricings need no key. A key reads the private pricings of the SPHERE
          organizations it may act in: a key with MANAGEMENT or ALL of an organization’s owner or
          administrator reads all of them; a VIEW key reads only those it was granted.
        </p>
        <p>
          “Connect SPHERE” with a SPHERE sign-in arrives with publishing the composition’s offering;
          until then the connection is a key.
        </p>
      </div>
    </TabCard>
  );
}
