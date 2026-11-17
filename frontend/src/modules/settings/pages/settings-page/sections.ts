// Adapted from SPHERE frontend/src/modules/settings/pages/SettingsPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's `ALL_SECTIONS`, as OpenBinding decided them (design §4.2 item 27): Public Profile, Social Links and
// Connected applications are not ported, Payments became Plan and Appearance is new; the section lives in the address.

import type { IconType } from 'react-icons';
import {
  FiAlertTriangle,
  FiBell,
  FiCreditCard,
  FiDroplet,
  FiShield,
  FiUser,
  FiZap,
} from 'react-icons/fi';

export const SETTINGS_PATH = '/me/settings';

export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account', icon: FiUser },
  { id: 'integrations', label: 'Sign-in & Security', icon: FiShield },
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
