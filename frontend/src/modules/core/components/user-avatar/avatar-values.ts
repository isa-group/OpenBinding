// Adapted from SCORETech-identity packages/ui/src/avatar.tsx (revision 215dffe, v0.1.11),
// https://github.com/SCORELabUS/SCORETech-identity. Copyright (c) 2026 SCORE Lab.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the values of Identity's avatar module without its component (`identity-avatar.tsx`), so the component file
// exports components only; the descriptor is OpenBinding's generated wire type (colours as hex, no photo kind, since
// Identity never shares photos); the preset and icon ids, which Identity's backend accepts, are listed for the editor.

import type { components } from '../../api/openapi';

type Schemas = components['schemas'];

/** A person's avatar as the gateway serves it: SCORETech Identity's descriptor. */
export type AvatarDescriptor =
  Schemas['PresetAvatar'] | Schemas['InitialsAvatar'] | Schemas['IconAvatar'];

export const avatarPalette = [
  '#be1d37',
  '#94152a',
  '#212529',
  '#ffffff',
  '#343a40',
  '#68737d',
  '#a8a8a8',
  '#e5e5e5',
  '#fff8e0',
  '#ffd06a',
  '#ffb83e',
  '#ffa110',
  '#ff8105',
  '#ffd900',
  '#0d7660',
];
export const avatarChoices = [
  { id: 'avatar-1', label: 'Bear' },
  { id: 'avatar-2', label: 'Cat' },
  { id: 'avatar-3', label: 'Ghost' },
  { id: 'avatar-4', label: 'Owl' },
  { id: 'avatar-6', label: 'Bird' },
  { id: 'avatar-7', label: 'Skull' },
  { id: 'avatar-8', label: 'Alien' },
  { id: 'avatar-9', label: 'Robot' },
  { id: 'avatar-10', label: 'Dog' },
] as const;
/** Identity's icons (`ApplicationUserClaims.java`), drawn with its lucide glyphs. */
export const avatarIcons = [
  { id: 'spark', label: 'Spark' },
  { id: 'rocket', label: 'Rocket' },
  { id: 'heart', label: 'Heart' },
  { id: 'leaf', label: 'Leaf' },
  { id: 'star', label: 'Star' },
] as const;
/** Identity's presets: an animal in Identity's own colours. */
export const avatarPresets = [
  { id: 'owl', label: 'Owl' },
  { id: 'fox', label: 'Fox' },
  { id: 'octopus', label: 'Octopus' },
  { id: 'robot', label: 'Robot' },
] as const;
const colors: Record<string, string> = {
  graphite: '#212529',
  tentu: '#be1d37',
  stone: '#68737d',
  lime: '#ffd900',
  paper: '#ffffff',
  charcoal: '#343a40',
  cyan: '#00a6bf',
  pink: '#e472a8',
  purple: '#7654b2',
  orange: '#fa520f',
  black: '#000000',
  white: '#ffffff',
};
/** The colours Identity's renderer falls back to (its tentu red, drawn in white): a new avatar starts with them. */
export const AVATAR_DEFAULT_BACKGROUND = '#be1d37';
export const AVATAR_DEFAULT_FOREGROUND = '#ffffff';

export const avatarColor = (value: string | undefined, fallback: string) =>
  value && /^#[a-f0-9]{6}$/i.test(value) ? value : colors[value || ''] || fallback;

/** Identity's initials: the first letters of the first two words of the name, upper-cased; "?" for none. */
export const avatarInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0] || '')
    .join('')
    .toUpperCase() || '?';
