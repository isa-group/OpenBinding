// The engines' client: the immutable Engine and EngineRegistration resources of the gateway (bim/v1), cut out of the old
// `api/client.ts` monolith. It sends through the application's one transport (`core/api/http`).

import { HttpError, apiClient, HttpTransport } from '../../core/api/http';
import type { ImmutableResourceRef } from '../../core/api/types';

/** How a run ended, in BIM v1 terms. */
export type Termination = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';

export interface BimMetadata {
  namespace: string;
  name: string;
  version: string;
  description?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, unknown>;
}

export interface BimAdapter {
  id: string;
  version: string;
  binaryDigest: string;
}

export interface BimProfileResourceType {
  apiVersion: string;
  kind: string;
  minimum: number;
  maximum?: number;
}

export interface BimProfileRole {
  resourceTypes: BimProfileResourceType[];
  extensionTypes: 'none' | 'installed';
}

export interface BimProfileOutput {
  apiVersion: string;
  kind: string;
  schemaDigest: string;
  engineProtocol: string;
}

export interface BimCapabilityDimension {
  values: string[];
  openValues: boolean;
}

/** One Profile that is backed by an adapter installed in this gateway. */
export interface BimProfile {
  apiVersion: 'bim/v1';
  kind: 'Profile';
  metadata: BimMetadata;
  spec: {
    deterministic: boolean;
    roles: Record<string, BimProfileRole>;
    output: BimProfileOutput;
    capabilityVocabulary: { dimensions: Record<string, BimCapabilityDimension> };
    limitVocabulary: string[];
    adapter: BimAdapter;
    extensions?: Record<string, unknown>;
  };
  id: string;
  digest: string;
  output: BimProfileOutput;
  protocol: string;
  protocolDigest: string;
}

export interface CapabilitySelector {
  selector: 'none' | 'all' | 'only';
  values?: string[];
}

/**
 * One objective scalarization an engine mode offers (`capabilities.scalarizations.values`). That dimension is the one
 * whose values are objects rather than names, so it is read from the document, not through `EngineCapabilities`.
 */
export interface ScalarizationDeclaration {
  id: string;
  objectiveTypes: Array<'SINGLE' | 'MULTI' | 'MANY'>;
  weightPolicy: 'required' | 'optional' | 'forbidden';
}

export interface EngineCapabilities {
  workflowNodes: CapabilitySelector;
  metricScopes: CapabilitySelector;
  aggregations: CapabilitySelector;
  constraints: CapabilitySelector;
  optimization: CapabilitySelector;
  objectiveTypes: CapabilitySelector;
  expressions: CapabilitySelector;
  placement: CapabilitySelector;
  irExtensions: CapabilitySelector;
  /** `scalar`, `interval` (a range). The gateway makes this dimension mandatory for the qos-binding profile. */
  featureValues?: CapabilitySelector;
  featureScopes?: CapabilitySelector;
}

export interface EngineMode {
  id: string;
  profile: string;
  ir: { apiVersion: string; kind: string };
  algorithm: string;
  capabilities: EngineCapabilities;
  optionsSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
  limits: Record<string, number>;
  guarantees: { termination: Termination[]; exact: boolean; [key: string]: unknown };
}

/** One immutable Engine revision advertised by the BIM v1 catalogue. */
export interface EngineCatalogEntry extends ImmutableResourceRef {
  id: string;
  ref: ImmutableResourceRef;
  modes: EngineMode[];
}

export interface EngineManifest {
  apiVersion: 'bim/v1';
  kind: 'Engine';
  metadata: BimMetadata;
  spec: {
    modes: EngineMode[];
    extensions?: Record<string, unknown>;
  };
}

export interface EngineRegistrationManifest {
  apiVersion: 'bim/v1';
  kind: 'EngineRegistration';
  metadata: BimMetadata;
  spec: {
    engine: ImmutableResourceRef;
    endpoint: string;
    protocol: {
      id: 'bim-engine/v1';
      mediaType: 'application/json';
      digest: string;
    };
    mappings: {
      request: string;
      job?: string;
      health: string;
      openapi: string;
    };
    auth: { scheme: 'none' | 'bearer' | 'basic' };
    /** Exact OpenAPI 3.1 document served by the deployment and pinned for review. */
    openapi: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
}

export type EngineRevisionState = 'private' | 'published';
export type EngineRegistrationState = 'private' | 'pending_review' | 'published' | 'rejected';

/** Identity and lifecycle state returned after publishing an immutable Engine. */
export interface EngineRevision extends ImmutableResourceRef {
  status: EngineRevisionState;
}

/** Identity and lifecycle state of an immutable EngineRegistration revision. */
export interface EngineRegistrationRevision extends ImmutableResourceRef {
  status: EngineRegistrationState;
  /** Whether this deployment is enabled for its owner's account. */
  active: boolean;
}

export interface EngineRegistrationReport extends EngineRegistrationRevision {
  openapiDigest: string | null;
  openapi: Record<string, unknown> | null;
  engine: EngineManifest | null;
  report: Record<string, unknown> | null;
}

/** The engine list, and whether it is the public one because the session could not be used (401). */
export interface EngineCatalogResult {
  engines: EngineCatalogEntry[];
  fellBackToPublic: boolean;
}

export function bimResourceKey(ref: ImmutableResourceRef): string {
  return `${ref.namespace}/${ref.name}@${ref.version}#${ref.digest}`;
}

/**
 * An answer of the gateway with the revision it gave the resource: its `ETag`, or `null` when the answer carried none
 * (docs/ERRORS.md, "Conditional writes"). The tag is opaque: it goes back unchanged as `If-Match` and is never read.
 */

function requireExactResourceRef<T extends object>(body: T): T & ImmutableResourceRef {
  for (const field of ['namespace', 'name', 'version', 'digest'] as const) {
    if (
      typeof (body as Record<string, unknown>)[field] !== 'string' ||
      !(body as Record<string, string>)[field]
    ) {
      throw new Error(`The gateway response omitted the immutable resource pin ${field}.`);
    }
  }
  return body as T & ImmutableResourceRef;
}

function engineRegistrationEndpoint(ref: ImmutableResourceRef, action?: string): string {
  const query = new URLSearchParams({
    namespace: ref.namespace,
    version: ref.version,
    digest: ref.digest,
  });
  const suffix = action ? `/${action}` : '';
  return `/v1/engine-registrations/${encodeURIComponent(ref.name)}${suffix}?${query.toString()}`;
}

/** The client over a transport: the application's own, or a test's. */
export function engineClientOf(transport: HttpTransport) {
  const engineClient = {
    /** The public engine catalogue (GET /v1/engines): a visitor gets the built-in and published engines. */
    async getPublicEngines(): Promise<EngineCatalogEntry[]> {
      const body = await transport.request<{ engines: EngineCatalogEntry[] }>('/v1/engines');
      return body.engines || [];
    },

    async getEngines(): Promise<EngineCatalogEntry[]> {
      try {
        const body = await transport.request<{ engines: EngineCatalogEntry[] }>('/v1/engines');
        return body.engines || [];
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          return engineClient.getPublicEngines();
        }
        throw error;
      }
    },

    /**
     * The engines this caller may see. A rejected session (401) falls back to the public list, as `getEngines` does,
     * but says so: the catalog screen tells the reader that their private engines are hidden.
     */
    async getCatalogEngines(): Promise<EngineCatalogResult> {
      try {
        const body = await transport.request<{ engines: EngineCatalogEntry[] }>('/v1/engines');
        return { engines: body.engines || [], fellBackToPublic: false };
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          return { engines: await engineClient.getPublicEngines(), fellBackToPublic: true };
        }
        throw error;
      }
    },

    /**
     * Publish a portable bim/v1 Engine document without inventing UI-only fields.
     * A refused document (422 `invalid_engine`) throws an HttpError whose `diagnostics` say where.
     */
    async createEngine(manifest: EngineManifest): Promise<EngineRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRevision>('/v1/engines', {
          method: 'POST',
          body: JSON.stringify(manifest),
        })
      );
    },

    /** The installed Profiles with the engine protocol each one targets (`GET /v1/engines/protocol`, anonymous). */
    async getProtocolProfiles(): Promise<BimProfile[]> {
      const body = await transport.request<{ profiles: BimProfile[] }>('/v1/engines/protocol');
      return body.profiles || [];
    },

    /** Read the pinned BIM engine protocol digest advertised by the gateway (`GET /v1/engines/protocol`, anonymous). */
    async getBimProfile(): Promise<{
      id: 'qos-binding/v1';
      output: { apiVersion: 'bim/v1'; kind: 'BindingProblem'; schemaDigest: string };
      protocol: 'bim-engine/v1';
      protocolDigest: string;
      digest: string;
    }> {
      const profile = (await engineClient.getProtocolProfiles()).find(
        item => item.id === 'qos-binding/v1'
      );
      const output = profile?.output;
      if (
        !profile ||
        output?.apiVersion !== 'bim/v1' ||
        output?.kind !== 'BindingProblem' ||
        profile.protocol !== 'bim-engine/v1'
      ) {
        throw new Error('The gateway does not advertise the BIM v1 binding profile.');
      }
      if (
        typeof output.schemaDigest !== 'string' ||
        typeof profile.protocolDigest !== 'string' ||
        typeof profile.digest !== 'string'
      ) {
        throw new Error('The gateway did not publish complete immutable BIM profile pins.');
      }
      return profile as {
        id: 'qos-binding/v1';
        output: { apiVersion: 'bim/v1'; kind: 'BindingProblem'; schemaDigest: string };
        protocol: 'bim-engine/v1';
        protocolDigest: string;
        digest: string;
      };
    },

    /** Register private deployment material separately from the portable Engine. */
    async createEngineRegistration(
      manifest: EngineRegistrationManifest
    ): Promise<EngineRegistrationRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationRevision>('/v1/engine-registrations', {
          method: 'POST',
          body: JSON.stringify(manifest),
        })
      );
    },

    async listEngineRegistrations(): Promise<EngineRegistrationRevision[]> {
      const body = await transport.request<{ registrations: EngineRegistrationRevision[] }>(
        '/v1/engine-registrations'
      );
      return (body.registrations || []).map(registration => requireExactResourceRef(registration));
    },

    async getEngineRegistration(ref: ImmutableResourceRef): Promise<EngineRegistrationManifest> {
      return transport.request<EngineRegistrationManifest>(engineRegistrationEndpoint(ref));
    },

    async getEngineRegistrationReport(
      ref: ImmutableResourceRef
    ): Promise<EngineRegistrationReport> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationReport>(engineRegistrationEndpoint(ref, 'report'))
      );
    },

    async activateEngineRegistration(
      ref: ImmutableResourceRef
    ): Promise<EngineRegistrationRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationRevision>(
          engineRegistrationEndpoint(ref, 'activate'),
          {
            method: 'POST',
          }
        )
      );
    },

    async deactivateEngineRegistration(
      ref: ImmutableResourceRef
    ): Promise<EngineRegistrationRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationRevision>(
          engineRegistrationEndpoint(ref, 'deactivate'),
          {
            method: 'POST',
          }
        )
      );
    },

    async deleteEngineRegistration(ref: ImmutableResourceRef): Promise<void> {
      await transport.request<void>(engineRegistrationEndpoint(ref), {
        method: 'DELETE',
      });
    },

    async requestEngineRegistrationPublication(
      ref: ImmutableResourceRef
    ): Promise<EngineRegistrationRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationRevision>(
          engineRegistrationEndpoint(ref, 'publication-request'),
          {
            method: 'POST',
          }
        )
      );
    },

    async setEngineRegistrationCredential(
      ref: ImmutableResourceRef,
      secret: string
    ): Promise<EngineRegistrationRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationRevision>(
          engineRegistrationEndpoint(ref, 'credential'),
          {
            method: 'PUT',
            body: JSON.stringify({ secret }),
          },
          undefined,
          true,
          true
        )
      );
    },

    async adminListEngineRegistrations(): Promise<EngineRegistrationRevision[]> {
      const body = await transport.request<{ registrations: EngineRegistrationRevision[] }>(
        '/v1/engine-registrations?review=true'
      );
      return (body.registrations || []).map(registration => requireExactResourceRef(registration));
    },

    async adminApproveEngineRegistration(
      ref: ImmutableResourceRef
    ): Promise<EngineRegistrationRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationRevision>(
          engineRegistrationEndpoint(ref, 'approve'),
          {
            method: 'POST',
          }
        )
      );
    },

    async adminRejectEngineRegistration(
      ref: ImmutableResourceRef
    ): Promise<EngineRegistrationRevision> {
      return requireExactResourceRef(
        await transport.request<EngineRegistrationRevision>(
          engineRegistrationEndpoint(ref, 'reject'),
          {
            method: 'POST',
          }
        )
      );
    },
  };
  return engineClient;
}

export const engineClient = engineClientOf(apiClient);
