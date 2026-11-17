// Copied verbatim from SPHERE frontend/src/modules/pricing/types/graph.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md. A composition's graph is turned into this shape
// (composition/utils/graph.ts), so the layout runs unchanged.

/** A version in a pricing's version graph. */
export interface PricingGraphVersion {
  id: string;
  version: string;
  /** Null for a version of a source the viewer may not read: only its label is known. */
  createdAt: string | null;
  /** URL of its YAML; null for a version the viewer may not read. */
  yaml: string | null;
  /** When SPHERE received it (set by the server): orders versions independently of `createdAt`. */
  addedAt: string | null;
  private: boolean;
  /** The version it was forked from, by pricing and label: an edge of the graph. */
  forkedFrom: { pricingId: string; version: string } | null;
}

/** One pricing of a version graph, drawn as a lane. */
export interface PricingGraphLane {
  pricingId: string;
  name: string;
  slug: string;
  organization: { id: string; name: string; displayName: string };
  collectionSlug: string | null;
  /** The pricing shown, or the one it was forked from. */
  role: 'current' | 'source';
  /** False for a source the viewer may not read. */
  available: boolean;
  versions: PricingGraphVersion[];
}

export interface PricingGraph {
  pricingId: string;
  lanes: PricingGraphLane[];
  /** More sources exist than were drawn. */
  truncated: boolean;
}
