// Adapted from SPHERE frontend/src/modules/settings/components/IdentityAccountSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the `linking` variant and its `POST /auth/identity/link` are not copied (OpenBinding has no local accounts to
// connect); OpenBinding's snake_case `AuthConfigView.account_url`; the return address is OpenBinding's Settings › Account
// (`/me/settings?section=account`); the icons are hidden from assistive technology.

import { FiExternalLink, FiShield } from 'react-icons/fi';
import { useAuthConfig } from '../../auth/contexts/authConfigContext';
import { identityAccountHref } from '../utils/identityAccount';

export default function IdentityAccountSection() {
  const config = useAuthConfig();
  const href = identityAccountHref(config.account_url);
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-medium text-tp-ink">Your SCORETech account</h2>
        <p className="mt-1 text-sm text-tp-steel">
          Manage the profile you use across SCORE services.
        </p>
      </div>
      <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-6 sm:p-8">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-tp-primary/10 text-tp-primary">
          <FiShield size={22} aria-hidden="true" />
        </div>
        <h3 className="text-xl font-semibold text-tp-ink">SCORETech Identity</h3>
        <p className="mt-3 max-w-[36rem] text-sm leading-relaxed text-tp-steel">
          Update your personal details, avatar and social links, or manage your sign-in methods.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a
            className="flex cursor-pointer items-center gap-2 rounded-lg bg-tp-primary px-4 py-2.5 text-sm font-medium text-tp-on-primary"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open my SCORETech profile
            <FiExternalLink size={16} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </div>
    </section>
  );
}
