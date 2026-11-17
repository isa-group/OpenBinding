// Adapted from SPHERE frontend/src/modules/settings/pages/SettingsPage.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's `ALL_SECTIONS` holds the sections of administration (design §4.2 item 26) instead of the account's
// settings; each section is a segment of the address (`/admin/:section?`).

import type { IconType } from 'react-icons';
import {
  FiActivity,
  FiAlertOctagon,
  FiCheckSquare,
  FiFileText,
  FiLayers,
  FiTool,
  FiUsers,
} from 'react-icons/fi';
import type { AdminSectionId } from '../../../../routes/paths/admin';

export const ADMIN_SECTIONS: ReadonlyArray<{ id: AdminSectionId; label: string; icon: IconType }> =
  [
    { id: 'overview', label: 'Overview', icon: FiActivity },
    { id: 'users', label: 'Accounts', icon: FiUsers },
    { id: 'moderation', label: 'Moderation', icon: FiCheckSquare },
    { id: 'audit', label: 'Audit', icon: FiFileText },
    { id: 'errors', label: 'Errors', icon: FiAlertOctagon },
    { id: 'queues', label: 'Queues', icon: FiLayers },
    { id: 'maintenance', label: 'Maintenance', icon: FiTool },
  ];
