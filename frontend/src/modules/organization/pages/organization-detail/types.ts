// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/types.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's tabs (the resources an organization holds, presets, the audit log and the beta Connections; no
// pricings, collections, services or permissions); the tree is named by slug. `isPersonal` as SPHERE's at fc776b4d.

export interface TreeNode {
  id: string;
  slug: string;
  name: string;
  avatar: { url?: string | null; bg_color?: string | null; fg_color?: string | null } | null;
  parentId: string | null;
  children: TreeNode[];
  hasAccess: boolean;
  isPersonal: boolean;
  isAncestor?: boolean;
  isCurrent?: boolean;
}

export type Tab =
  | 'overview'
  | 'compositions'
  | 'problems'
  | 'runs'
  | 'studies'
  | 'members'
  | 'invitations'
  | 'hierarchy'
  | 'presets'
  | 'audit'
  | 'connections';

export const PER_PAGE = 10;
