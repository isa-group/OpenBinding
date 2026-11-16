import { apiClient, type Revised } from '../../api/client';
import type { RunPresetCreate, RunPresetList, RunPresetUpdate, RunPresetView } from '../../shared/api/types';

/**
 * The run presets of an organization (`/v1/organizations/{org}/presets/…`) over the shared client and the generated types. Every
 * member reads them (below MEMBER the options come redacted, as a run's do); MEMBER and above create, change and delete them, and a
 * non-member gets 404 on every route. Refusals throw as the client throws them; `readApiError` or `classifyAuthError` reads them.
 */

const enc = encodeURIComponent;

const presetsRoot = (org: string) => `/v1/organizations/${enc(org)}/presets`;
const presetRoot = (org: string, preset: string) => `${presetsRoot(org)}/${enc(preset)}`;

/**
 * What a preset holds, as the forms send it. The generated `RunPresetCreate` types `options` and `optimization` as empty objects
 * (the schema says only "object"), so the settings are typed here as the gateway reads them.
 */
export interface PresetSettings {
  engine: RunPresetCreate['engine'];
  registration?: RunPresetCreate['registration'];
  mode?: string | null;
  options?: Record<string, unknown>;
  /** `{type: SINGLE|MULTI|MANY, scalarization, weights?}`; null leaves it to the run. */
  optimization?: PresetOptimization | null;
}

export interface PresetOptimization {
  type: 'SINGLE' | 'MULTI' | 'MANY';
  scalarization: string;
  weights?: Array<{ criteria: string; value: number }>;
}

export type PresetCreate = Omit<RunPresetCreate, keyof PresetSettings | 'description'> & { description?: string } & PresetSettings;
export type PresetUpdate = Omit<RunPresetUpdate, keyof PresetSettings> & Partial<PresetSettings>;

export interface PresetListOptions {
  /** Text in the name or the slug. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** The largest page the presets route serves. */
export const PRESET_PAGE = 200;

function query(options: PresetListOptions): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const revised = <T>(endpoint: string, init: RequestInit = {}) => apiClient.request<Revised<T>>(
  endpoint, init, undefined, true, true,
  async (response) => ({ value: await response.json() as T, etag: response.headers.get('ETag') }),
);

export const presetsApi = {
  /** The organization's presets by name (at most {@link PRESET_PAGE} a page). */
  list: (org: string, options: PresetListOptions = {}) => apiClient.request<RunPresetList>(`${presetsRoot(org)}${query(options)}`),
  /** One preset, by slug or id, with the ETag an edit sends back as `If-Match`. */
  get: (org: string, preset: string) => revised<RunPresetView>(presetRoot(org, preset)),
  /** Needs MEMBER. 409 `slug_conflict` when the slug is taken; 422 `invalid_request_fields` for a setting of the wrong shape. */
  create: (org: string, body: PresetCreate) => revised<RunPresetView>(presetsRoot(org), { method: 'POST', body: JSON.stringify(body) }),
  /** Needs MEMBER. Runs already started keep the settings they copied; with `ifMatch`, 412 when someone changed it meanwhile. */
  update: (org: string, preset: string, body: PresetUpdate, ifMatch: string | null = null) => revised<RunPresetView>(
    presetRoot(org, preset),
    { method: 'PATCH', body: JSON.stringify(body), ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}) },
  ),
  /** Needs MEMBER. Runs started from it keep the settings they copied. */
  remove: (org: string, preset: string) => apiClient.request<void>(presetRoot(org, preset), { method: 'DELETE' }, undefined, true, true),
};
