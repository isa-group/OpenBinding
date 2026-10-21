import { useOutletContext, useParams } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';

export interface RouteOrganization {
  context: PlatformOutletContext;
  slug: string;
  /** The organization the address names, when the account can see it. */
  organization?: Organization;
  /** The workspace is still loading and the address has not been found yet. */
  waiting: boolean;
}

/**
 * The organization named by `/app/:org`. The workspace shell falls back to the first organization when the
 * address names none the account can see; a screen about one organization must not, so it asks the route.
 */
export function useRouteOrganization(): RouteOrganization {
  const context = useOutletContext<PlatformOutletContext>();
  const { org: slug = '' } = useParams();
  const organization = context.organizations.find((item) => item.slug === slug);
  return { context, slug, organization, waiting: !organization && context.loading };
}
