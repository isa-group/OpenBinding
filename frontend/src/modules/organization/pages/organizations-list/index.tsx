// Adapted from SPHERE frontend/src/modules/organization/pages/organizations-list/index.tsx (revisions 73779a8a and
// fc776b4d, its Personal and Teams sections), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García
// Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's organizations (slugs, VIEWER, the gateway's `role_source` shown as "inherited from"); an admin of both
// ends moves an organization, as the gateway rules, and a personal one never moves nor takes a branch; a "Move to…" dialog
// beside the drag, for phones and keyboards; a Helmet title; the load error with Retry; the page of top-level nodes.

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import BlockAlert from '../../../core/components/block-alert';
import Iconify from '../../../core/components/iconify';
import OrgAvatar from '../../../core/components/org-avatar';
import Pagination from '../../../core/components/pagination';
import OrgListSkeleton from '../../../core/components/skeletons/org-list-skeleton';
import { fadeInUp, staggerContainer, transitionDefault } from '../../../core/utils/motion-variants';
import { avatarProps, type Organization, type OrgRole } from '../../api/organizationsApi';
import { orgPath } from '../../types/paths';
import { OrgDndProvider, OrgDragHandle, OrgRootDropZone } from '../../components/org-dnd';
import { useOrgRowDnd } from '../../components/org-dnd/row';
import { collectBranchIds, findInTree } from '../../components/org-dnd/tree';
import MoveOrganizationModal from '../../components/move-organization-modal';
import RoleBadge from '../../components/role-badge';
import { ORG_PAGE_SIZE, useOrganization } from '../../hooks/useOrganization';
import { useOrgReparenting } from '../../hooks/useOrgReparenting';
import { filterTree } from '../../utils/filter-tree';

const childrenOf = (org: Organization) => org.children ?? [];

/** An admin of an organization may move it; the gateway also wants admin of the new parent. */
const canManage = (role: OrgRole | null | undefined) => role === 'OWNER' || role === 'ADMIN';

/* ═══════════════════════════════════════════════════════════════
   TREE NODE — renders a single org with optional expand/collapse
   ═══════════════════════════════════════════════════════════════ */
function OrgTreeNode({
  org,
  level = 0,
  expandedIds,
  onToggle,
  onMoveRequest,
  isDragEnabled = false,
  blockedTargetIds,
  isDragActive = false,
}: {
  org: Organization;
  level?: number;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onMoveRequest: (org: Organization) => void;
  /** Off while a move is in flight. */
  isDragEnabled?: boolean;
  /** Ids this drag may not land on: the branch being dragged, and its parent. */
  blockedTargetIds?: Set<string>;
  isDragActive?: boolean;
}) {
  const children = childrenOf(org);
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(org.id);

  // Personal organizations stand outside the hierarchy altogether (SPHERE).
  const isManaged = canManage(org.effective_role) && !org.is_personal;
  const canDrag = isDragEnabled && isManaged;
  const canDrop = canDrag && isDragActive && !blockedTargetIds?.has(org.id);
  const { setNodeRef, dragHandleProps, isOver, isDragging } = useOrgRowDnd({
    id: org.id,
    canDrag,
    canDrop,
  });
  const inherited = org.role_source && org.role_source.id !== org.id ? org.role_source : null;

  return (
    <div>
      <motion.div variants={fadeInUp} initial="hidden" animate="visible">
        <div
          ref={setNodeRef}
          className={`group relative flex items-center gap-3 rounded-lg border bg-tp-canvas px-3 py-3 transition-all hover:shadow-(--shadow-elevation-2) sm:gap-4 sm:px-5 sm:py-4 dark:bg-tp-surface dark:hover:border-tp-hairline-strong ${
            isOver
              ? 'border-tp-primary ring-1 ring-tp-primary'
              : 'border-tp-hairline hover:border-tp-hairline dark:border-tp-hairline'
          } ${isDragging ? 'opacity-40' : ''}`}
          style={{ marginLeft: level > 0 ? `${Math.min(level, 4) * 20 + 8}px` : undefined }}
        >
          {isDragEnabled && (
            <OrgDragHandle
              dragHandleProps={dragHandleProps}
              isDisabled={!canDrag}
              disabledReason={
                org.is_personal
                  ? 'Personal organizations cannot be moved'
                  : 'Only an admin can move this organization'
              }
            />
          )}
          {hasChildren ? (
            <button
              type="button"
              aria-label={isExpanded ? `Collapse ${org.name}` : `Expand ${org.name}`}
              aria-expanded={isExpanded}
              onClick={() => onToggle(org.id)}
              className="relative z-10 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-tp-steel transition-colors hover:bg-tp-hairline"
            >
              <Iconify icon={isExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'} width={14} />
            </button>
          ) : (
            // Lines up leaves with their expandable siblings; a phone keeps the room for the name.
            <span className="hidden h-6 w-6 shrink-0 sm:block" />
          )}

          <OrgAvatar name={org.name} {...avatarProps(org.avatar)} size={level > 0 ? 36 : 44} />

          <div className="min-w-0 flex-1">
            {/* The whole row opens the organization; the controls above sit over the link. */}
            <Link
              to={orgPath(org.slug)}
              className="block truncate text-[15px] font-medium text-tp-ink after:absolute after:inset-0 after:content-[''] dark:text-tp-ink"
            >
              {org.name}
            </Link>
            <p className="truncate text-sm text-tp-steel dark:text-tp-muted">@{org.slug}</p>
            {inherited && (
              <p className="truncate text-xs text-tp-muted">Inherited from {inherited.name}</p>
            )}
          </div>

          {isOver && (
            <span className="shrink-0 rounded-full bg-tp-primary/15 px-2.5 py-1 text-xs font-semibold text-tp-accent">
              drop to move here
            </span>
          )}

          {org.effective_role && <RoleBadge role={org.effective_role} />}

          {isManaged && isDragEnabled && (
            <button
              type="button"
              onClick={() => onMoveRequest(org)}
              aria-label={`Move ${org.name} to…`}
              title="Move to…"
              className="relative z-10 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink"
            >
              <Iconify icon="mdi:dots-horizontal" width={18} />
            </button>
          )}

          <span className="hidden shrink-0 sm:inline-flex">
            <Iconify
              icon="mdi:chevron-right"
              width={18}
              className="text-tp-muted transition-transform group-hover:translate-x-0.5 group-hover:text-tp-steel dark:text-tp-stone"
            />
          </span>
        </div>
      </motion.div>

      <AnimatePresence initial={false}>
        {hasChildren && isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="space-y-2 overflow-hidden pt-2"
          >
            {children.map(child => (
              <OrgTreeNode
                key={child.id}
                org={child}
                level={level + 1}
                expandedIds={expandedIds}
                onToggle={onToggle}
                onMoveRequest={onMoveRequest}
                isDragEnabled={isDragEnabled}
                blockedTargetIds={blockedTargetIds}
                isDragActive={isDragActive}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN PAGE COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function OrganizationsListPage() {
  const { organizations, tree, isLoading, error, page, totalPages, setPage, refresh } =
    useOrganization();
  const [search, setSearch] = useState('');
  const [expandedTreeIds, setExpandedTreeIds] = useState<Set<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [moving, setMoving] = useState<Organization | null>(null);
  const {
    isMoving,
    error: moveError,
    message: moveMessage,
    dismissFeedback,
    move,
  } = useOrgReparenting(refresh);

  const draggedOrg = draggedId ? findInTree(tree, draggedId, childrenOf) : null;

  // A branch cannot land inside itself, and the parent it already has is a no-op rather than a move.
  const blockedTargetIds = useMemo(() => {
    if (!draggedOrg) return new Set<string>();
    const blocked = collectBranchIds(draggedOrg, childrenOf);
    if (draggedOrg.parent_id) blocked.add(draggedOrg.parent_id);
    return blocked;
  }, [draggedOrg]);

  const handleMove = useCallback(
    (organizationId: string, parentId: string | null) => {
      const organization = findInTree(tree, organizationId, childrenOf);
      if (!organization || parentId === organization.parent_id) return;
      if (parentId === null && organization.parent_id === null) return;
      const parent = parentId ? findInTree(tree, parentId, childrenOf) : null;
      if (parent && collectBranchIds(organization, childrenOf).has(parent.id)) return;
      void move({
        organizationId: organization.slug,
        organizationName: organization.name,
        parentId,
        parentName: parent?.name ?? null,
      });
    },
    [tree, move]
  );

  const renderDragPreview = useCallback(
    (organizationId: string) => {
      const organization = findInTree(tree, organizationId, childrenOf);
      if (!organization) return null;
      return (
        <div className="flex items-center gap-3 rounded-lg border border-tp-primary/40 bg-tp-canvas px-4 py-3 shadow-(--shadow-elevation-3)">
          <OrgAvatar name={organization.name} {...avatarProps(organization.avatar)} size={32} />
          <span className="text-sm font-medium text-tp-ink">{organization.name}</span>
        </div>
      );
    },
    [tree]
  );

  const handleToggle = useCallback((id: string) => {
    setExpandedTreeIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const searching = search.trim() !== '';
  const filtered = useMemo(() => filterTree(tree, search), [tree, search]);
  // A search shows every match at once, opened down to it; otherwise one page of top-level nodes.
  const shown = searching
    ? filtered
    : filtered.slice((page - 1) * ORG_PAGE_SIZE, page * ORG_PAGE_SIZE);
  const expandedIds = useMemo(
    () =>
      searching
        ? new Set(filtered.flatMap(org => [...collectBranchIds(org, childrenOf)]))
        : expandedTreeIds,
    [searching, filtered, expandedTreeIds]
  );

  const totalOrgCount = organizations.length;
  // SPHERE's sections: the personal organizations first, then the teams.
  const personalOrgs = useMemo(() => shown.filter(org => org.is_personal), [shown]);
  const otherOrgs = useMemo(() => shown.filter(org => !org.is_personal), [shown]);
  const renderNode = (org: Organization) => (
    <OrgTreeNode
      key={org.id}
      org={org}
      expandedIds={expandedIds}
      onToggle={handleToggle}
      onMoveRequest={setMoving}
      isDragEnabled={!isMoving && !searching}
      blockedTargetIds={blockedTargetIds}
      isDragActive={draggedId !== null}
    />
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Helmet>
        <title>OpenBinding - Your organizations</title>
      </Helmet>

      {/* Header */}
      <motion.div
        initial="hidden"
        animate="visible"
        variants={fadeInUp}
        transition={transitionDefault}
        className="mb-8"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-3xl font-normal tracking-tight text-tp-ink dark:text-tp-ink">
              Your organizations
            </h1>
            <p className="mt-1 text-sm text-tp-steel dark:text-tp-muted">
              {totalOrgCount === 0
                ? 'Get started by creating or joining an organization'
                : `${totalOrgCount} organization${totalOrgCount !== 1 ? 's' : ''}`}
            </p>
          </div>
          <Link
            to="/orgs/new"
            className="inline-flex cursor-pointer items-center gap-2 self-start rounded-md bg-tp-accent px-5 py-2.5 text-sm font-medium text-tp-on-primary shadow-sm transition-all hover:bg-tp-primary-deep hover:shadow-md active:scale-[0.98] sm:self-auto"
          >
            <Iconify icon="mdi:plus" width={18} />
            New organization
          </Link>
        </div>
      </motion.div>

      {/* Search */}
      {!isLoading && totalOrgCount > 0 && (
        <motion.div
          initial="hidden"
          animate="visible"
          variants={fadeInUp}
          transition={{ ...transitionDefault, delay: 0.05 }}
          className="mb-6"
        >
          <div className="relative">
            <Iconify
              icon="mdi:magnify"
              width={20}
              className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-tp-muted"
            />
            <input
              type="text"
              aria-label="Search organizations"
              placeholder="Search organizations..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-11 w-full rounded-md border border-tp-hairline-strong bg-tp-canvas py-2.5 pr-4 pl-10 text-sm text-tp-ink placeholder:text-tp-muted focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/15 focus:outline-none dark:border-tp-hairline dark:bg-tp-surface dark:text-tp-ink dark:placeholder:text-tp-stone dark:focus:border-tp-primary dark:focus:ring-tp-primary/20"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear the search"
                onClick={() => setSearch('')}
                className="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer rounded-full p-0.5 text-tp-muted transition-colors hover:bg-tp-surface hover:text-tp-steel dark:hover:bg-white/5 dark:hover:text-tp-muted"
              >
                <Iconify icon="mdi:close" width={16} />
              </button>
            )}
          </div>
        </motion.div>
      )}

      {/* Loading */}
      {isLoading && <OrgListSkeleton />}

      {/* Load error */}
      {!isLoading && error && (
        <BlockAlert variant="error" className="mb-6">
          <span>{error}</span>{' '}
          <button
            type="button"
            onClick={() => void refresh()}
            className="cursor-pointer font-medium underline"
          >
            Retry
          </button>
        </BlockAlert>
      )}

      {/* Empty state */}
      {!isLoading && !error && totalOrgCount === 0 && (
        <motion.div
          initial="hidden"
          animate="visible"
          variants={fadeInUp}
          transition={{ ...transitionDefault, delay: 0.1 }}
          className="flex flex-col items-center gap-5 rounded-xl border border-dashed border-tp-hairline-strong bg-tp-surface/50 px-4 py-20 dark:border-tp-hairline dark:bg-tp-surface"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-tp-cream dark:bg-tp-cream">
            <Iconify icon="mdi:domain" width={32} className="text-tp-primary" />
          </div>
          <div className="text-center">
            <p className="text-base font-medium text-tp-ink dark:text-tp-ink">
              No organizations yet
            </p>
            <p className="mt-1 text-sm text-tp-steel dark:text-tp-muted">
              Create a new one, or open the invitation link someone shared with you.
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              to="/orgs/new"
              className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-tp-accent px-5 py-2.5 text-sm font-medium text-tp-on-primary transition-all hover:bg-tp-primary-deep active:scale-[0.98]"
            >
              <Iconify icon="mdi:plus" width={18} />
              Create organization
            </Link>
          </div>
        </motion.div>
      )}

      {/* No search results */}
      {!isLoading && totalOrgCount > 0 && filtered.length === 0 && searching && (
        <motion.div
          initial="hidden"
          animate="visible"
          variants={fadeInUp}
          className="flex flex-col items-center gap-4 py-16"
        >
          <Iconify icon="mdi:magnify-close" width={40} className="text-tp-muted" />
          <p className="text-sm text-tp-steel dark:text-tp-muted">
            No organizations match{' '}
            <span className="font-medium text-tp-ink dark:text-tp-ink">&ldquo;{search}&rdquo;</span>
          </p>
        </motion.div>
      )}

      {/* Move feedback */}
      {(moveError || moveMessage) && (
        <div className="mb-4">
          <BlockAlert
            variant={moveError ? 'error' : 'success'}
            message={moveError ?? moveMessage}
            onDismiss={dismissFeedback}
          />
        </div>
      )}

      {/* Organizations */}
      {!isLoading && shown.length > 0 && (
        <OrgDndProvider
          onMove={handleMove}
          onDragChange={setDraggedId}
          renderDragPreview={renderDragPreview}
        >
          <OrgRootDropZone
            label="Drop here to take it out of its parent"
            isDisabled={!draggedOrg || draggedOrg.parent_id === null}
          />
          <motion.div
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className={`space-y-8 ${isMoving ? 'pointer-events-none opacity-60' : ''}`}
          >
            {personalOrgs.length > 0 && (
              <section aria-labelledby="orgs-personal">
                <motion.div variants={fadeInUp}>
                  <h2
                    id="orgs-personal"
                    className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wider text-tp-stone uppercase dark:text-tp-muted"
                  >
                    <Iconify icon="mdi:account-outline" width={14} />
                    Personal
                  </h2>
                </motion.div>
                <div className="space-y-2">{personalOrgs.map(renderNode)}</div>
              </section>
            )}
            {otherOrgs.length > 0 && (
              <section aria-labelledby="orgs-teams">
                <motion.div variants={fadeInUp}>
                  <h2
                    id="orgs-teams"
                    className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wider text-tp-stone uppercase dark:text-tp-muted"
                  >
                    <Iconify icon="mdi:account-group-outline" width={14} />
                    Teams
                  </h2>
                </motion.div>
                <div className="space-y-2">{otherOrgs.map(renderNode)}</div>
              </section>
            )}
          </motion.div>
        </OrgDndProvider>
      )}

      {/* Pagination */}
      {!isLoading && !searching && totalPages > 1 && (
        <div className="mt-8">
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      )}

      {moving && (
        <MoveOrganizationModal
          organization={moving}
          organizations={organizations}
          blockedIds={
            new Set([
              ...collectBranchIds(moving, childrenOf),
              // A personal organization takes no sub-organization.
              ...organizations.filter(org => org.is_personal).map(org => org.id),
            ])
          }
          onClose={() => setMoving(null)}
          onMove={parentId => {
            setMoving(null);
            handleMove(moving.id, parentId);
          }}
        />
      )}
    </div>
  );
}
