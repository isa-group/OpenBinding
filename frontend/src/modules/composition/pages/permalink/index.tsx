// Adapted from SPHERE frontend/src/modules/pricing/pages/permalink/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: compositions only (`/c/` stays for collections); the gateway's `/v1/permalinks/compositions/{id}` through the
// session's fetch; the destination must be a composition page.

import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import { useCompositionsApi } from '../../api/compositionsApi';

const UNAVAILABLE =
  'This resource is unavailable. Sign in if you have access to a private resource.';

export default function PermanentLinkPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [searchParams] = useSearchParams();
  // `/p/{compositionId}?version=…` opens that version; the gateway decides whether the caller may see it and only then
  // keeps it in the location it answers with.
  const version = searchParams.get('version');
  const { loading } = useAuth();
  const { resolvePermalink } = useCompositionsApi();
  const [error, setError] = useState('');

  useEffect(() => {
    if (loading) return;
    const controller = new AbortController();
    resolvePermalink(id, version, controller.signal)
      .then(({ location }) => {
        if (typeof location !== 'string' || !/^\/(compositions|collections)\//.test(location))
          throw new Error('Invalid destination');
        if (!controller.signal.aborted) navigate(location + hash, { replace: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(UNAVAILABLE);
      });
    return () => controller.abort();
  }, [loading, id, version, hash, navigate, resolvePermalink]);

  return (
    <p role="status" className="p-8 text-tp-ink">
      {error || 'Opening permanent link…'}
    </p>
  );
}
