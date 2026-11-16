// Adapted from SPHERE frontend/src/modules/core/utils/recentItems.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's kinds and keys: recent compositions, problems and organizations under
// `openbinding:recent{Compositions,Problems,Organizations}` (collections arrive in F9).

export interface RecentItem {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  visitedAt: string;
}

const STORAGE_KEYS = {
  compositions: 'openbinding:recentCompositions',
  problems: 'openbinding:recentProblems',
  organizations: 'openbinding:recentOrganizations',
} as const;

const MAX_ITEMS = 20;

function readList(key: string): RecentItem[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(key: string, items: RecentItem[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

function addRecent(key: string, item: Omit<RecentItem, 'visitedAt'>): void {
  const list = readList(key).filter(i => i.id !== item.id);
  list.unshift({ ...item, visitedAt: new Date().toISOString() });
  writeList(key, list.slice(0, MAX_ITEMS));
}

export function addRecentComposition(item: Omit<RecentItem, 'visitedAt'>): void {
  addRecent(STORAGE_KEYS.compositions, item);
}

export function addRecentProblem(item: Omit<RecentItem, 'visitedAt'>): void {
  addRecent(STORAGE_KEYS.problems, item);
}

export function getRecentCompositions(): RecentItem[] {
  return readList(STORAGE_KEYS.compositions);
}

export function getRecentProblems(): RecentItem[] {
  return readList(STORAGE_KEYS.problems);
}

export function addRecentOrganization(item: Omit<RecentItem, 'visitedAt'>): void {
  addRecent(STORAGE_KEYS.organizations, item);
}

export function getRecentOrganizations(): RecentItem[] {
  return readList(STORAGE_KEYS.organizations);
}
