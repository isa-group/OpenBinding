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
predicate check_op(var float: val, int: op, float: target) = 
    if op == 1 then val <= target
    elseif op == 2 then val >= target
    elseif op == 3 then (val <= target + 1e-4 /\ val >= target - 1e-4)
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
constraint forall(i in 1..n_global_constraints)(
    let { var float: val = node_qos[root_id, gc_attr[i]] } 
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
        else true endif
);

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


% Calculate explicit upper bound for objective to prevent Gecode overflow
float: obj_ub = sum(q in 1..n_qos)(abs(qos_weights[q]));

% Normalized objective: each feature contribution is divided by its UB
var -obj_ub..obj_ub: obj_val = sum(q in 1..n_qos)(
    qos_weights[q] * (node_qos[root_id, q] / max(1.0, qos_ub[q]))
);

solve minimize obj_val;

output [
    "{ \"objective_value\": " ++ show(obj_val) ++ ", ",
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
