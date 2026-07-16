% OpenBinding CSP Model (Generic QoS & Loop Support)

% --- INPUTS ---

% 0. Parameters
int: root_id;
float: PROB_EPS;

% 1. Global counts
int: n_tasks;
int: n_candidates;
int: n_nodes;
int: n_qos; % Number of QoS features

% 2. Candidates
int: max_cands_per_task;
array[1..n_tasks] of int: n_task_cands; 
array[1..n_tasks, 1..max_cands_per_task] of int: task_cands;

% Generic QoS values [candidate, feature_idx]
array[1..n_candidates, 1..n_qos] of float: cand_qos;

% 3. Composition Structure (Flattened Tree)
int: KIND_TASK = 1;
int: KIND_SEQ = 2;
int: KIND_AND = 3;
int: KIND_XOR = 4;
int: KIND_LOOP = 5;
int: KIND_ELEMENT = 6;

array[1..n_nodes] of int: node_kind;
array[1..n_nodes] of int: node_task_id; % 0 if not TASK
int: max_children; 
array[1..n_nodes, 1..max_children] of int: node_children; 
array[1..n_nodes] of int: node_n_children;
array[1..n_nodes, 1..max_children] of float: node_xor_probs; 
array[1..n_nodes] of int: node_loop_iters; % Expected iterations for LOOP nodes

% 4. Aggregation Policies
% 1=SUM, 2=PROD, 3=MAX, 4=MIN, 5=WEIGHTED_SUM (for XOR)
int: AGG_SUM = 1;
int: AGG_PROD = 2;
int: AGG_MAX = 3;
int: AGG_MIN = 4;
int: AGG_WSUM = 5;

% Policy map: [feature_idx, node_kind] -> function enum
array[1..n_qos, 1..5] of int: agg_policy;

% 5. Objective Weights and Bounds
array[1..n_qos] of float: qos_weights;
array[1..n_qos] of float: neutral_qos;
array[1..n_qos] of float: qos_lb;
array[1..n_qos] of float: qos_ub;

% --- VARIABLES ---

array[1..n_tasks] of var 1..max_cands_per_task: pick_idx;
array[1..n_tasks] of var 1..n_candidates: selected_cand;

constraint forall(t in 1..n_tasks)(
    pick_idx[t] <= n_task_cands[t] /\
    selected_cand[t] = task_cands[t, pick_idx[t]]
);

% --- PROVIDERS ---
array[1..n_candidates] of int: candidate_provider;

% --- OPTIONAL CONSTRAINTS ---

% 1. Global Constraints
int: n_global_constraints;
array[1..n_global_constraints] of int: gc_attr; % Index into 1..n_qos
array[1..n_global_constraints] of int: gc_op;   
array[1..n_global_constraints] of float: gc_val;

% 2. Local Constraints
int: n_local_constraints;
array[1..n_local_constraints] of int: lc_task;  
array[1..n_local_constraints] of int: lc_attr;  % Index into 1..n_qos
array[1..n_local_constraints] of int: lc_op;    
array[1..n_local_constraints] of float: lc_val;

% 3. Dependency Constraints
int: n_dep_constraints;
array[1..n_dep_constraints] of int: dc_type;    
array[1..n_dep_constraints] of int: dc_t1;      
array[1..n_dep_constraints] of int: dc_t2;      

% Helper Predicate: Check Operation
% Float equality tolerance matches the gateway reference evaluator (EPS=1e-6).
predicate check_op(var float: val, int: op, float: target) =
    if op == 1 then val <= target
    elseif op == 2 then val >= target
    elseif op == 3 then (val <= target + 1e-6 /\ val >= target - 1e-6)
    elseif op == 4 then val < target
    elseif op == 5 then val > target
    else true endif;

% --- AGGREGATION COMPUTATION ---

% Computed QoS for each Node [node, feature]
array[1..n_nodes, 1..n_qos] of var float: node_qos;

% Bound Constraint (Optional but helps solver)
constraint forall(i in 1..n_nodes, q in 1..n_qos)(
    node_qos[i,q] >= qos_lb[q] /\ node_qos[i,q] <= qos_ub[q]
);

constraint forall(i in 1..n_nodes)(
    if node_kind[i] == KIND_TASK then
        let { var int: c = selected_cand[node_task_id[i]] } in 
        forall(q in 1..n_qos)(
            node_qos[i,q] == cand_qos[c, q]
        )
    elseif node_kind[i] == KIND_ELEMENT then
        forall(q in 1..n_qos)(
            node_qos[i,q] == neutral_qos[q]
        )
    elseif node_kind[i] == KIND_LOOP then
        % Loop Aggregation
        % Child is node_children[i,1]
        let { 
            int: body_idx = node_children[i,1];
            int: iters = node_loop_iters[i];
        } in
        % Loop Aggregation restored
        forall(q in 1..n_qos)(
            let { 
                int: pol = agg_policy[q, KIND_LOOP];
                var float: body_val = node_qos[body_idx, q];
            } in
            if pol == AGG_SUM then node_qos[i,q] == body_val * iters
            elseif pol == AGG_PROD then 
               % Product over iterations: val * val ... * val (iters times) -> pow
               node_qos[i,q] == product(k in 1..iters)(body_val) % SCALED_PRODUCT
            elseif pol == AGG_MAX then node_qos[i,q] == body_val
            elseif pol == AGG_MIN then node_qos[i,q] == body_val
            else node_qos[i,q] == body_val * iters
            endif
        )
    else 
        % SEQ, AND, XOR - list children
        forall(q in 1..n_qos)(
            let {
                int: pol = agg_policy[q, node_kind[i]];
                % Collect children values
                % Use array comprehension
                array[int] of var float: child_vals = [node_qos[node_children[i,j], q] | j in 1..node_n_children[i]];
            } in
            if node_kind[i] == KIND_XOR then
                 % XOR special handling for Weighted Sum (Probabilities)
                 % Usually XOR aggregates using Weighted Sum of probabilities regardless of 'pol' if it's 'average' logic.
                 % But strictly, if pol=MAX, it implies MAX of branches.
                 % If pol=SUM, implies SUM of branches? (Seems wrong for XOR which runs only one).
                 % Usually XOR uses Weighted Sum (Expectation).
                 % If pol == AGG_WSUM (5) -> Weighted Sum
                 if pol == AGG_WSUM then
                    node_qos[i,q] == sum(j in 1..node_n_children[i])(node_xor_probs[i,j] * child_vals[j])
                 elseif pol == AGG_MAX then
                    node_qos[i,q] == max(child_vals)
                 elseif pol == AGG_MIN then
                    node_qos[i,q] == min(child_vals)
                 else
                    % Default to weighted sum for XOR
                    node_qos[i,q] == sum(j in 1..node_n_children[i])(node_xor_probs[i,j] * child_vals[j])
                 endif
            else
                % SEQ or AND
                if pol == AGG_SUM then node_qos[i,q] == sum(child_vals)
                elseif pol == AGG_PROD then node_qos[i,q] == product(child_vals)
                elseif pol == AGG_MAX then node_qos[i,q] == max(child_vals)
                elseif pol == AGG_MIN then node_qos[i,q] == min(child_vals)
                else node_qos[i,q] == sum(child_vals)
                endif
            endif
        )
    endif
);

% --- CONSTRAINTS ENFORCEMENT ---

% Global
% Note: the end-to-end latency feature reads from the scheduling model
% (feature_value). Its PERT encoding only lower-bounds the makespan, so the
% dzn builder rejects >=, > and == global bounds on that feature.
constraint forall(i in 1..n_global_constraints)(
    let { var float: val = feature_value(gc_attr[i]) }
    in check_op(val, gc_op[i], gc_val[i])
);

% Local
constraint forall(i in 1..n_local_constraints)(
    let { 
        var int: c = selected_cand[lc_task[i]];
        var float: val = cand_qos[c, lc_attr[i]];
    } in check_op(val, lc_op[i], lc_val[i])
);

% Dependency
constraint forall(i in 1..n_dep_constraints)(
    let {
        var int: c1 = selected_cand[dc_t1[i]];
        var int: c2 = selected_cand[dc_t2[i]];
        var int: p1 = candidate_provider[c1];
        var int: p2 = candidate_provider[c2];
    } in
        if dc_type[i] == 1 then p1 == p2         % Same Provider
        elseif dc_type[i] == 2 then p1 != p2     % Diff Provider
        elseif dc_type[i] == 3 then task_pool[dc_t1[i]] == task_pool[dc_t2[i]]  % Same Pool
        elseif dc_type[i] == 4 then task_pool[dc_t1[i]] != task_pool[dc_t2[i]]  % Diff Pool
        else true endif
);

% --- BIM* PLACEMENT EXTENSIONS ---
% All placement quantities are integers: latencies are scaled by LAT_SCALE
% (milliseconds * LAT_SCALE), resource demands/capacities are integral.

int: n_pools;
int: n_resources;
int: n_events;
int: LAT_SCALE;
int: MAX_LAT_INT;
int: xor_semantics;    % 1 = EXPECTED, 2 = WORST_CASE
int: lat_feature_idx;  % index into 1..n_qos of the end-to-end latency feature, 0 if none

array[1..n_candidates] of int: cand_pool;  % 0 = no pool binding
array[1..n_candidates, 1..n_resources] of int: cand_demand;
array[1..n_candidates] of int: cand_exec_lat;  % execution latency, scaled
array[1..n_pools, 1..n_pools] of int: pool_lat;
array[1..n_events, 1..n_pools] of int: event_lat;

% Pool hosting each task (follows directly from the selected candidate).
array[1..n_tasks] of var 0..n_pools: task_pool;
constraint forall(t in 1..n_tasks)( task_pool[t] == cand_pool[selected_cand[t]] );

predicate check_op_int(var int: val, int: op, int: target) =
    if op == 1 then val <= target
    elseif op == 2 then val >= target
    elseif op == 3 then val == target
    elseif op == 4 then val < target
    elseif op == 5 then val > target
    else true endif;

% 1. RESOURCE_CAPACITY dependency constraint: cumulative demand of the tasks
%    placed on a pool must fit its capacity. One check per (pool, resource)
%    pair in scope.
int: n_cap_checks;
array[1..n_cap_checks] of int: cap_pool;
array[1..n_cap_checks] of int: cap_res;
array[1..n_cap_checks] of int: cap_limit;

constraint forall(k in 1..n_cap_checks)(
    sum(t in 1..n_tasks)(
        bool2int(task_pool[t] == cap_pool[k]) * cand_demand[selected_cand[t], cap_res[k]]
    ) <= cap_limit[k]
);

% 2. Transition latency constraints: pairwise bounds over the latency matrix.
int: n_transitions;
array[1..n_transitions] of int: tr_from_task;  % 0 = event source
array[1..n_transitions] of int: tr_event;      % 0 = task source
array[1..n_transitions] of int: tr_to_task;
array[1..n_transitions] of int: tr_op;
array[1..n_transitions] of int: tr_val;        % scaled

constraint forall(i in 1..n_transitions)(
    let {
        var int: lat = if tr_from_task[i] > 0
            then pool_lat[task_pool[tr_from_task[i]], task_pool[tr_to_task[i]]]
            else event_lat[tr_event[i], task_pool[tr_to_task[i]]]
        endif
    } in check_op_int(lat, tr_op[i], tr_val[i])
);

% 3. End-to-end latency: expected makespan over XOR scenarios.
%    Each scenario is a precedence DAG; task_finish is lower-bounded by every
%    predecessor edge (critical-path / PERT encoding). This is sound because
%    the latency feature is only ever minimized or bounded from above, so the
%    solver drives task_finish down to the true makespan.
int: n_scenarios;
int: n_scen_rows = max(1, n_scenarios);
array[1..n_scenarios] of float: scen_prob;
array[1..n_scenarios, 1..n_tasks] of int: scen_active;
int: n_prec_edges;
array[1..n_prec_edges] of int: pe_scen;
array[1..n_prec_edges] of int: pe_to_task;
array[1..n_prec_edges] of int: pe_from_task;  % 0 = event
array[1..n_prec_edges] of int: pe_event;      % 0 = task
int: n_sinks;
array[1..n_sinks] of int: sink_scen;
array[1..n_sinks] of int: sink_task;

array[1..n_scen_rows, 1..n_tasks] of var 0..MAX_LAT_INT: task_finish;
array[1..n_scen_rows] of var 0..MAX_LAT_INT: scen_mk;

constraint forall(s in 1..n_scenarios, t in 1..n_tasks)(
    if scen_active[s,t] == 1
    then task_finish[s,t] >= cand_exec_lat[selected_cand[t]]
    else task_finish[s,t] == 0 endif
);
constraint forall(s in (n_scenarios+1)..n_scen_rows)(
    scen_mk[s] == 0 /\ forall(t in 1..n_tasks)(task_finish[s,t] == 0)
);

constraint forall(e in 1..n_prec_edges)(
    task_finish[pe_scen[e], pe_to_task[e]] >=
        (if pe_from_task[e] > 0
         then task_finish[pe_scen[e], pe_from_task[e]]
              + pool_lat[task_pool[pe_from_task[e]], task_pool[pe_to_task[e]]]
         else event_lat[pe_event[e], task_pool[pe_to_task[e]]]
         endif)
        + cand_exec_lat[selected_cand[pe_to_task[e]]]
);

constraint forall(k in 1..n_sinks)(
    scen_mk[sink_scen[k]] >= task_finish[sink_scen[k], sink_task[k]]
);

var float: e2e_ms =
    if n_scenarios == 0 then 0.0
    elseif xor_semantics == 2 then
        int2float(max(s in 1..n_scenarios)(scen_mk[s])) / int2float(LAT_SCALE)
    else
        sum(s in 1..n_scenarios)(scen_prob[s] * int2float(scen_mk[s])) / int2float(LAT_SCALE)
    endif;

% Value of a feature at the composition root; the end-to-end latency feature
% is derived from the scheduling model instead of the aggregation tree.
function var float: feature_value(int: q) =
    if q == lat_feature_idx /\ n_scenarios > 0 then e2e_ms else node_qos[root_id, q] endif;

% --- STRUCTURAL SAFEGUARDS ---
% (Same as before, + Loop check)

constraint forall(i in 1..n_nodes, j in 1..node_n_children[i])(
  node_children[i,j] >= 1 /\ node_children[i,j] <= n_nodes
);

constraint forall(i in 1..n_nodes where node_kind[i] in {KIND_AND, KIND_XOR, KIND_LOOP})(
  node_n_children[i] >= 1
);

constraint forall(i in 1..n_nodes where node_kind[i] == KIND_TASK)(
  node_task_id[i] >= 1 /\ node_task_id[i] <= n_tasks
);

constraint forall(i in 1..n_nodes where node_kind[i] != KIND_TASK)(
  node_task_id[i] == 0
);

constraint forall(i in 1..n_nodes where node_kind[i] == KIND_XOR)(
  forall(j in 1..node_n_children[i])(node_xor_probs[i,j] >= 0.0) /\
  abs(sum(j in 1..node_n_children[i])(node_xor_probs[i,j]) - 1.0) <= PROB_EPS
);

% Loop specific: 1 child
constraint forall(i in 1..n_nodes where node_kind[i] == KIND_LOOP)(
    node_n_children[i] == 1
);

% --- OBJECTIVE ---

% Canonical (BIM*) objective: weighted sum of per-feature losses normalized
% with instance-declared bounds and clamped to [0, 1]. Identical to the
% gateway reference evaluator (and the Java engines):
%   loss_q = clamp((v - lb) / (ub - lb))   for MINIMIZE features
%   loss_q = clamp((ub - v) / (ub - lb))   for MAXIMIZE features
bool: use_canonical;
array[1..n_qos] of int: qos_dir;      % 1 = MINIMIZE, -1 = MAXIMIZE
array[1..n_qos] of float: norm_lb;
array[1..n_qos] of float: norm_ub;
array[1..n_qos] of float: canon_w;    % >= 0; zero for non-target features

% The raw loss variable needs explicit finite bounds: Gecode's float min/max
% propagators reject unbounded intermediate domains ("Number out of limits").
function var float: canonical_loss(int: q) =
    let {
        float: span = max(1e-9, norm_ub[q] - norm_lb[q]);
        float: fv_lb = if q == lat_feature_idx /\ n_scenarios > 0 then 0.0 else qos_lb[q] endif;
        float: fv_ub = if q == lat_feature_idx /\ n_scenarios > 0
                       then int2float(MAX_LAT_INT) / int2float(LAT_SCALE)
                       else qos_ub[q] endif;
        float: raw_lb = if qos_dir[q] == 1 then (fv_lb - norm_lb[q]) / span
                        else (norm_ub[q] - fv_ub) / span endif;
        float: raw_ub = if qos_dir[q] == 1 then (fv_ub - norm_lb[q]) / span
                        else (norm_ub[q] - fv_lb) / span endif;
        var raw_lb..raw_ub: raw;
        constraint raw = if qos_dir[q] == 1 then (feature_value(q) - norm_lb[q]) / span
                         else (norm_ub[q] - feature_value(q)) / span endif;
    } in min(1.0, max(0.0, raw));

% Calculate explicit upper bound for objective to prevent Gecode overflow
float: obj_ub = sum(q in 1..n_qos)(abs(qos_weights[q]))
              + sum(q in 1..n_qos)(abs(canon_w[q])) + 1.0;

% Weighted MEAN of losses (divide by the total weight), matching the gateway
% reference evaluator and the Java engines exactly.
float: canon_w_total = max(1e-9, sum(q in 1..n_qos)(canon_w[q]));

var -obj_ub..obj_ub: obj_val =
    if use_canonical then
        sum(q in 1..n_qos)(canon_w[q] * canonical_loss(q)) / canon_w_total
    else
        % Legacy objective: each feature contribution divided by its UB
        sum(q in 1..n_qos)(qos_weights[q] * (node_qos[root_id, q] / max(1.0, qos_ub[q])))
    endif;

% Branch on the per-task candidate picks; first_fail + indomain_min proved
% far stronger than default search on BIM* placement instances.
solve :: int_search(pick_idx, first_fail, indomain_min) minimize obj_val;

output [
    "{ \"objective_value\": " ++ show(obj_val) ++ ", ",
    "\"e2e_latency_ms\": " ++ show(e2e_ms) ++ ", ",
    "\"aggregated_features\": {",
    join(", ", [
        "\"" ++ show(q) ++ "\": " ++ show(node_qos[root_id, q]) 
        | q in 1..n_qos
    ]),
    "}, ",
    "\"selection\": {",
    join(", ", [
        "\"" ++ show(t) ++ "\": " ++ show(selected_cand[t]) 
        | t in 1..n_tasks
    ]),
    "}}"
];
