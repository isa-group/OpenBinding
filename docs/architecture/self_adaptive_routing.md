# Self-Adaptive Engine Routing Architecture

## Overview

The OpenBinding platform incorporates an autonomic **MAPE-K** (Monitor-Analyze-Plan-Execute over Knowledge) self-adaptive routing loop. When a binding job is submitted with `"engine": "auto"`, the platform optimizes solver engine selection dynamically based on workload characteristics, solver runtime health, predictive quality-of-service (QoS) models, and multi-criteria constraints.

This document describes the architectural foundations, formal models, and operational mechanics of the autonomic routing subsystem.

---

## 1. Architectural Foundations: The MAPE-K Loop

The self-adaptive routing subsystem implements the classical autonomic control loop:

```
      +-------------------------------------------------------------+
      |                          Knowledge                          |
      |   (Historical telemetry, Capacity models, CUSUM drift,      |
      |          AdaptationObservations in PostgreSQL)              |
      +-------^------------------^------------------+---------------+
              |                  |                  |
      +-------+-------+  +-------+--------+  +------+------+  +-------------+
      |    Monitor    |->|    Analyze     |->|    Plan     |->|   Execute   |
      | (Health stats,|  | (Discrepancy & |  | (Multi-obj  |  | (Dispatch to|
      |  Telemetry)   |  |  CUSUM drift)  |  |  QACO/CSP)  |  |  target)    |
      +---------------+  +----------------+  +-------------+  +-------------+
```

### Components

1. **Monitor (`HealthMonitor`)**:
   - Continuously tracks runtime engine states: availability, in-flight concurrency, sliding-window error rates, and latency.
   - Computes statistical confidence metrics $\gamma(e, \mathbf{x}(P))$ reflecting observation density in local workload feature neighborhoods.
   - Automatically transitions engines into `DEGRADED` state when consecutive failures exceed configured thresholds or circuit breakers trip.

2. **Analyze (`DiscrepancyAnalyzer`)**:
   - Evaluates residuals between predictive QoS expectations and observed telemetry:
     - Latency residual: $e_L = \tau_{\text{obs}} - \hat{L}$
     - Quality residual: $e_Q = Q_{\text{obs}} - \hat{Q}$
     - Resource residual: $e_R = R_{\text{obs}} - \hat{R}$
   - Executes Cumulative Sum (**CUSUM**) control chart monitoring to detect systematic concept drift or solver degradation.

3. **Plan (`MetaQACO` / `meta-router-csp`)**:
   - Solves an ephemeral single-task multi-criteria optimization problem:
     - **Hard Constraints**: Filter non-admissible engines violating latency budgets ($T_{\text{budget}}$), credit limits ($R_{\text{max}}$), minimum quality ($Q_{\text{min}}$), exactness requirements, or maximum failure risks.
     - **Soft Preferences**: Evaluates Simple Additive Weighting (SAW) utility over normalized metrics (Quality, Latency, Cost, Reliability, Confidence).
   - If the dedicated `meta-router-csp` service is reachable within 500 ms, MiniZinc constraint optimization executes; otherwise, the in-process local optimizer acts as zero-latency fallback.

4. **Execute (`routes/v1.py`)**:
   - Dispatches the canonical `BindingProblem` to the selected solver engine.
   - Injects routing decisions into job provenance (`engineRouting` for users, `engineRoutingAdmin` for administrators).
   - Records observed telemetry upon job completion and updates the Knowledge repository.

5. **Knowledge (`db/models.py: AdaptationObservation`)**:
   - Persists execution observations, workload vectors, predictive snapshots, residual metrics, and health states.

---

## 2. Workload Space Representation

Every incoming `BindingProblem` $P$ is converted into an $O(1)$ computable feature vector:

$$\mathbf{x}(P) = \langle S, D_{\text{constr}}, N_{\text{tasks}}, N_{\text{cap}}, \text{OptMode}, D_{\text{obj}}, T_{\text{budget}} \rangle$$

Where:
- **$S$ (Binding Space Size $\log_{10}$)**:
  $$S = \sum_{t \in \mathcal{T}} \log_{10} |\mathcal{C}(t)|$$
  Quantifies combinatorial decision breadth.
- **$D_{\text{constr}}$ (Constraint Density)**:
  $$D_{\text{constr}} = \frac{N_{\text{predicates}}}{|\mathcal{T}|}$$
  Measures relational tightness and prospective search pruning potential.
- **$N_{\text{tasks}}$**: Number of tasks requiring binding decisions.
- **$N_{\text{cap}}$**: Total capability requirements declared across tasks.
- **$\text{OptMode}$**: Optimization objective category (`single`, `lexicographic`, `pareto`).
- **$D_{\text{obj}}$**: Number of active objective functions.
- **$T_{\text{budget}}$**: Effective execution time budget in milliseconds.

---

## 3. Capacity Abstraction Model

Platform capacity accounting abstracts heterogeneous compute costs through normalized **Capacity Units (`capacityUnits`)**.

### Maximum Sustainable Throughput (MST)

For engine $e$ and workload profile $p$, $MST(e, p)$ denotes the maximum operations per second sustainable before latency spikes or queue saturation:

$$MST(e, p) = \frac{\mu_e(p)}{1 + \lambda_e(p)}$$

### Capacity Unit Weight ($\sigma_S$)

The normalized capacity weight $\sigma_S(e, p)$ represents relative platform resource consumption:

$$\sigma_S(e, p) = \max\left(1, \left\lceil \frac{MST_{\text{baseline}}}{MST(e, p)} \right\rceil\right)$$

Standard capacity values:
- **Stochastic Search (`random-search`)**: 1 CU (trivial memory and CPU footprint).
- **Heuristic Search (`evolutionary-heuristics`)**: 8 CUs (moderate iterative population evaluations).
- **Exact Constraint Programming (`minizinc-csp`)**: 35 CUs (heavy branch-and-bound solving).
- **Internal Optimization (`meta-router-csp`)**: 0 CUs (internal platform overhead, exempt from user quotas).

---

## 4. Failure Risk and Phase Transition Modeling

Constraint satisfaction problems frequently exhibit a sharp phase transition from "almost certainly satisfiable" to "almost certainly unsatisfiable or intractable" governed by constraint density $D_{\text{constr}}$ and problem scale $S$.

The predictive failure risk model $\hat{F}(e, \mathbf{x}(P))$ captures this phenomenon:

$$\hat{F}(e, \mathbf{x}(P)) = \frac{1}{1 + \exp\left(-\kappa \cdot \left(D_{\text{constr}} - D_{\text{crit}}(S)\right)\right)}$$

- For **Exact Solvers (`minizinc-csp`)**: Under critical constraint density ($D_{\text{constr}} \approx D_{\text{crit}}$), the risk of timeout or memory exhaustion increases exponentially.
- For **Metaheuristics (`evolutionary-heuristics`)**: Failure risk exhibits softer degradation, manifesting primarily as partial penalty constraint violations rather than process termination.

Engines exceeding `maxFailureRisk` (or default reliability thresholds) are pruned during the Plan phase.

---

## 5. Telemetry, Drift Detection, and Recalibration

### Residual Computation

Upon job termination, actual execution metrics are measured:
- Latency: $\tau_{\text{obs}}$
- Solution Quality: $Q_{\text{obs}}$
- Actual Credit Usage: $R_{\text{obs}}$

Residuals $e = y_{\text{obs}} - \hat{y}$ feed into rolling statistical accumulators.

### CUSUM Drift Detection

The platform applies two-sided Cumulative Sum (CUSUM) control charts to detect systematic performance shifts:

$$S_k^+ = \max(0, S_{k-1}^+ + (e_k - \mu_0 - k_{\text{slack}}))$$
$$S_k^- = \max(0, S_{k-1}^- - (e_k - \mu_0 + k_{\text{slack}}))$$

When $\max(S_k^+, S_k^-) > h_{\text{threshold}}$, the engine is flagged for recalibration, signaling either infrastructure degradation or workload distribution shifts.

### Administrator Recalibration

Authorized platform operators can trigger parameter recalibration via:
```http
POST /v1/admin/engine-routing/recalibrate
```
This updates predictive baseline coefficients $\boldsymbol{\theta}_e$ and clears accumulated drift alarms.
