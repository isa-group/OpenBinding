import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface CandidateEvaluation {
  engine: string;
  mode: string;
  latency: number;
  quality: number;
  failureRisk: number;
  credits: number;
  confidence: number;
  isExact: boolean;
  isAvailable: boolean;
}

export interface HardConstraints {
  maxTimeBudgetMs?: number;
  maxCredits?: number;
  minQuality?: number;
  maxFailureRisk?: number;
  minConfidence?: number;
  requireExact?: boolean;
}

export interface PreferenceWeights {
  quality?: number;
  latency?: number;
  costCredits?: number;
  reliability?: number;
}

export interface RoutingRequest {
  candidates: CandidateEvaluation[];
  hardConstraints?: HardConstraints;
  weights?: PreferenceWeights;
}

export interface CandidateResult {
  engine: string;
  mode: string;
  admissible: boolean;
  rejectionReason?: string;
  utility?: number;
  predicted: {
    latency: number;
    quality: number;
    failureRisk: number;
    credits: number;
    confidence: number;
  };
}

export interface RoutingResult {
  termination: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE';
  selected?: CandidateResult;
  fallback?: CandidateResult;
  evaluations: CandidateResult[];
  explanation: string;
}

export class MetaRoutingSolver {
  private runMiniZinc(
    candidates: CandidateEvaluation[],
    constraints: HardConstraints,
    weights: PreferenceWeights,
    maxObsLatency: number,
    maxObsCredits: number
  ): { selectedIndex: number; utility: number } | 'INFEASIBLE' | null {
    try {
      const modelPath = path.resolve(__dirname, '../model/meta_routing.mzn');
      if (!fs.existsSync(modelPath)) return null;

      const n = candidates.length;
      const latencyArr = `[${candidates.map((c) => c.latency.toFixed(4)).join(', ')}]`;
      const qualityArr = `[${candidates.map((c) => c.quality.toFixed(4)).join(', ')}]`;
      const failureRiskArr = `[${candidates.map((c) => c.failureRisk.toFixed(4)).join(', ')}]`;
      const creditsArr = `[${candidates.map((c) => c.credits.toFixed(4)).join(', ')}]`;
      const confidenceArr = `[${candidates.map((c) => c.confidence.toFixed(4)).join(', ')}]`;
      const isExactArr = `[${candidates.map((c) => (c.isExact ? 'true' : 'false')).join(', ')}]`;
      const isAvailArr = `[${candidates.map((c) => (c.isAvailable ? 'true' : 'false')).join(', ')}]`;

      const maxTimeBudget =
        constraints.maxTimeBudgetMs != null ? (constraints.maxTimeBudgetMs / 1000.0).toFixed(4) : '3600.0';
      const maxCredits = constraints.maxCredits != null ? constraints.maxCredits.toFixed(4) : '1000000.0';
      const minQuality = (constraints.minQuality != null ? constraints.minQuality : 0.0).toFixed(4);
      const maxFailureRisk = (constraints.maxFailureRisk != null ? constraints.maxFailureRisk : 0.50).toFixed(4);
      const minConfidence = (constraints.minConfidence != null ? constraints.minConfidence : 0.0).toFixed(4);
      const requireExact = Boolean(constraints.requireExact) ? 'true' : 'false';

      const wQ = (weights.quality ?? 0.40).toFixed(4);
      const wL = (weights.latency ?? 0.30).toFixed(4);
      const wC = (weights.costCredits ?? 0.20).toFixed(4);
      const wR = (weights.reliability ?? 0.10).toFixed(4);

      const maxLatScale = Math.max(0.001, maxObsLatency).toFixed(4);
      const maxCredScale = Math.max(0.001, maxObsCredits).toFixed(4);

      const dznData = `n_candidates=${n}; latency=${latencyArr}; quality=${qualityArr}; failure_risk=${failureRiskArr}; credits=${creditsArr}; confidence=${confidenceArr}; is_exact=${isExactArr}; is_available=${isAvailArr}; max_time_budget=${maxTimeBudget}; max_credits=${maxCredits}; min_quality=${minQuality}; max_failure_risk=${maxFailureRisk}; min_confidence=${minConfidence}; require_exact=${requireExact}; weight_quality=${wQ}; weight_latency=${wL}; weight_cost=${wC}; weight_reliability=${wR}; max_latency_scale=${maxLatScale}; max_credits_scale=${maxCredScale};`;

      const result = spawnSync('minizinc', ['--solver', 'gecode', modelPath, '-D', dznData], {
        encoding: 'utf-8',
        timeout: 2000,
      });

      if (result.error || result.status !== 0) {
        if (result.stdout && result.stdout.includes('=====UNSATISFIABLE=====')) {
          return 'INFEASIBLE';
        }
        return null;
      }

      const out = result.stdout;
      if (out.includes('=====UNSATISFIABLE=====')) {
        return 'INFEASIBLE';
      }

      const jsonStart = out.indexOf('{');
      const jsonEnd = out.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(out.slice(jsonStart, jsonEnd + 1));
        const idx = Number(parsed.selected);
        const utility = Number(parsed.utility);
        if (Number.isInteger(idx) && idx >= 1 && idx <= n) {
          return { selectedIndex: idx - 1, utility: Math.round(utility * 10000) / 10000 };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  solve(request: RoutingRequest): RoutingResult {
    const candidates = request.candidates || [];
    if (candidates.length === 0) {
      return {
        termination: 'INFEASIBLE',
        evaluations: [],
        explanation: 'No candidate engines provided',
      };
    }

    const constraints = request.hardConstraints || {};
    const maxLatencyS = constraints.maxTimeBudgetMs != null ? constraints.maxTimeBudgetMs / 1000.0 : 3600.0;
    const maxCredits = constraints.maxCredits != null ? constraints.maxCredits : Infinity;
    const minQuality = constraints.minQuality != null ? constraints.minQuality : 0.0;
    const maxFailureRisk = constraints.maxFailureRisk != null ? constraints.maxFailureRisk : 0.50;
    const minConfidence = constraints.minConfidence != null ? constraints.minConfidence : 0.0;
    const requireExact = Boolean(constraints.requireExact);

    const weights = request.weights || {};
    const wQ = weights.quality ?? 0.40;
    const wL = weights.latency ?? 0.30;
    const wC = weights.costCredits ?? 0.20;
    const wR = weights.reliability ?? 0.10;

    const maxObsLatency = Math.max(1.0, ...candidates.map((c) => c.latency));
    const maxObsCredits = Math.max(1.0, ...candidates.map((c) => c.credits));

    const evaluations: CandidateResult[] = [];
    const admissibleList: Array<{ cand: CandidateResult; utility: number }> = [];

    for (const cand of candidates) {
      const reasons: string[] = [];
      if (!cand.isAvailable) {
        reasons.push('Engine is marked unavailable or degraded');
      }
      if (cand.latency > maxLatencyS) {
        reasons.push(`Estimated latency ${cand.latency.toFixed(2)}s exceeds max time budget ${maxLatencyS.toFixed(2)}s`);
      }
      if (cand.credits > maxCredits) {
        reasons.push(`Estimated credits ${cand.credits} exceeds max allowed credits ${maxCredits}`);
      }
      if (cand.quality < minQuality) {
        reasons.push(`Expected quality ${cand.quality.toFixed(2)} is below minimum ${minQuality.toFixed(2)}`);
      }
      if (cand.failureRisk > maxFailureRisk) {
        reasons.push(`Failure risk ${cand.failureRisk.toFixed(2)} exceeds threshold ${maxFailureRisk.toFixed(2)}`);
      }
      if (cand.confidence < minConfidence) {
        reasons.push(`Confidence ${cand.confidence.toFixed(2)} is below minimum required ${minConfidence.toFixed(2)}`);
      }
      if (requireExact && !cand.isExact) {
        reasons.push('Algorithm is heuristic but exact solution was required');
      }

      const isAdmissible = reasons.length === 0;
      const predicted = {
        latency: cand.latency,
        quality: cand.quality,
        failureRisk: cand.failureRisk,
        credits: cand.credits,
        confidence: cand.confidence,
      };

      if (!isAdmissible) {
        evaluations.push({
          engine: cand.engine,
          mode: cand.mode,
          admissible: false,
          rejectionReason: reasons.join('; '),
          predicted,
        });
      } else {
        const normLatency = cand.latency / maxObsLatency;
        const normCredits = cand.credits / maxObsCredits;
        const utility = wQ * cand.quality - wL * normLatency - wC * normCredits - wR * cand.failureRisk;
        const roundedUtility = Math.round(utility * 10000) / 10000;

        const resultItem: CandidateResult = {
          engine: cand.engine,
          mode: cand.mode,
          admissible: true,
          utility: roundedUtility,
          predicted,
        };
        evaluations.push(resultItem);
        admissibleList.push({ cand: resultItem, utility: roundedUtility });
      }
    }

    if (admissibleList.length === 0) {
      return {
        termination: 'INFEASIBLE',
        evaluations,
        explanation: 'All candidate engines were rejected by hard constraints',
      };
    }

    admissibleList.sort((a, b) => b.utility - a.utility);

    // Attempt MiniZinc solver execution
    const mznResult = this.runMiniZinc(candidates, constraints, weights, maxObsLatency, maxObsCredits);
    if (mznResult === 'INFEASIBLE') {
      return {
        termination: 'INFEASIBLE',
        evaluations,
        explanation: 'MiniZinc CSP proved infeasibility under given constraints',
      };
    }

    let selected: CandidateResult;
    let fallback: CandidateResult | undefined;
    let explanation: string;

    if (mznResult && typeof mznResult === 'object' && mznResult.selectedIndex >= 0) {
      const mznCandidate = candidates[mznResult.selectedIndex];
      const matched = admissibleList.find(
        (a) => a.cand.engine === mznCandidate.engine && a.cand.mode === mznCandidate.mode
      );
      selected = matched ? matched.cand : admissibleList[0].cand;
      fallback = admissibleList.find((a) => a.cand !== selected)?.cand;
      explanation = `Selected ${selected.engine} (${selected.mode}) with utility score ${selected.utility ?? mznResult.utility} via MiniZinc CSP optimization`;
    } else {
      selected = admissibleList[0].cand;
      fallback = admissibleList.length > 1 ? admissibleList[1].cand : undefined;
      explanation = `Selected ${selected.engine} (${selected.mode}) with utility score ${selected.utility} satisfying all constraints`;
    }

    return {
      termination: 'OPTIMAL',
      selected,
      fallback,
      evaluations,
      explanation,
    };
  }
}
