// Adapted from SPHERE frontend/src/modules/settings/pages/SettingsPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's `ALL_SECTIONS`, as OpenBinding decided them (design §4.2 item 27): Social Links and Connected applications
// are not ported, Payments became Plan and Appearance is new; Sign-in & Security (the CAS identities) went with CAS (F5);
// Public profile is the display name and the avatar (F5), shown in both sign-in modes; the section lives in the address.

import type { IconType } from 'react-icons';
import {
  FiAlertTriangle,
  FiBell,
  FiCreditCard,
  FiDroplet,
  FiGlobe,
  FiUser,
  FiZap,
} from 'react-icons/fi';

export const SETTINGS_PATH = '/me/settings';

export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account', icon: FiUser },
  { id: 'profile', label: 'Public profile', icon: FiGlobe },
  { id: 'notifications', label: 'Notifications', icon: FiBell },
  { id: 'plan', label: 'Plan', icon: FiCreditCard },
  { id: 'appearance', label: 'Appearance', icon: FiDroplet },
  { id: 'beta', label: 'Beta features', icon: FiZap },
  { id: 'danger', label: 'Danger Zone', icon: FiAlertTriangle },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconType }>;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** The section an address names (`?section=`); an unknown or missing one is Account. */
export function sectionOf(value: string | null | undefined): SettingsSectionId {
  return SETTINGS_SECTIONS.find(section => section.id === value)?.id ?? 'account';
}

/** The address of a section: Account has none of its own. */
export function settingsPath(section: SettingsSectionId = 'account'): string {
  return section === 'account' ? SETTINGS_PATH : `${SETTINGS_PATH}?section=${section}`;
}
