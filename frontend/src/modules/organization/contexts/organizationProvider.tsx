import type { ReactNode } from 'react';
import { useOrganizationManager } from '../hooks/useOrganization';
import OrganizationContext from './organizationContext';

/** The signed-in person's organizations, for the whole interface (SPHERE's App.tsx keeps this provider inline). */
export function OrganizationProvider({ children }: { children: ReactNode }) {
  const value = useOrganizationManager();
  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}
