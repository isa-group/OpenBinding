# Self-Adaptive Engine Routing User Guide

This guide explains how to use intelligent engine routing in OpenBinding to automatically select the optimal solver for your `BindingProblem` based on quality, latency, cost, and reliability constraints.

---

## 1. Using Dynamic Routing (`engine: "auto"`)

When submitting a job via `POST /v1/jobs`, specify `"engine": "auto"` to activate the self-adaptive router.

### Minimal Example

```json
{
  "snapshot": "c8a41297-9e4a-4c28-97c3-324b11f67890",
  "engine": "auto"
}
```

The router analyzes the instance characteristics (problem size, constraint density, number of tasks, objectives) and solver runtime health to pick the best engine.

---

## 2. Setting Hard Constraints and Soft Preferences

You can customize routing decisions by providing a `routing` object inside `options`.

### Complete Example

```json
{
  "snapshot": "c8a41297-9e4a-4c28-97c3-324b11f67890",
  "engine": "auto",
  "options": {
    "time_budget_ms": 15000,
    "routing": {
      "strategy": "auto",
      "profile": "balanced",
      "hardConstraints": {
        "maxCredits": 40,
        "maxTimeBudgetMs": 15000,
        "minQuality": 0.85,
        "requireExact": false,
        "minConfidence": 0.60,
        "maxFailureRisk": 0.30
      },
      "softPreferences": {
        "weights": {
          "quality": 0.40,
          "latency": 0.30,
          "costCredits": 0.20,
          "reliability": 0.10
        }
      },
      "adaptation": {
        "allowFallback": true,
        "fallbackTimeoutMs": 3000
      }
    }
  }
}
```

### Supported Hard Constraints

Any engine violating any hard constraint is eliminated from consideration:

| Constraint | Type | Description |
| :--- | :--- | :--- |
| `maxCredits` | `integer` | Maximum allowed credit/capacity unit cost for the execution. |
| `maxTimeBudgetMs` | `integer` | Maximum predicted execution latency budget in milliseconds. |
| `minQuality` | `number [0.0, 1.0]` | Minimum acceptable expected objective solution quality. |
| `requireExact` | `boolean` | If `true`, non-exact solvers (such as heuristics) are pruned. |
| `minConfidence` | `number [0.0, 1.0]` | Minimum empirical observation confidence required for the engine. |
| `maxFailureRisk` | `number [0.0, 1.0]` | Maximum acceptable probability of solver timeout or failure. |

### Soft Preferences (Scoring Weights)

Remaining candidate engines are scored using Simple Additive Weighting (SAW) normalized between 0.0 and 1.0. You can supply custom weights under `softPreferences.weights`:

- `quality` (higher is better)
- `latency` (lower latency gives higher utility)
- `costCredits` (lower cost gives higher utility)
- `reliability` (lower failure risk gives higher utility)
- `confidence` (higher historical data density gives higher utility)

---

## 3. Provenance and Trazabilidad

Once your job is accepted and processed, the routing decision is recorded in the job's `provenance`:

### Standard User View (`provenance.engineRouting`)

```json
{
  "engineRouting": {
    "selectedEngine": "evolutionary-heuristics",
    "selectedMode": "elitist-genetic",
    "adaptationReason": "Selected evolutionary-heuristics (elitist-genetic) with utility score 0.884 satisfying all constraints",
    "utilityScore": 0.884,
    "creditsCost": 8
  }
}
```

### Administrative View (`provenance.engineRoutingAdmin`)

Administrators or callers with system permissions see extended diagnostic telemetry:

```json
{
  "engineRoutingAdmin": {
    "adaptationLoopId": "c479e0a2-...",
    "workloadFeatures": {
      "S": 12.3,
      "D_constr": 2.1,
      "N_tasks": 10,
      "N_cap": 15,
      "OptMode": "single",
      "D_obj": 1,
      "T_budget": 15.0
    },
    "engineHealthSnapshot": {
      "minizinc-csp": {"available": true, "activeJobs": 1, "healthStatus": "HEALTHY", "confidence": 0.85},
      "evolutionary-heuristics": {"available": true, "activeJobs": 0, "healthStatus": "HEALTHY", "confidence": 0.95}
    },
    "candidateEvaluations": [
      {
        "engine": "minizinc-csp",
        "predicted": {"latency": 8.4, "quality": 1.0, "failureRisk": 0.45, "credits": 35},
        "admissible": false,
        "rejectionReason": "Failure risk 0.45 exceeds threshold 0.30 under phase transition"
      },
      {
        "engine": "evolutionary-heuristics",
        "predicted": {"latency": 2.2, "quality": 0.94, "failureRisk": 0.01, "credits": 8},
        "admissible": true,
        "utility": 0.884
      }
    ],
    "actualExecution": {
      "actualLatency": 2.15,
      "actualQuality": 0.94,
      "actualCredits": 8,
      "residualLatency": -0.05
    }
  }
}
```

---

## 4. Capacity Units and Quotas

OpenBinding charges computational work according to the **Capacity Abstraction Model**:

- Fast stochastic solvers (`random-search`): **1 CU**
- Genetic / heuristic algorithms (`evolutionary-heuristics`): **8 CUs**
- Exact constraint solvers (`minizinc-csp`): **35 CUs**
- Dynamic Meta-Router (`meta-router-csp`): **0 CUs** (exempt)

Your quota is tracked under `capacityUnits` based on your account plan (e.g. Basic: 5,000 CU, Advanced: 100,000 CU, Research: 1,000,000 CU).

---

## 5. Administration & Observability APIs

Administrative users can inspect real-time routing metrics and manage model drift:

### 1. Engine Health & Metrics

```http
GET /v1/admin/engine-routing/metrics
```

Returns current engine health status, active in-flight jobs, 1-hour failure rates, average latency, and CUSUM drift statistics.

### 2. Historical Observations

```http
GET /v1/admin/engine-routing/observations?engine=minizinc-csp&limit=50
```

Queries stored `AdaptationObservation` records containing workload vectors, candidate predictions, and execution residuals.

### 3. Model Recalibration

```http
POST /v1/admin/engine-routing/recalibrate
```

Triggers model parameter updates using collected historical telemetry residuals and resets CUSUM drift counters.
