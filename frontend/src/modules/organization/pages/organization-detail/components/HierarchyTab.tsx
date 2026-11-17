// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/HierarchyTab.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the gateway's flat branch (by slug, with `has_access`); an admin of both ends moves an organization (OpenBinding's
// rule), refused moves read as sentences; "Add child" opens the creation dialog; the rows are links.

import { motion } from 'framer-motion';
import { useCallback, useMemo, useState } from 'react';
import BlockAlert from '../../../../core/components/block-alert';
import Iconify from '../../../../core/components/iconify';
import OrgAvatar from '../../../../core/components/org-avatar';
import { transitionDefault } from '../../../../core/utils/motion-variants';
import { avatarProps, type Organization } from '../../../api/organizationsApi';
import { OrgDndProvider, OrgRootDropZone } from '../../../components/org-dnd';
import { collectBranchIds, findInTree } from '../../../components/org-dnd/tree';
import { useOrgReparenting } from '../../../hooks/useOrgReparenting';
import type { TreeNode } from '../types';
import OrgTreeNode from './OrgTreeNode';

interface Props {
  org: Organization;
  canManage: boolean;
  hierarchyTree: TreeNode | null;
  /** The account's organizations, with its role in each. */
  organizations: Organization[];
  expandedTreeIds: Set<string>;
  onToggle: (id: string) => void;
  onCreateSubOrg: () => void;
  /** Reloads the organization once the tree has changed under it. */
  onMoved: () => void | Promise<void>;
}

const childrenOf = (node: TreeNode) => node.children;

export default function HierarchyTab({
  org,
  canManage,
  hierarchyTree,
  organizations,
  expandedTreeIds,
  onToggle,
  onCreateSubOrg,
  onMoved,
}: Props) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const { isMoving, error, message, dismissFeedback, move } = useOrgReparenting(onMoved);
  const roots = useMemo(() => (hierarchyTree ? [hierarchyTree] : []), [hierarchyTree]);
  const draggedNode = draggedId ? findInTree(roots, draggedId, childrenOf) : null;
  const managedIds = useMemo(
    () =>
      new Set(
        organizations
          .filter(item => item.effective_role === 'OWNER' || item.effective_role === 'ADMIN')
          .map(item => item.id)
      ),
    [organizations]
  );

  // A branch cannot land inside itself, and dropping it back on the parent it already has would be a no-op.
  const blockedTargetIds = useMemo(() => {
    if (!draggedNode) return new Set<string>();
    const blocked = collectBranchIds(draggedNode, childrenOf);
    if (draggedNode.parentId) blocked.add(draggedNode.parentId);
    return blocked;
  }, [draggedNode]);

  const handleMove = useCallback(
    (organizationId: string, parentId: string | null) => {
      const node = findInTree(roots, organizationId, childrenOf);
      if (!node || (parentId === null && node.parentId === null)) return;
      const parent = parentId ? findInTree(roots, parentId, childrenOf) : null;
      void move({
        organizationId: node.slug,
        organizationName: node.name,
        parentId,
        parentName: parent?.name ?? null,
      });
    },
    [roots, move]
  );

  const renderDragPreview = useCallback(
    (organizationId: string) => {
      const node = findInTree(roots, organizationId, childrenOf);
      if (!node) return null;
      return (
        <div className="flex items-center gap-2 rounded-lg border border-tp-primary/40 bg-tp-canvas px-3 py-2 shadow-(--shadow-elevation-3)">
          <OrgAvatar name={node.name} {...avatarProps(node.avatar)} size={24} square />
          <span className="text-sm font-medium text-tp-ink">{node.name}</span>
        </div>
      );
    },
    [roots]
  );

  const hasChildren = Boolean(
    hierarchyTree && (hierarchyTree.children.length > 0 || hierarchyTree.id !== org.id)
  );

  return (
    <motion.section
      key="hierarchy"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transitionDefault}
      aria-label="Hierarchy"
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="flex flex-col gap-3 border-b border-tp-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg text-tp-ink">Organization hierarchy</h2>
          <p className="text-xs text-tp-steel">
            {org.parent_id
              ? 'Ancestors above, descendants below. A locked organization is one you do not belong to.'
              : 'This is a root organization. All descendants are shown below.'}
          </p>
          {canManage && (
            <p className="mt-1 text-xs text-tp-steel">
              Drag an organization by its grip onto another to make it a child. You must be an admin
              of both ends of the move.
            </p>
          )}
        </div>
        {canManage && (
          <button
            type="button"
            onClick={onCreateSubOrg}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 py-2 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-primary-deep"
          >
            <Iconify icon="mdi:plus" width={16} />
            Add child
          </button>
        )}
      </div>

      {(error || message) && (
        <div className="px-5 pt-4">
          <BlockAlert
            variant={error ? 'error' : 'success'}
            message={error ?? message}
            onDismiss={dismissFeedback}
          />
        </div>
      )}

      <div className={`p-3 ${isMoving ? 'pointer-events-none opacity-60' : ''}`}>
        {hierarchyTree && !hasChildren ? (
          <div className="flex flex-col items-center gap-2 py-12 text-tp-ink">
            <Iconify icon="mdi:graph-outline" width={32} />
            <p className="text-sm">No sub-organizations yet.</p>
            {canManage && (
              <button
                type="button"
                onClick={onCreateSubOrg}
                className="mt-1 cursor-pointer text-sm font-medium text-tp-accent hover:underline"
              >
                Create the first sub-organization
              </button>
            )}
          </div>
        ) : hierarchyTree ? (
          <OrgDndProvider
            onMove={handleMove}
            onDragChange={setDraggedId}
            renderDragPreview={renderDragPreview}
          >
            <OrgRootDropZone
              label="Drop here to take it out of its parent"
              isDisabled={!draggedNode || draggedNode.parentId === null}
            />
            <ul aria-label="Organization tree">
              <OrgTreeNode
                node={hierarchyTree}
                expandedIds={expandedTreeIds}
                onToggle={onToggle}
                managedIds={managedIds}
                isDragEnabled={canManage && !isMoving}
                blockedTargetIds={blockedTargetIds}
                isDragActive={draggedId !== null}
              />
            </ul>
          </OrgDndProvider>
        ) : (
          <div
            className="flex items-center justify-center py-12"
            role="status"
            aria-label="Loading the hierarchy"
          >
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-tp-hairline border-b-tp-primary" />
          </div>
        )}
      </div>
    </motion.section>
  );
}
