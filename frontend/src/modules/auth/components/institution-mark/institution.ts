import { useAuth } from '../../../auth/hooks/useAuth';

interface InstitutionalAccount {
  plan?: string | null;
}

export const INSTITUTION_NAME = 'Universidad de Sevilla';
export const INSTITUTION_TITLE = `Institutional account · ${INSTITUTION_NAME}`;
export const INSTITUTION_URL = 'https://www.us.es';

/** Institutional status comes from the plan (RESEARCH), never from the e-mail domain. */
export function isInstitutionalAccount(user: InstitutionalAccount | null | undefined): boolean {
  return user?.plan === 'RESEARCH';
}

export function useInstitutionalBranding(): boolean {
  const { user } = useAuth();
  return isInstitutionalAccount(user);
}
