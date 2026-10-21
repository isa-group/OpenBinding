import { useAuth } from '../../contexts/auth';

interface InstitutionalAccount {
  plan?: string | null;
  institutional_branding?: boolean | null;
}

export const INSTITUTION_NAME = 'Universidad de Sevilla';
export const INSTITUTION_TITLE = `Institutional account · ${INSTITUTION_NAME}`;
export const INSTITUTION_URL = 'https://www.us.es';

/** Institutional status comes from the plan or the contract flag, never from the e-mail domain. */
export function isInstitutionalAccount(user: InstitutionalAccount | null | undefined): boolean {
  return Boolean(user && (user.plan === 'RESEARCH' || user.institutional_branding));
}

export function useInstitutionalBranding(): boolean {
  const { user } = useAuth();
  return isInstitutionalAccount(user);
}
