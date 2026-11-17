// Adapted from the Follow button of SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: its own component over the composition follows (`/v1/composition-follows/{org}/{composition}`); a refused change
// is said in the dialog host instead of SPHERE's alert, and the state is read again for another composition.

import { useEffect, useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import customAlert from '../../../core/utils/custom-alert';
import { useCompositionsApi } from '../../api/compositionsApi';

interface Props {
  org: string;
  composition: string;
}

/** Follow a composition to be told of each new version; shown to a signed-in reader once the state is known. */
export default function FollowButton({ org, composition }: Props) {
  const { getFollow, setFollow } = useCompositionsApi();
  // null until known: the button stays hidden while the status loads.
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [isToggling, setIsToggling] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getFollow(org, composition, controller.signal)
      .then(result => setIsFollowing(result.following))
      .catch(() => {
        if (!controller.signal.aborted) setIsFollowing(null);
      });
    return () => controller.abort();
  }, [org, composition, getFollow]);

  if (isFollowing === null) return null;

  const toggle = async () => {
    setIsToggling(true);
    try {
      setIsFollowing((await setFollow(org, composition, !isFollowing)).following);
    } catch (error) {
      void customAlert(`Could not update follow: ${readApiError(error).message}`, 'error');
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={isToggling}
      aria-pressed={isFollowing}
      title={
        isFollowing
          ? 'Stop getting notified of new versions'
          : 'Get notified when a new version is sealed'
      }
      className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors focus:border-tp-primary focus:outline-none disabled:cursor-wait disabled:opacity-60 ${
        isFollowing
          ? 'border-tp-primary bg-tp-primary/10 text-tp-ink hover:bg-tp-primary/15'
          : 'border-tp-input-border bg-tp-input-bg text-tp-ink hover:bg-tp-surface'
      }`}
    >
      <svg
        className="h-3.5 w-3.5"
        fill={isFollowing ? 'currentColor' : 'none'}
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
        />
      </svg>
      {isFollowing ? 'Following' : 'Follow'}
    </button>
  );
}
