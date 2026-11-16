// Adapted from SPHERE frontend/src/modules/core/pages/page-not-found/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: rendered in place, below the header, for a missing and an unreadable page alike (the same wording for both,
// so a private resource does not reveal that it exists); theme tokens instead of the undefined `sphere-grey-*` classes;
// the OpenBinding title; the white label sits on the accent.

import { Helmet } from 'react-helmet-async';
import { FiHome } from 'react-icons/fi';

import RouterLink from '../../components/router-link';
import Logo404 from '../../components/404-logo';

export default function NotFoundPage() {
  return (
    <>
      <Helmet>
        <title>OpenBinding - Page not found</title>
      </Helmet>

      <div className="mx-auto max-w-7xl px-4">
        <div className="mx-auto flex min-h-[60vh] max-w-120 flex-col items-center justify-center py-12 text-center">
          <h1 className="mb-3 font-display text-3xl leading-tight font-semibold text-tp-ink">
            Sorry, page not found!
          </h1>

          <p className="text-tp-slate">
            There is nothing to show at this address: the page does not exist, or you cannot see it.
            Check the address, or sign in if it belongs to an organization you are part of.
          </p>

          <div className="mx-auto mt-10 mb-16 h-65 sm:mt-20 sm:mb-20">
            <Logo404 />
          </div>

          <RouterLink
            href="/"
            className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-tp-accent px-5 py-3 text-sm font-semibold text-tp-on-primary transition-colors hover:bg-tp-accent-hover"
          >
            <FiHome className="h-4 w-4" aria-hidden="true" />
            Return to Home
          </RouterLink>
        </div>
      </div>
    </>
  );
}
