// Adapted from SPHERE frontend/src/modules/auth/components/uvus-login-button/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the gateway's CAS start address (`apiClient.casStartUrl`), the university's mark and name, the RESEARCH note
// under the button, and the CAS flow remembered on the way out so the callback returns to the page that asked.

import { motion } from 'framer-motion';
import { apiClient } from '../../../../api/client';
import { INSTITUTION_NAME } from '../../../../components/InstitutionMark/institution';
import { BRAND_ASSETS } from '../../../../content/brandAssets';
import { rememberCasFlow } from '../../../../utils/authFlow';
import { fadeUp } from '../auth-layout/variants';

/**
 * "Continue with Universidad de Sevilla" (the university's CAS). A plain anchor with a full page navigation: the CAS flow relies
 * on browser redirects, so there is no fetch here. The "or" divider between it and the local form lives in the login form.
 */
export default function UvusLoginButton({ returnTo }: { returnTo?: unknown }) {
  return (
    <motion.div variants={fadeUp}>
      <a
        href={apiClient.casStartUrl('login')}
        onClick={() => rememberCasFlow('login', returnTo)}
        className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-tp-input-border bg-tp-input-bg px-4 text-sm font-medium text-tp-ink transition-colors duration-200 hover:border-tp-primary"
      >
        <img src={BRAND_ASSETS.institutionMark} alt="" className="h-5 w-5 object-contain" />
        Continue with {INSTITUTION_NAME}
      </a>
      <p className="mt-2 text-xs leading-5 text-tp-steel">
        A verified CAS identity can qualify for RESEARCH, but only if the current pricing grants it.
        It never gives admin or organization roles.
      </p>
    </motion.div>
  );
}
