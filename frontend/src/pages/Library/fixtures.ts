import type { ArtifactDraft } from '../../api/library';
import type { LibraryItem, LibraryVersion } from '../../api/libraryItems';
import type { JsonObject } from './contentModel';

/** Shared by the tests of the library screens (and the end-to-end spec): items, versions, drafts and contents as the gateway returns them. */
export const digestOf = (char: string) => `sha256-${char.repeat(64)}`;

export const OWNER_ORG_ID = 'org-isa-demo';

/** A stable id shaped like the gateway's (a UUID), made from the name, so an address can tell an id from a fixed name. */
export function idFor(name: string): string {
  let hash = 7;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 0xffffffffff;
  return `00000000-0000-4000-8000-${hash.toString(16).padStart(12, '0')}`;
}

export function itemOf(name: string, kind: string, display = name, over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: idFor(name), organization_id: OWNER_ORG_ID, namespace: OWNER_ORG_ID, name, display_name: display, kind, description: '', labels: {}, archived: false,
    created_at: '2026-03-05T00:00:00Z', ...over,
  };
}

export function versionOf(item: LibraryItem, label: string, over: Partial<LibraryVersion> = {}): LibraryVersion {
  const n = Number(label) || 1;
  return {
    id: `${item.id}-v${label}`, artifact_id: item.id, ordinal: n,
    ref: { namespace: item.namespace, name: item.name, version: label, versionDigest: digestOf(String(n + 1)) },
    contentDigest: digestOf(String(n + 5)),
    manifest: { mediaType: 'application/json', contracts: [], dependencies: [], kind: item.kind },
    based_on_id: null, public: false, withdrawn: false, created_at: '2026-08-20T10:05:00Z', ...over,
  };
}

export function draftOf(id: string, revision: number, content: ArtifactDraft['payload']['content'], over: Partial<ArtifactDraft> = {}): ArtifactDraft {
  return {
    id, revision, based_on_id: null,
    payload: { content, media_type: 'application/json', contracts: [], dependencies: [] },
    ...over,
  };
}

export const catalogContent = (): JsonObject => ({
  apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', metadata: { name: 'providers-eu' },
  spec: {
    candidates: {
      'payco-eu': { provides: 'service/payment', features: { latency_ms: 180, cost_eur: 0.021, availability: 99.95 }, provider: { resource: 'catalog', id: 'payco' } },
      fastpay: { provides: 'service/payment', features: { latency_ms: 95, cost_eur: 0.034, availability: 99.9 }, provider: { resource: 'catalog', id: 'fastpay' } },
      'stockly-1': { provides: 'service/stock', features: { latency_ms: 40, cost_eur: 0.002, availability: 99.99 }, provider: { resource: 'catalog', id: 'stockly' } },    },
  },
});

/**
 * The same catalog with every kind of range on its stock provider: a closed one, one with no upper limit and one with no lower limit
 * (what the QA gallery and the range screens show). The number of providers and qualities is that of `catalogContent`.
 */
export const catalogRangesContent = (): JsonObject => {
  const content = catalogContent() as { spec: { candidates: Record<string, { features: Record<string, unknown> }> } };
  content.spec.candidates['stockly-1'].features = { latency_ms: { min: 35, max: 60 }, cost_eur: { min: null, max: 0.004 }, availability: { min: 99.5, max: null } };
  return content as unknown as JsonObject;
};

export const rulesContent = (): JsonObject => ({
  apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', metadata: { name: 'sla-hard' },
  spec: {
    constraints: {
      'sla-latency': { assert: 'features.latency_ms <= 600', enforcement: 'hard' },
      'sla-availability': { assert: 'features.availability >= 99.9', enforcement: 'soft', penalty: 5 },
    },
  },
});

export const goalContent = (): JsonObject => ({
  apiVersion: 'qos-binding/v1', kind: 'Optimization', metadata: { name: 'weighted' },
  spec: {
    penalties: [{ constraint: { resource: 'rules', id: 'sla-availability' }, weight: 5 }],
    criteria: [
      { id: 'cost', feature: { resource: 'app', id: 'cost_eur' }, weight: 0.6, direction: 'minimize' },
      { id: 'latency', feature: { resource: 'app', id: 'latency_ms' }, weight: 0.4, direction: 'minimize' },
    ],
  },
});

export const bpmnContent = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">
  <bpmn:process id="Process_1">
    <bpmn:serviceTask id="Task_1" name="Authenticate" />
    <bpmn:serviceTask id="Task_2" name="Pay" />
  </bpmn:process>
</bpmn:definitions>
`;
