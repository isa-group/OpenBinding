// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the organization is named by slug and the tab is in the address (`/orgs/:org/:tab?`), so a tab is a link and the
// back button works; OpenBinding's tabs (compositions, problems, runs, studies, presets, audit) and VIEWER; the stats come
// from the gateway; a non-member reads the public profile (overview and public compositions) and anything else, or an
// organization that publishes nothing, is the in-place 404; dialogs are accessible; no pricings, collections, services or
// permissions.

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../../auth/hooks/useAuth';
import { readApiError } from '../../../core/api/errors';
import Iconify from '../../../core/components/iconify';
import OrgAvatar from '../../../core/components/org-avatar';
import OrgDetailSkeleton from '../../../core/components/skeletons/org-detail-skeleton';
import { useRecentItems } from '../../../core/hooks/useRecentItems';
import { fadeInUp, staggerContainer, transitionDefault } from '../../../core/utils/motion-variants';
import NotFoundPage from '../../../core/pages/page-not-found';
import {
  avatarProps,
  useOrganizationsApi,
  type OrgHierarchyNode,
  type OrgMember,
  type OrgRole,
  type Organization,
  type OrganizationInvitation,
  type PublicOrganization,
} from '../../api/organizationsApi';
import { useOrganization } from '../../hooks/useOrganization';
import { orgPath } from '../../types/paths';
import { ROLE_COLORS, ROLE_LABELS, TAB_META, TABS, isTab } from './constants';
import type { Tab, TreeNode } from './types';
import AddMemberModal from './components/AddMemberModal';
import AuditTab from './components/AuditTab';
import ChildRolesManager from './components/ChildRolesManager';
import CreateSubOrgModal from './components/CreateSubOrgModal';
import EditOrgModal from './components/EditOrgModal';
import HierarchyTab from './components/HierarchyTab';
import InvitationsTab from './components/InvitationsTab';
import InviteModal from './components/InviteModal';
import MembersTab from './components/MembersTab';
import OrganizationExitButton from './components/OrganizationExitButton';
import OrgAvatarModal from './components/OrgAvatarModal';
import OverviewTab from './components/OverviewTab';
import PresetsTab from './components/PresetsTab';
import ResourceTab from './components/ResourceTab';
import CompositionsTab from '../../../composition/components/compositions-tab';
import ShareOrgMenu from './components/ShareOrgMenu';

const RANK: Record<OrgRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

/** The organization as this page shows it: a member's full view, or the public profile. */
type Shown = { kind: 'member'; org: Organization } | { kind: 'public'; org: PublicOrganization };

/** The branch the hierarchy endpoint answers flat, nested around the current organization. */
function buildTree(nodes: OrgHierarchyNode[], currentId: string): TreeNode | null {
  const byId = new Map<string, TreeNode>(
    nodes.map(node => [
      node.id,
      {
        id: node.id,
        slug: node.slug,
        name: node.name,
        avatar: node.avatar ?? null,
        parentId: node.parent_id ?? null,
        children: [],
        hasAccess: node.has_access,
      },
    ])
  );
  const ancestorIds = new Set<string>();
  let above = byId.get(currentId)?.parentId ?? null;
  while (above && !ancestorIds.has(above)) {
    ancestorIds.add(above);
    above = byId.get(above)?.parentId ?? null;
  }
  let root: TreeNode | null = null;
  for (const node of nodes) {
    const treeNode = byId.get(node.id)!;
    treeNode.isCurrent = node.id === currentId;
    treeNode.isAncestor = ancestorIds.has(node.id);
    const parent = treeNode.parentId ? byId.get(treeNode.parentId) : undefined;
    if (parent) parent.children.push(treeNode);
    else if (!root) root = treeNode;
  }
  for (const node of byId.values()) node.children.sort((a, b) => a.name.localeCompare(b.name));
  return root ?? byId.get(currentId) ?? null;
}

export default function OrganizationDetailPage() {
  const { org: slug = '', tab: tabParam } = useParams<{ org: string; tab?: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { addRecentOrganization } = useRecentItems();
  const {
    organizations,
    isLoading: organizationsLoading,
    refresh: refreshMyOrganizations,
  } = useOrganization();
  const api = useOrganizationsApi();
  const { getOrganization, getOrganizationProfile, getMembers, getInvitations, getHierarchy } = api;

  const [shown, setShown] = useState<Shown | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([]);
  const [hierarchyTree, setHierarchyTree] = useState<TreeNode | null>(null);
  const [expandedTreeIds, setExpandedTreeIds] = useState<Set<string>>(new Set());

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [avatarModalOpen, setAvatarModalOpen] = useState(false);
  const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [createSubOrgModalOpen, setCreateSubOrgModalOpen] = useState(false);

  // The account's own entry for this organization: a member reads the full page.
  const membership = organizations.find(item => item.slug === slug) ?? null;
  const deciding = authLoading || (Boolean(user) && organizationsLoading);
  const myRole: OrgRole | null = membership?.effective_role ?? null;
  const isPublicView = shown?.kind === 'public';
  const canManage = !isPublicView && (myRole === 'OWNER' || myRole === 'ADMIN');

  /* ─── Data loading ─── */
  const loadOrgData = useCallback(async () => {
    if (!slug) return;
    setError(null);
    try {
      if (membership) {
        const [orgData, membersData] = await Promise.all([
          getOrganization(slug),
          getMembers(slug).catch(() => [] as OrgMember[]),
        ]);
        setShown({ kind: 'member', org: orgData });
        setMembers(membersData);
        if (RANK[membership.effective_role ?? 'VIEWER'] >= RANK.ADMIN) {
          setInvitations(await getInvitations(slug).catch(() => []));
        }
      } else {
        setShown({ kind: 'public', org: await getOrganizationProfile(slug) });
        setMembers([]);
      }
      setMissing(false);
    } catch (caught) {
      const refusal = readApiError(caught);
      if (refusal.status === 404 || refusal.status === 403) setMissing(true);
      else setError(refusal.message || 'The organization could not be loaded.');
    }
    // `membership` is read by its slug and role: a refreshed list must not reload the page by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, membership?.id, membership?.effective_role, getOrganization, getOrganizationProfile]);

  useEffect(() => {
    if (deciding) return;
    void loadOrgData();
  }, [deciding, loadOrgData]);

  const memberOrg = shown?.kind === 'member' ? shown.org : null;

  /* ─── Hierarchy tree ─── */
  const loadHierarchy = useCallback(async () => {
    if (!memberOrg) return;
    try {
      setHierarchyTree(buildTree(await getHierarchy(memberOrg.slug), memberOrg.id));
    } catch {
      setHierarchyTree(null);
    }
  }, [memberOrg, getHierarchy]);

  useEffect(() => {
    void loadHierarchy();
  }, [loadHierarchy]);

  // The ancestors of this organization open once, so the tree shows where it sits.
  const autoExpandedOrgIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hierarchyTree || !memberOrg || autoExpandedOrgIdRef.current === memberOrg.id) return;
    const ancestorIds: string[] = [];
    let node: TreeNode | null = hierarchyTree;
    while (node && node.id !== memberOrg.id) {
      ancestorIds.push(node.id);
      node = node.children.find(child => child.isAncestor || child.isCurrent) ?? null;
    }
    if (node) {
      autoExpandedOrgIdRef.current = memberOrg.id;
      setExpandedTreeIds(prev => new Set([...prev, ...ancestorIds]));
    }
  }, [memberOrg, hierarchyTree]);

  /* ─── Recents ─── */
  useEffect(() => {
    if (!shown || !user) return;
    addRecentOrganization({
      id: shown.org.slug,
      name: shown.org.name,
      orgId: shown.org.id,
      orgName: shown.org.name,
    });
  }, [shown, user, addRecentOrganization]);

  /* ─── Refresh helpers ─── */
  /**
   * A move, an ownership handover or a new sub-organization rewrites more than this page: "Your organizations" reads from
   * the shared context, so it is told as well.
   */
  const handleOrgChanged = useCallback(async () => {
    await refreshMyOrganizations();
    await loadOrgData();
    await loadHierarchy();
  }, [loadOrgData, loadHierarchy, refreshMyOrganizations]);

  const refreshMembers = useCallback(async () => {
    try {
      setMembers(await getMembers(slug));
    } catch {
      /* the list keeps what it had */
    }
  }, [slug, getMembers]);

  const refreshInvitations = useCallback(async () => {
    try {
      setInvitations(await getInvitations(slug));
    } catch {
      /* the list keeps what it had */
    }
  }, [slug, getInvitations]);

  const handleOrganizationExited = async () => {
    await refreshMyOrganizations();
    navigate('/me/orgs');
  };

  const handleTreeToggle = useCallback((id: string) => {
    setExpandedTreeIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ─── Tabs ─── */
  const availableTabs = useMemo<Tab[]>(() => {
    if (isPublicView) return ['overview', 'compositions'];
    return TABS.filter(tab => {
      const minimum = TAB_META[tab].minRole;
      return !minimum || (myRole !== null && RANK[myRole] >= RANK[minimum]);
    });
  }, [isPublicView, myRole]);

  const activeTab: Tab | null =
    tabParam === undefined ? 'overview' : isTab(tabParam) ? tabParam : null;

  /* ─── Loading / Error ─── */
  if (!slug) return <NotFoundPage />;
  if (missing) return <NotFoundPage />;
  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void loadOrgData()}
            className="cursor-pointer rounded-md border border-red-300 bg-tp-canvas px-3 py-1.5 font-medium text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (deciding || !shown) return <OrgDetailSkeleton />;
  // A tab that does not exist, or that this reader may not open, is the same 404 as a missing organization.
  if (!activeTab || !availableTabs.includes(activeTab)) return <NotFoundPage />;

  const org = shown.org;
  const stats = memberOrg?.stats ?? null;
  const tabHref = (tab: Tab) => orgPath(org.slug, tab === 'overview' ? undefined : tab);

  return (
    <div className="min-h-screen">
      <Helmet>
        <title>{`OpenBinding - ${org.name}`}</title>
      </Helmet>

      {/* ═══ HERO HEADER ═══ */}
      <div className="relative overflow-hidden bg-linear-to-b from-tp-cream via-tp-cream-light to-tp-canvas">
        <div className="relative mx-auto max-w-5xl px-4 py-8 md:px-8 md:py-10">
          <motion.div initial="hidden" animate="visible" variants={staggerContainer}>
            <motion.div variants={fadeInUp} transition={transitionDefault}>
              <Link
                to={isPublicView ? '/organizations' : '/me/orgs'}
                className="mb-5 inline-flex cursor-pointer items-center gap-1.5 text-sm text-tp-steel transition-colors hover:text-tp-ink"
              >
                <Iconify icon="mdi:arrow-left" width={16} />
                Organizations
              </Link>
            </motion.div>

            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <motion.div variants={fadeInUp} transition={transitionDefault} className="shrink-0">
                {canManage && memberOrg ? (
                  <button
                    type="button"
                    onClick={() => setAvatarModalOpen(true)}
                    title="Change the organization image"
                    aria-label="Change the organization image"
                    className="group relative block cursor-pointer"
                  >
                    <OrgAvatar
                      name={org.name}
                      {...avatarProps(org.avatar)}
                      size={80}
                      square
                      className="shadow-elevation-2 ring-2 ring-white sm:h-20 sm:w-20"
                    />
                    <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                      <Iconify icon="mdi:camera-outline" width={22} className="text-white" />
                    </span>
                    {/* The overlay only appears on hover; this badge is the standing affordance. */}
                    <span className="absolute -right-1.5 -bottom-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-tp-hairline bg-tp-canvas text-tp-slate shadow-elevation-2 transition-colors group-hover:border-tp-accent group-hover:bg-tp-accent group-hover:text-tp-on-primary">
                      <Iconify icon="mdi:camera-outline" width={14} />
                    </span>
                  </button>
                ) : (
                  <OrgAvatar
                    name={org.name}
                    {...avatarProps(org.avatar)}
                    size={80}
                    square
                    className="shadow-elevation-2 ring-2 ring-white sm:h-20 sm:w-20"
                  />
                )}
              </motion.div>

              <div className="min-w-0 flex-1">
                <motion.div
                  variants={fadeInUp}
                  transition={transitionDefault}
                  className="flex flex-wrap items-center gap-3"
                >
                  <h1 className="font-display text-2xl break-words text-tp-ink sm:text-3xl">
                    {org.name}
                  </h1>
                  {!isPublicView && myRole && (
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${ROLE_COLORS[myRole]}`}
                    >
                      {ROLE_LABELS[myRole]}
                    </span>
                  )}
                  <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                    <ShareOrgMenu org={org} />
                    {canManage && memberOrg && (
                      <button
                        type="button"
                        onClick={() => setEditModalOpen(true)}
                        className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 py-2 text-sm font-medium text-tp-slate transition-colors hover:border-tp-hairline hover:bg-tp-surface hover:text-tp-ink"
                      >
                        <Iconify icon="mdi:pencil-outline" width={15} />
                        Edit
                      </button>
                    )}
                    {memberOrg && (
                      <OrganizationExitButton
                        org={memberOrg}
                        members={members}
                        myRole={myRole}
                        currentUserId={user?.id}
                        onExited={handleOrganizationExited}
                      />
                    )}
                  </div>
                </motion.div>
                <motion.p
                  variants={fadeInUp}
                  transition={transitionDefault}
                  className="mt-0.5 font-mono text-sm text-tp-steel"
                >
                  @{org.slug}
                </motion.p>
                {org.description && (
                  <motion.p
                    variants={fadeInUp}
                    transition={transitionDefault}
                    className="mt-2 max-w-2xl text-sm leading-relaxed text-tp-slate"
                  >
                    {org.description}
                  </motion.p>
                )}
              </div>
            </div>

            <motion.div
              variants={fadeInUp}
              transition={transitionDefault}
              className="mt-6 flex flex-wrap gap-x-5 gap-y-2 sm:gap-x-6"
            >
              {(stats
                ? [
                    { label: 'Members', value: stats.members, icon: 'mdi:account-group-outline' },
                    {
                      label: 'Sub-orgs',
                      value: stats.sub_organizations,
                      icon: 'mdi:graph-outline',
                    },
                    { label: 'Compositions', value: stats.compositions, icon: 'mdi:tag-outline' },
                    { label: 'Problems', value: stats.problems, icon: 'mdi:file-tree-outline' },
                    { label: 'Runs', value: stats.runs, icon: 'mdi:play-circle-outline' },
                    { label: 'Studies', value: stats.studies, icon: 'mdi:chart-box-outline' },
                  ]
                : [
                    {
                      label: 'Public compositions',
                      value: (org as PublicOrganization).public_compositions,
                      icon: 'mdi:tag-outline',
                    },
                  ]
              ).map(stat => (
                <div key={stat.label} className="flex items-center gap-1.5">
                  <Iconify icon={stat.icon} width={14} className="text-tp-steel" />
                  <span className="text-sm font-semibold text-tp-ink">{stat.value}</span>
                  <span className="text-xs text-tp-steel">{stat.label}</span>
                </div>
              ))}
              {memberOrg && (
                <div className="flex items-center gap-2">
                  <Iconify icon="mdi:calendar-outline" width={15} className="text-tp-ink" />
                  <span className="text-xs text-tp-steel">
                    Created{' '}
                    {new Date(memberOrg.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </div>
              )}
            </motion.div>
          </motion.div>
        </div>
      </div>

      {/* ═══ TAB NAVIGATION ═══ */}
      <div className="sticky top-14 z-30 border-b border-tp-hairline bg-tp-canvas/80 backdrop-blur-xl">
        <div className="mx-auto max-w-5xl px-4 md:px-8">
          <div className="py-2 lg:hidden">
            <div className="relative">
              <select
                aria-label="Section"
                value={activeTab}
                onChange={e => navigate(tabHref(e.target.value as Tab))}
                className="w-full appearance-none rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2.5 pr-8 text-sm font-medium text-tp-ink transition-colors focus:border-tp-primary focus:outline-none"
              >
                {availableTabs.map(tab => (
                  <option key={tab} value={tab}>
                    {TAB_META[tab].label}
                  </option>
                ))}
              </select>
              <svg
                className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-tp-steel"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>

          {/* Every tab fits from lg on (the select covers narrower screens). The tabs are links: the tab is in the address. */}
          <nav
            aria-label="Organization sections"
            className="hidden [scrollbar-width:none] gap-1 overflow-x-auto py-1 lg:flex [&::-webkit-scrollbar]:hidden"
          >
            {availableTabs.map(tab => {
              const meta = TAB_META[tab];
              const current = activeTab === tab;
              return (
                <Link
                  key={tab}
                  to={tabHref(tab)}
                  aria-current={current ? 'page' : undefined}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
                    current
                      ? 'bg-tp-primary/8 text-tp-accent'
                      : 'text-tp-steel hover:bg-tp-surface hover:text-tp-ink'
                  }`}
                >
                  <Iconify icon={meta.icon} width={16} />
                  {meta.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      {/* ═══ TAB CONTENT ═══ */}
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <AnimatePresence mode="wait">
          {activeTab === 'overview' && (
            <OverviewTab
              key="overview"
              org={org}
              stats={stats}
              invitations={canManage ? invitations : []}
              createdAt={memberOrg?.created_at ?? null}
            />
          )}

          {activeTab === 'compositions' && (
            <CompositionsTab
              key="compositions"
              org={org}
              myRole={myRole}
              isPublicView={isPublicView}
            />
          )}
          {(activeTab === 'problems' || activeTab === 'runs' || activeTab === 'studies') && (
            <ResourceTab key={activeTab} kind={activeTab} org={org} myRole={myRole} />
          )}

          {activeTab === 'members' && memberOrg && (
            <div key="members" className="flex flex-col gap-6">
              <MembersTab
                org={memberOrg}
                members={members}
                canManage={canManage}
                currentUserId={user?.id}
                managerRole={myRole}
                onRefresh={refreshMembers}
                onOwnershipTransferred={handleOrgChanged}
                onAddMember={() => setAddMemberModalOpen(true)}
                onLeave={handleOrganizationExited}
              />
              {canManage && hierarchyTree && (
                <ChildRolesManager
                  org={memberOrg}
                  tree={hierarchyTree}
                  organizations={organizations}
                  currentUserId={user?.id}
                />
              )}
            </div>
          )}

          {activeTab === 'invitations' && memberOrg && (
            <InvitationsTab
              key="invitations"
              orgSlug={memberOrg.slug}
              invitations={invitations}
              canManage={canManage}
              onRefresh={refreshInvitations}
              onOpenInvite={() => setInviteModalOpen(true)}
            />
          )}

          {activeTab === 'hierarchy' && memberOrg && (
            <HierarchyTab
              key="hierarchy"
              org={memberOrg}
              canManage={canManage}
              hierarchyTree={hierarchyTree}
              organizations={organizations}
              expandedTreeIds={expandedTreeIds}
              onToggle={handleTreeToggle}
              onCreateSubOrg={() => setCreateSubOrgModalOpen(true)}
              onMoved={handleOrgChanged}
            />
          )}

          {activeTab === 'presets' && memberOrg && (
            <PresetsTab key="presets" organization={memberOrg} />
          )}

          {activeTab === 'audit' && memberOrg && <AuditTab key="audit" organization={memberOrg} />}
        </AnimatePresence>
      </div>

      {/* ═══ DIALOGS ═══ */}
      {editModalOpen && memberOrg && (
        <EditOrgModal
          org={memberOrg}
          onClose={() => setEditModalOpen(false)}
          onSaved={updated => {
            setShown({ kind: 'member', org: { ...memberOrg, ...updated } });
            setEditModalOpen(false);
            void refreshMyOrganizations();
          }}
        />
      )}
      {avatarModalOpen && memberOrg && (
        <OrgAvatarModal
          org={memberOrg}
          onClose={() => setAvatarModalOpen(false)}
          onSaved={updated => {
            // Only the avatar is taken from the answer, so nothing else the page loaded is dropped.
            setShown({ kind: 'member', org: { ...memberOrg, avatar: updated.avatar } });
            void refreshMyOrganizations();
          }}
        />
      )}
      {addMemberModalOpen && memberOrg && (
        <AddMemberModal
          orgSlug={memberOrg.slug}
          members={members}
          onClose={() => setAddMemberModalOpen(false)}
          onAdded={refreshMembers}
        />
      )}
      {inviteModalOpen && memberOrg && (
        <InviteModal
          orgSlug={memberOrg.slug}
          invitations={invitations}
          onClose={() => setInviteModalOpen(false)}
          onRefresh={refreshInvitations}
        />
      )}
      {createSubOrgModalOpen && memberOrg && (
        <CreateSubOrgModal
          parent={memberOrg}
          onClose={() => setCreateSubOrgModalOpen(false)}
          onCreated={handleOrgChanged}
        />
      )}
    </div>
  );
}
