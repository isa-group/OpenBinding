// Copied verbatim from SPHERE frontend/src/modules/organization/components/org-dnd/tree.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

/** Walks an organization tree without caring how its children are spelled. */
type ChildrenOf<T> = (node: T) => T[];

/** The node with the given id, searched depth-first across every root. */
export function findInTree<T extends { id: string }>(
  roots: T[],
  id: string,
  childrenOf: ChildrenOf<T>
): T | null {
  for (const root of roots) {
    if (root.id === id) {
      return root;
    }

    const found = findInTree(childrenOf(root), id, childrenOf);
    if (found) {
      return found;
    }
  }

  return null;
}

/**
 * The ids of a node and everything below it.
 *
 * A branch cannot be dropped inside itself — that would detach it from the
 * tree — so these are the targets a drag has to refuse.
 */
export function collectBranchIds<T extends { id: string }>(
  node: T,
  childrenOf: ChildrenOf<T>
): Set<string> {
  const ids = new Set<string>();

  const walk = (current: T) => {
    ids.add(current.id);
    childrenOf(current).forEach(walk);
  };

  walk(node);

  return ids;
}
