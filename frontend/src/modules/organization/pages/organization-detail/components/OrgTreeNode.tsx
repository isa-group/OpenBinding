// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/OrgTreeNode.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: each row is a link to the organization's page (middle-click works) instead of a clickable div; a node the
// viewer cannot open is shown locked, without a link; a node is moved by an admin of it (OpenBinding's rule); the drag
// props are taken apart for React 19's compiler.

import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import Iconify from '../../../../core/components/iconify';
import OrgAvatar from '../../../../core/components/org-avatar';
import { avatarProps } from '../../../api/organizationsApi';
import { OrgDragHandle } from '../../../components/org-dnd';
import { useOrgRowDnd } from '../../../components/org-dnd/row';
import { orgPath } from '../../../types/paths';
import type { TreeNode } from '../types';

interface Props {
  node: TreeNode;
  level?: number;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  /** The organizations this viewer administers: only those move, or take a branch. */
  managedIds: Set<string>;
  /** Off while a move is in flight, or when the viewer cannot re-group anything. */
  isDragEnabled?: boolean;
  /** Ids this drag may not land on: the branch being dragged, and its parent. */
  blockedTargetIds?: Set<string>;
  isDragActive?: boolean;
}

export default function OrgTreeNode({
  node,
  level = 0,
  expandedIds,
  onToggle,
  managedIds,
  isDragEnabled = false,
  blockedTargetIds,
  isDragActive = false,
}: Props) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isMovable = isDragEnabled && node.hasAccess && managedIds.has(node.id);
  const canDrop = isMovable && isDragActive && !blockedTargetIds?.has(node.id);
  const { setNodeRef, dragHandleProps, isOver, isDragging } = useOrgRowDnd({
    id: node.id,
    canDrag: isMovable,
    canDrop,
  });

  return (
    <li>
      <div
        ref={setNodeRef}
        className={`group relative flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
          isOver ? 'bg-tp-primary/12 ring-1 ring-tp-primary' : ''
        } ${isDragging ? 'opacity-40' : ''} ${
          node.isCurrent
            ? 'bg-tp-primary/8 ring-1 ring-tp-primary/20'
            : `hover:bg-tp-surface ${node.hasAccess ? '' : 'opacity-60'}`
        }`}
        style={{ paddingLeft: `${Math.min(level, 6) * 20 + 12}px` }}
      >
        {isDragEnabled && (
          <OrgDragHandle
            dragHandleProps={dragHandleProps}
            isDisabled={!isMovable}
            disabledReason="You need to be an admin of this organization to move it"
          />
        )}
        {hasChildren ? (
          <button
            type="button"
            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-expanded={isExpanded}
            onClick={() => onToggle(node.id)}
            className="relative z-10 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-tp-steel transition-colors hover:bg-tp-hairline"
          >
            <Iconify icon={isExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'} width={14} />
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" />
        )}

        <OrgAvatar name={node.name} {...avatarProps(node.avatar)} size={28} square />

        <div className="min-w-0 flex-1">
          {node.isCurrent || !node.hasAccess ? (
            <p
              className={`truncate text-sm text-tp-ink ${node.isCurrent ? 'font-semibold' : 'font-medium'}`}
            >
              {node.name}
              {node.isCurrent && <span className="ml-2 text-[11px] text-tp-accent">(current)</span>}
            </p>
          ) : (
            <Link
              to={orgPath(node.slug)}
              className="block truncate text-sm font-medium text-tp-ink after:absolute after:inset-0 after:content-['']"
            >
              {node.name}
            </Link>
          )}
        </div>

        {isOver && (
          <span className="shrink-0 rounded bg-tp-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-tp-accent">
            drop to move here
          </span>
        )}
        {!node.hasAccess && (
          <span title="You do not belong to this organization" className="shrink-0">
            <Iconify icon="mdi:lock-outline" width={14} className="text-tp-ink" />
            <span className="sr-only">Locked</span>
          </span>
        )}
        {node.isAncestor && (
          <span className="shrink-0 rounded bg-tp-surface px-1.5 py-0.5 text-[10px] font-medium text-tp-steel">
            ancestor
          </span>
        )}
      </div>

      <AnimatePresence initial={false}>
        {hasChildren && isExpanded && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            {node.children.map(child => (
              <OrgTreeNode
                key={child.id}
                node={child}
                level={level + 1}
                expandedIds={expandedIds}
                onToggle={onToggle}
                managedIds={managedIds}
                isDragEnabled={isDragEnabled}
                blockedTargetIds={blockedTargetIds}
                isDragActive={isDragActive}
              />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </li>
  );
}
