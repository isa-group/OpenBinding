import { useAuth } from '../../../auth/hooks/useAuth';

interface InstitutionalAccount {
  institutional_email?: boolean | null;
  plan?: string | null;
}

export const INSTITUTION_NAME = 'Universidad de Sevilla';
export const INSTITUTION_TITLE = `Institutional account · ${INSTITUTION_NAME}`;
export const INSTITUTION_URL = 'https://www.us.es';

/**
 * Institutional status is the gateway's `institutional_email`: an e-mail SCORETech Identity verified, at one of the university's
 * domains. Never the plan (an administrator may grant RESEARCH to anybody) and never a domain read here.
 */
export function isInstitutionalAccount(user: InstitutionalAccount | null | undefined): boolean {
  return user?.institutional_email === true;
}

export function useInstitutionalBranding(): boolean {
  const { user } = useAuth();
  return isInstitutionalAccount(user);
}
