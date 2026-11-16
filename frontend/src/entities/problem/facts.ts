import { bimApi } from '../../api/bim';
import { apiClient, HttpError } from '../../api/client';
import type { FeatureRange, FeatureValue } from '../../utils/featureRange';
import type { ProblemFacts } from '../../shared/api/types';

/**
 * The facts of a compiled problem (`GET …/compilations/{compilation}/facts`, A5): tasks with the candidates each can take and
 * their written names, candidate values with units and origins, the workflow in the Composition2Yaml shape, constraints,
 * objectives and the binding-space size. They are the only thing the workflow graph and the candidate matrix read; the
 * compiled IR is never read in the browser.
 */

const enc = encodeURIComponent;

const factsPath = (org: string, problem: string, revision: number | string, compilation: string) =>
  `/v1/organizations/${enc(org)}/problems/${enc(problem)}/revisions/${enc(String(revision))}/compilations/${enc(compilation)}/facts`;

interface Cached {
  etag: string | null;
  facts: ProblemFacts;
}

/** By URL. A compilation never changes, so a cached copy is revalidated (`If-None-Match`) and kept on 304. */
const cache = new Map<string, Cached>();

/** Forget every cached answer (tests start from an empty cache). */
export function clearProblemFactsCache(): void {
  cache.clear();
}

export const problemFactsApi = {
  /** The facts of one compilation (an id or a `compilation_digest`) of a revision of a problem. */
  async get(org: string, problem: string, revision: number | string, compilation: string): Promise<ProblemFacts> {
    const url = factsPath(org, problem, revision, compilation);
    const cached = cache.get(url);
    try {
      const answer = await apiClient.request<Cached>(
        url,
        cached?.etag ? { headers: { 'If-None-Match': cached.etag } } : {},
        undefined,
        true,
        true,
        async (response) => ({ facts: await response.json() as ProblemFacts, etag: response.headers.get('ETag') }),
      );
      cache.set(url, answer);
      return answer.facts;
    } catch (caught) {
      if (cached && caught instanceof HttpError && caught.status === 304) return cached.facts;
      throw caught;
    }
  },

  /**
   * The facts of a package that is not stored (`POST /v1/bim/validate?include=facts`, anonymous allowed): what an editor draws
   * before saving. Throws as `bimApi.validate` does (a 422 carries the located diagnostics).
   */
  async validate(archive: Uint8Array, signal?: AbortSignal): Promise<ProblemFacts> {
    const answer = await bimApi.validate(archive, { include: ['facts'], signal });
    if (!answer.facts) throw new HttpError(422, 'The gateway did not return the facts of the package.');
    return answer.facts;
  },
};

const isRange = (value: FeatureValue): value is FeatureRange => typeof value === 'object' && value !== null;

/**
 * Does any candidate of any catalog hold a range? That is what the gateway looks at to decide whether an engine mode must
 * declare `interval` values, not only the candidates a task can take. A shape test on the facts, nothing is evaluated.
 */
export function hasRanges(facts: ProblemFacts): boolean {
  return facts.candidates.some((candidate) => Object.values(candidate.values).some(isRange));
}

export interface RangeCandidate {
  task: string;
  /** The candidate as the problem writes it for this task (`written`). */
  candidate: string;
  features: Array<{ name: string; value: FeatureRange }>;
}

/** The candidates each task can take that declare a range, with the features that are one: what an engine without interval values refuses. */
export function rangeCandidates(facts: ProblemFacts): RangeCandidate[] {
  const byKey = new Map(facts.candidates.map((candidate) => [candidate.key, candidate]));
  return facts.tasks.flatMap((task) => task.eligible.flatMap((eligible) => {
    const values = byKey.get(eligible.candidate)?.values ?? {};
    const features = Object.entries(values).flatMap(([name, value]) => (isRange(value) ? [{ name, value }] : []));
    return features.length ? [{ task: task.id, candidate: eligible.written, features }] : [];
  }));
}
