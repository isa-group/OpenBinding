// Adapted from SPHERE frontend/src/modules/core/components/user-avatar/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a person's avatar is SCORETech Identity's descriptor, drawn by Identity's own renderer (`identity-avatar.tsx`),
// instead of SPHERE's uploaded or predefined image URL; without one, the initial of the username on theme tokens, as before.

import IdentityAvatar from './identity-avatar';
import type { AvatarDescriptor } from './avatar-values';

interface UserAvatarProps {
  username: string;
  /** The person's display name: the initials of an `initials` avatar are taken from it when there is one. */
  displayName?: string | null;
  avatar?: AvatarDescriptor | null;
  size?: number;
  className?: string;
}

export default function UserAvatar({
  username,
  displayName,
  avatar,
  size = 36,
  className = '',
}: UserAvatarProps) {
  if (avatar)
    return (
      <IdentityAvatar
        value={avatar}
        name={displayName || username}
        size={size}
        className={className}
      />
    );
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: 'var(--color-tp-accent)',
        color: 'white',
        fontSize: size * 0.38,
      }}
    >
      {username ? (username[0]?.toUpperCase() ?? 'U') : '?'}
    </div>
  );
}
