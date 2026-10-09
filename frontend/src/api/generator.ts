import {
  apiClient,
  type CalibrateEngineParams,
  type ConvertLegacyParams,
  type CorpusGeneratedResponse,
  type EngineCalibratedResponse,
  type GenerateCorpusParams,
  type GenerateInstanceParams,
  type InstanceGeneratedResponse,
} from './client';

const post = <T>(path: string, body: unknown) =>
  apiClient.request<T>(path, { method: 'POST', body: JSON.stringify(body) }, undefined, true, true);

/**
 * The generator's four operations. `apiClient.generateBimInstance` and its siblings answer a 422 with the error body as if it were
 * the result; the lab has to say "these settings can't be generated", so these throw on every refusal
 * (HttpError for 401, 403, 404, 422…, QuotaError for 402).
 */
export const generatorApi = {
  /** `POST /v1/generator/instances`: one synthetic instance; with `persist` and `project_id` it is also kept as a case. */
  instance: (params: GenerateInstanceParams) => post<InstanceGeneratedResponse>('/v1/generator/instances', params),
  /** `POST /v1/generator/corpus`: a batch of instances, optionally kept in a collection of a project. */
  corpus: (params: GenerateCorpusParams) => post<CorpusGeneratedResponse>('/v1/generator/corpus', params),
  /** `POST /v1/generator/convert-legacy`: an instance in the older research format turned into a BIM package. */
  convertLegacy: (params: ConvertLegacyParams) => post<InstanceGeneratedResponse>('/v1/generator/convert-legacy', params),
  /** `POST /v1/generator/calibrate-engine`: refits the shared model that predicts how an engine behaves (gap L2: the server accepts it more widely than the UI does). */
  calibrate: (params: CalibrateEngineParams) => post<EngineCalibratedResponse>('/v1/generator/calibrate-engine', params),
};
