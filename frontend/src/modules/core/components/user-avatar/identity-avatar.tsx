// Adapted from SCORETech-identity packages/ui/src/avatar.tsx (revision 215dffe, v0.1.11),
// https://github.com/SCORELabUS/SCORETech-identity. Copyright (c) 2026 SCORE Lab.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: Identity's lucide icons swapped for the same glyphs of `react-icons/lu`, which OpenBinding ships; the size is a
// prop and the layout Tailwind classes instead of Identity's `.avatar` and `.user-avatar` rules (78 % artwork, 65 % icons);
// colours pass through `avatarColor` (hex, or Identity's named colours) before they reach an inline style; no photo kind;
// the values live in `avatar-values.ts`.

import type { CSSProperties } from 'react';
import {
  LuBird,
  LuBot,
  LuCat,
  LuFish,
  LuHeart,
  LuLeaf,
  LuRocket,
  LuSparkles,
  LuStar,
} from 'react-icons/lu';
import { avatarArtwork } from './avatar-assets';
import {
  AVATAR_DEFAULT_BACKGROUND,
  AVATAR_DEFAULT_FOREGROUND,
  avatarColor,
  avatarInitials,
  type AvatarDescriptor,
} from './avatar-values';

const legacy = {
  spark: LuSparkles,
  rocket: LuRocket,
  heart: LuHeart,
  leaf: LuLeaf,
  star: LuStar,
  owl: LuBird,
  fox: LuCat,
  octopus: LuFish,
  robot: LuBot,
};

export default function IdentityAvatar({
  value,
  name,
  size = 36,
  className = '',
}: {
  value: AvatarDescriptor;
  name: string;
  size?: number;
  className?: string;
}) {
  const initials = avatarInitials(name);
  const foreground = avatarColor(
    'foregroundColor' in value ? value.foregroundColor : undefined,
    AVATAR_DEFAULT_FOREGROUND
  );
  const background = avatarColor(
    'backgroundColor' in value ? value.backgroundColor : undefined,
    AVATAR_DEFAULT_BACKGROUND
  );
  const assetId = 'assetId' in value ? value.assetId : undefined;
  const artwork = value.kind === 'icon' && assetId ? avatarArtwork[assetId] : undefined;
  const Icon = assetId ? legacy[assetId as keyof typeof legacy] : undefined;
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: background,
    color: foreground,
    fontSize: size * 0.38,
  };
  return (
    <span
      data-avatar-kind={value.kind}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold ${className}`}
      style={style}
    >
      {artwork ? (
        <img
          src={
            'data:image/svg+xml;utf8,' +
            encodeURIComponent(artwork.replace(/currentColor/g, foreground))
          }
          alt=""
          className="h-[78%] w-[78%] object-contain"
        />
      ) : Icon && value.kind !== 'initials' ? (
        <Icon aria-hidden="true" className="h-[65%] w-[65%]" />
      ) : (
        initials
      )}
    </span>
  );
}
