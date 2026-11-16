// Adapted from SPHERE frontend/src/modules/core/components/user-avatar/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the default colours are theme tokens (and a named white) instead of hex values; avatars are served by the
// gateway at OpenBinding's API base (`config.apiBaseUrl`), not at SPHERE's `VITE_API_URL`.

import { config } from '../../../../config';
import { useState, useEffect } from 'react';

const API_BASE = config.apiBaseUrl;

const svgCache: Record<string, string> = {};

async function loadSvgWithColor(file: string, color: string): Promise<string> {
  const cacheKey = `${file}:${color}`;
  if (svgCache[cacheKey]) return svgCache[cacheKey];

  try {
    const res = await fetch(`${API_BASE}/static/avatars/users/default/${file}`);
    let text = await res.text();
    text = text.replace(/currentColor/g, color);
    const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(text)}`;
    svgCache[cacheKey] = dataUri;
    return dataUri;
  } catch {
    return '';
  }
}

function resolveAvatarUrl(avatar: string): string {
  if (!avatar) return '';
  if (avatar.startsWith('http') || avatar.startsWith('data:') || avatar.startsWith('blob:'))
    return avatar;
  if (avatar.startsWith('/')) return `${API_BASE}${avatar}`;
  return `${API_BASE}/${avatar}`;
}

function getInitials(username: string): string {
  if (!username) return '?';
  return username[0]?.toUpperCase() ?? 'U';
}

interface UserAvatarProps {
  username: string;
  avatar?: string | null;
  avatarBgColor?: string;
  avatarFgColor?: string;
  size?: number;
  className?: string;
}

export default function UserAvatar({
  username,
  avatar,
  avatarBgColor,
  avatarFgColor,
  size = 36,
  className = '',
}: UserAvatarProps) {
  const bg = avatarBgColor || 'var(--color-tp-accent)';
  const fg = avatarFgColor || 'white';
  const isSvg = avatar?.includes('.svg') ?? false;
  const isUploaded = !!avatar && !isSvg;

  const initials = getInitials(username);

  const [svgDataUri, setSvgDataUri] = useState<string>('');

  useEffect(() => {
    if (!isSvg || !avatar) return;

    const file = avatar.split('/').pop() || '';
    if (!file) return;

    loadSvgWithColor(file, fg).then(setSvgDataUri);
  }, [isSvg, avatar, fg]);

  const style: React.CSSProperties = { width: size, height: size };

  if (isUploaded) {
    const src = resolveAvatarUrl(avatar);
    return (
      <img
        src={src}
        alt={username}
        className={`shrink-0 overflow-hidden rounded-full object-cover ${className}`}
        style={style}
      />
    );
  }

  if (isSvg && svgDataUri) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`}
        style={{ ...style, backgroundColor: bg }}
      >
        <img src={svgDataUri} alt="" className="h-[60%] w-[60%] object-contain" />
      </div>
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold ${className}`}
      style={{ ...style, backgroundColor: bg, color: fg, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
