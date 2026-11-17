// A composition's version graph (`GET …/compositions/{c}/graph`) in the shape of SPHERE's pricing graph
// (core/utils/sphere/graph.ts), so SPHERE's layout (version-graph.ts) runs unchanged on it: a lane per composition, a version
// by its label, and a branch from the version a fork came from.

import type { PricingGraph, PricingGraphLane } from '../../core/utils/sphere/graph';
import type { CompositionGraph } from '../api/compositionsApi';

/** What OpenBinding keeps of a lane beside SPHERE's fields: where its composition opens. */
export interface LaneTarget {
  org: string | null;
  slug: string | null;
}

export function pricingGraphOf(
  graph: CompositionGraph,
  current: string
): { graph: PricingGraph; targets: Map<string, LaneTarget> } {
  const targets = new Map<string, LaneTarget>();
  const lanes: PricingGraphLane[] = graph.lanes.map(lane => {
    targets.set(lane.composition_id, {
      org: lane.organization?.slug ?? null,
      slug: lane.slug ?? null,
    });
    return {
      pricingId: lane.composition_id,
      name: lane.name ?? lane.slug ?? 'A composition you cannot read',
      slug: lane.slug ?? '',
      organization: {
        id: lane.organization?.id ?? '',
        name: lane.organization?.slug ?? '',
        displayName: lane.organization?.name ?? lane.organization?.slug ?? '',
      },
      collectionSlug: null,
      role: lane.role,
      available: lane.available,
      versions: lane.versions.map(version => ({
        id: version.id ?? `${lane.composition_id}:${version.label}`,
        version: version.label,
        createdAt: version.created_at ?? null,
        // A composition's versions are read through the gateway, never by a file URL: a readable one is marked so.
        yaml: lane.available && version.id ? version.id : null,
        addedAt: version.created_at ?? null,
        private: false,
        forkedFrom:
          version.forked_from && version.forked_from.label
            ? { pricingId: version.forked_from.composition_id, version: version.forked_from.label }
            : null,
      })),
    };
  });
  return { graph: { pricingId: current, lanes, truncated: graph.truncated }, targets };
}
