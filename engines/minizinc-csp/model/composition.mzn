% OpenBinding CSP Model
% Supports TASK, SEQ, AND, XOR

% --- INPUTS ---

% 0. Parameters
int: root_id;
float: PROB_EPS;

% 1. Global counts
int: n_tasks;
int: n_candidates;
int: n_nodes;

% 2. Candidates
% Improved: per-task candidate lists for stronger propagation
int: max_cands_per_task;
array[1..n_tasks] of int: n_task_cands; 
array[1..n_tasks, 1..max_cands_per_task] of int: task_cands;

% QoS values (Cost, Time, Reliability, Availability, Security)
array[1..n_candidates] of float: c_cost;
array[1..n_candidates] of float: c_time;
array[1..n_candidates] of float: c_rel;
array[1..n_candidates] of float: c_avail;
array[1..n_candidates] of float: c_sec;

% 3. Composition Structure (Flattened Tree)
int: KIND_TASK = 1;
int: KIND_SEQ = 2;
int: KIND_AND = 3;
int: KIND_XOR = 4;

array[1..n_nodes] of int: node_kind;
array[1..n_nodes] of int: node_task_id; % 0 if not TASK
int: max_children; 
array[1..n_nodes, 1..max_children] of int: node_children; 
array[1..n_nodes] of int: node_n_children;
array[1..n_nodes, 1..max_children] of float: node_xor_probs; 

% 4. Objective Weights and Bounds for Scaling
float: w_cost;
float: w_time;
float: w_rel;
float: w_avail;
float: w_sec;

float: COST_UB;
float: TIME_UB;

% --- VARIABLES ---

% Decision: For each task, select an INDEX into its candidate list (not the global candidate ID directly)
array[1..n_tasks] of var 1..max_cands_per_task: pick_idx;
array[1..n_tasks] of var 1..n_candidates: selected_cand;

% Constraint: valid pick index
constraint forall(t in 1..n_tasks)(
    pick_idx[t] <= n_task_cands[t] /\
    selected_cand[t] = task_cands[t, pick_idx[t]]
);

% --- PROVIDERS ---
array[1..n_candidates] of int: candidate_provider;

% --- OPTIONAL CONSTRAINTS ---

% 1. Global Constraints
int: n_global_constraints;
array[1..n_global_constraints] of int: gc_attr; 
array[1..n_global_constraints] of int: gc_op;   
array[1..n_global_constraints] of float: gc_val;

% 2. Local Constraints
int: n_local_constraints;
array[1..n_local_constraints] of int: lc_task;  
array[1..n_local_constraints] of int: lc_attr;  
array[1..n_local_constraints] of int: lc_op;    
array[1..n_local_constraints] of float: lc_val;

% 3. Dependency Constraints
int: n_dep_constraints;
array[1..n_dep_constraints] of int: dc_type;    
array[1..n_dep_constraints] of int: dc_t1;      
array[1..n_dep_constraints] of int: dc_t2;      

% Helper Predicate: Check Operation (Robust)
predicate check_op(var float: val, int: op, float: target) = 
    if op == 1 then val <= target
    elseif op == 2 then val >= target
    elseif op == 3 then (val <= target + 1e-4 /\ val >= target - 1e-4) % Range check
    elseif op == 4 then val < target
    elseif op == 5 then val > target
    else true endif;

% Enforce Global Constraints (on Root Node)
constraint forall(i in 1..n_global_constraints)(
    let { var float: val = 
        if gc_attr[i] == 1 then n_cost[root_id]
        elseif gc_attr[i] == 2 then n_time[root_id]
        elseif gc_attr[i] == 3 then n_rel[root_id]
        elseif gc_attr[i] == 4 then n_avail[root_id]
        elseif gc_attr[i] == 5 then n_sec[root_id]
        else 0.0 endif
    } in check_op(val, gc_op[i], gc_val[i])
);

% Enforce Local Constraints
constraint forall(i in 1..n_local_constraints)(
    let { 
        var int: c = selected_cand[lc_task[i]];
        var float: val = 
            if lc_attr[i] == 1 then c_cost[c]
            elseif lc_attr[i] == 2 then c_time[c]
            elseif lc_attr[i] == 3 then c_rel[c]
            elseif lc_attr[i] == 4 then c_avail[c]
            elseif lc_attr[i] == 5 then c_sec[c]
            else 0.0 endif
    } in check_op(val, lc_op[i], lc_val[i])
);

% Enforce Dependency Constraints
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

% Child indices valid
constraint forall(i in 1..n_nodes, j in 1..node_n_children[i])(
  node_children[i,j] >= 1 /\ node_children[i,j] <= n_nodes
);

% Non-leaf nodes have at least 1 child
constraint forall(i in 1..n_nodes where node_kind[i] != KIND_TASK)(
  node_n_children[i] >= 1
);

% Task nodes map to valid task id
constraint forall(i in 1..n_nodes where node_kind[i] == KIND_TASK)(
  node_task_id[i] >= 1 /\ node_task_id[i] <= n_tasks
);

% Non-task nodes should have task_id = 0
constraint forall(i in 1..n_nodes where node_kind[i] != KIND_TASK)(
  node_task_id[i] == 0
);

% XOR Probability Consistency
constraint forall(i in 1..n_nodes where node_kind[i] == KIND_XOR)(
  forall(j in 1..node_n_children[i])(node_xor_probs[i,j] >= 0.0) /\
  abs(sum(j in 1..node_n_children[i])(node_xor_probs[i,j]) - 1.0) <= PROB_EPS
);


% --- AGGREGATION ---

% Computed QoS for each Node with Tight Bounds
array[1..n_nodes] of var 0.0..COST_UB: n_cost;
array[1..n_nodes] of var 0.0..TIME_UB: n_time;
array[1..n_nodes] of var 0.0..1.0: n_rel;
array[1..n_nodes] of var 0.0..1.0: n_avail;
array[1..n_nodes] of var 0.0..1.0: n_sec;

constraint forall(i in 1..n_nodes)(
    if node_kind[i] == KIND_TASK then
        let { var int: c = selected_cand[node_task_id[i]] } in (
            n_cost[i] == c_cost[c] /\
            n_time[i] == c_time[c] /\
            n_rel[i] == c_rel[c] /\
            n_avail[i] == c_avail[c] /\
            n_sec[i] == c_sec[c]
        )
    elseif node_kind[i] == KIND_SEQ then
        n_cost[i] == sum(j in 1..node_n_children[i])(n_cost[node_children[i,j]]) /\
        n_time[i] == sum(j in 1..node_n_children[i])(n_time[node_children[i,j]]) /\
        n_rel[i] == product(j in 1..node_n_children[i])(n_rel[node_children[i,j]]) /\
        n_avail[i] == product(j in 1..node_n_children[i])(n_avail[node_children[i,j]]) /\
        n_sec[i] == min(j in 1..node_n_children[i])(n_sec[node_children[i,j]])
    elseif node_kind[i] == KIND_AND then
        n_cost[i] == sum(j in 1..node_n_children[i])(n_cost[node_children[i,j]]) /\
        n_time[i] == max(j in 1..node_n_children[i])(n_time[node_children[i,j]]) /\
        n_rel[i] == product(j in 1..node_n_children[i])(n_rel[node_children[i,j]]) /\
        n_avail[i] == product(j in 1..node_n_children[i])(n_avail[node_children[i,j]]) /\
        n_sec[i] == min(j in 1..node_n_children[i])(n_sec[node_children[i,j]])
    elseif node_kind[i] == KIND_XOR then
         n_cost[i] == sum(j in 1..node_n_children[i])(node_xor_probs[i,j] * n_cost[node_children[i,j]]) /\
         n_time[i] == sum(j in 1..node_n_children[i])(node_xor_probs[i,j] * n_time[node_children[i,j]]) /\
         n_rel[i] == sum(j in 1..node_n_children[i])(node_xor_probs[i,j] * n_rel[node_children[i,j]]) /\
         n_avail[i] == sum(j in 1..node_n_children[i])(node_xor_probs[i,j] * n_avail[node_children[i,j]]) /\
         n_sec[i] == sum(j in 1..node_n_children[i])(node_xor_probs[i,j] * n_sec[node_children[i,j]])
    else
        true
    endif
);

% Root node used for objective
var float: obj_val = 
    w_cost * n_cost[root_id] + 
    w_time * n_time[root_id] + 
    w_rel * (1.0 - n_rel[root_id]) + 
    w_avail * (1.0 - n_avail[root_id]) + 
    w_sec * (1.0 - n_sec[root_id]);

solve minimize obj_val;

output [
    "{ \"objective_value\": " ++ show(obj_val) ++ ", ",
    "\"selection\": {",
    join(", ", [
        "\"" ++ show(t) ++ "\": " ++ show(selected_cand[t]) 
        | t in 1..n_tasks
    ]),
    "}}"
];
