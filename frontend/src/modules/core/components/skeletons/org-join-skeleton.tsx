// Copied verbatim from SPHERE frontend/src/modules/core/components/skeletons/org-join-skeleton.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

import Skeleton from 'react-loading-skeleton';

export default function OrgJoinSkeleton() {
  return (
    <div className="mx-auto max-w-112 px-4 py-16">
      <div className="flex flex-col items-center gap-4 text-center">
        <Skeleton width={80} height={80} borderRadius={9999} />
        <div>
          <Skeleton width={200} height={28} />
          <Skeleton width={120} height={14} className="mt-2" />
        </div>
        <Skeleton width={260} height={14} />
        <div className="mt-2 w-full rounded-lg border border-tp-hairline bg-tp-surface p-4">
          <Skeleton width="90%" height={14} />
          <Skeleton width="70%" height={12} className="mt-2" />
          <Skeleton width="50%" height={10} className="mt-2" />
        </div>
        <div className="flex w-full flex-col gap-2 pt-2">
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      </div>
    </div>
  );
}
