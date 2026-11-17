// Copied verbatim from SPHERE frontend/src/modules/organization/components/org-dnd/row.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useCallback } from 'react';

/** Drop target standing for "no parent at all": the root of the tree. */
export const ORG_ROOT_DROP_ID = '__org-root__';

interface OrgRowDndOptions {
  id: string;
  /** Whether this organization may be picked up and moved elsewhere. */
  canDrag: boolean;
  /** Whether this organization may become the parent of what is being dragged. */
  canDrop: boolean;
}

export interface OrgRowDnd {
  setNodeRef: (element: HTMLElement | null) => void;
  dragHandleProps: Record<string, unknown>;
  isDragging: boolean;
  isOver: boolean;
}

/** Makes one row of the tree both a drag source and a drop target. */
export function useOrgRowDnd({ id, canDrag, canDrop }: OrgRowDndOptions): OrgRowDnd {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id, disabled: !canDrag });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id, disabled: !canDrop });

  const setNodeRef = useCallback(
    (element: HTMLElement | null) => {
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef]
  );

  return {
    setNodeRef,
    dragHandleProps: { ...attributes, ...listeners },
    isDragging,
    isOver: isOver && canDrop,
  };
}
