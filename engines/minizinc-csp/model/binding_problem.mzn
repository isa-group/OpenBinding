% Exact deterministic BIM v1 subset consumed by minizinc-csp/exact-weighted.
%
% Multiplicative aggregations (sequence/parallel product, XOR weighted product,
% repeat power, selected-candidate product) are lowered by the TypeScript side
% into "flat products": every maximal pure-product subtree becomes a product of
% per-task factors v^e whose exponents e are constants (routing probabilities
% and repeat counts along the path). Each flat product carries two consistent
% representations:
%   * the exact real value  P = const * prod_t v[sel_t]^e_t   (used by the
%     objective and by comparisons that mix product and additive features), and
%   * the log-space value   L = ln const + sum_t e_t * ln v[sel_t]   (a linear
%     expression used for comparisons against literals, i.e. the classical
%     logarithmic linearisation of QoS composition models).
% Gecode has no float exp/ln propagators, so the real value is never derived
% from L inside the solver: both are functions of the same selection variables.

include "bin_packing_capa.mzn";

int: n_tasks;
int: n_candidates;
int: n_metrics;
int: max_candidates_per_task;
array[1..n_tasks] of int: n_task_candidates;
array[1..n_tasks, 1..max_candidates_per_task] of int: task_candidates;
array[1..n_candidates, 1..n_metrics] of float: candidate_metric;
array[1..n_metrics] of float: metric_neutral;
array[1..n_metrics] of int: metric_scope; % 1 invocation, 2 selectedCandidate
array[1..n_metrics] of int: selection_aggregation; % 1 sum, 2 product, 3 min, 4 max
float: node_metric_bound;
float: objective_bound;

% Log-space data. ln(0) is replaced by metric_zero_log (a large negative
% constant chosen by the lowering so that any selection containing a zero
% factor is separated from every all-positive selection by a wide gap).
array[1..n_metrics] of bool: metric_log_available;
array[1..n_metrics] of float: metric_zero_log;
float: log_metric_bound;
bool: selection_disjoint; % every candidate is eligible for at most one task

int: root_node;
int: n_nodes;
int: max_children;
array[1..n_nodes] of int: node_kind; % 1 empty/local, 2 task, 3 seq, 4 parallel, 5 xor, 6 repeat
array[1..n_nodes] of int: node_task;
array[1..n_nodes] of int: node_child_count;
array[1..n_nodes, 1..max_children] of int: node_children;
array[1..n_nodes, 1..max_children] of float: node_weights;
array[1..n_nodes] of float: node_repeat_count;
array[1..n_metrics, 1..4] of int: aggregation; % sequence, parallel, exclusive, repeat
% codes: 1 sum, 2 product, 3 min, 4 max, 5 weightedSum, 6 scale, 7 weightedProduct, 8 identity, 9 power

% Flat products: node_flat[node, metric] > 0 selects a flat descriptor, -1 marks
% nodes strictly inside a flattened subtree (their value is unused for that metric).
int: n_flat;
array[1..n_flat] of int: flat_metric;
array[1..n_flat] of float: flat_constant;
array[1..n_flat] of float: flat_log_constant;
array[1..n_flat, 1..n_tasks] of float: flat_exponent;
array[1..n_nodes, 1..n_metrics] of int: node_flat;

int: n_constraints;
array[1..n_constraints] of int: constraint_enforcement; % 1 hard, 2 soft
array[1..n_constraints] of float: constraint_penalty; % weighted constant penalty (0 for hard)
int: n_atoms;
array[1..n_atoms] of int: atom_constraint;
array[1..n_atoms] of int: atom_operator; % 1 <=, 2 >=, 3 ==, 4 <, 5 >, 6 !=
array[1..n_atoms] of int: atom_left_kind; % 1 global metric, 2 selected task value, 3 literal, 4 global metric in log space, 5 selected task value in log space
array[1..n_atoms] of int: atom_left_index;
array[1..n_atoms] of float: atom_left_value;
array[1..n_atoms, 1..n_candidates] of float: atom_left_candidate_value;
array[1..n_atoms] of int: atom_right_kind;
array[1..n_atoms] of int: atom_right_index;
array[1..n_atoms] of float: atom_right_value;
array[1..n_atoms, 1..n_candidates] of float: atom_right_candidate_value;

int: n_terms;
array[1..n_terms] of int: term_metric;
array[1..n_terms] of float: term_weight;
array[1..n_terms] of int: term_direction;
array[1..n_terms] of bool: term_has_normalize;
array[1..n_terms] of float: term_min;
array[1..n_terms] of float: term_max;
array[1..n_terms] of bool: term_clamp;
array[1..n_terms] of float: term_bound; % |raw metric value| <= term_bound

% Optional Placement. A single dummy pool makes the empty case naturally vacuous.
int: n_pool_slots;
array[1..n_candidates] of int: candidate_model;
array[1..n_candidates] of int: candidate_pool;
array[1..n_pool_slots] of int: pool_model;
array[1..n_pool_slots, 1..n_pool_slots] of float: pool_latency;
int: n_events;
array[1..n_events] of int: event_model;
array[1..n_events] of int: event_pool;
array[1..n_events, 1..n_pool_slots] of float: event_latency;
array[1..n_tasks] of float: task_invocation;

int: n_capacity_checks;
int: n_capacity_resources; % distinct (placement model, resource) demand columns
array[1..n_capacity_checks] of int: capacity_pool;
array[1..n_capacity_checks] of int: capacity_scope; % 1 invocation, 2 distinct selected candidate
array[1..n_capacity_checks] of int: capacity_column;
array[1..n_capacity_checks] of float: capacity_limit;
array[1..n_candidates, 1..n_capacity_resources] of float: candidate_resource_demand;
% Capacity checks whose demands are constant per task (and integral after a common
% power-of-ten scaling) are posted as native bin-packing columns instead of
% reified sums; capacity_in_bin marks the checks a column already enforces.
int: n_bin_columns;
array[1..n_bin_columns, 1..n_tasks] of int: bin_weight;
array[1..n_bin_columns, 1..n_pool_slots] of int: bin_capacity;
array[1..n_capacity_checks] of bool: capacity_in_bin;
% Reified checks that hold for every selection (the largest load any eligible
% candidate can put on the pool is within the limit) are not posted: they would
% only add propagators to every node of the search.
array[1..n_capacity_checks] of bool: capacity_vacuous;

int: n_transitions;
array[1..n_transitions] of int: transition_model;
array[1..n_transitions] of int: transition_from_kind; % 1 event, 2 task
array[1..n_transitions] of int: transition_from;
array[1..n_transitions] of int: transition_to_kind;
array[1..n_transitions] of int: transition_to;
array[1..n_transitions] of float: transition_maximum;
array[1..n_transitions] of bool: transition_hard;
array[1..n_transitions] of float: transition_penalty;
float: placement_penalty_bound;

array[1..n_metrics] of int: global_metric_model; % 0 = ordinary metric
float: placement_time_bound;
int: n_scenarios;
array[1..n_scenarios] of int: scenario_model;
array[1..n_scenarios] of float: scenario_probability;
array[1..n_scenarios] of int: scenario_ready;
int: n_activities;
int: max_activity_predecessors;
array[1..n_activities] of int: activity_model;
array[1..n_activities] of int: activity_task;
array[1..n_activities] of int: activity_exec_metric; % 0 excludes execution
array[1..n_activities] of int: activity_predecessor_count;
array[1..n_activities, 1..max_activity_predecessors] of int: activity_predecessor_kind;
array[1..n_activities, 1..max_activity_predecessors] of int: activity_predecessor_source;
array[1..n_activities, 1..max_activity_predecessors] of int: activity_predecessor_ready;
int: n_ready_values;
int: max_ready_children;
array[1..n_ready_values] of int: ready_kind; % 1 activity finish, 2 max, 3 parallel sum, 4 zero
array[1..n_ready_values] of int: ready_source;
array[1..n_ready_values] of int: ready_base;
array[1..n_ready_values] of int: ready_child_count;
array[1..n_ready_values, 1..max_ready_children] of int: ready_children;

array[1..n_tasks] of var 1..max_candidates_per_task: selected_slot;
array[1..n_tasks] of var 1..n_candidates: selected_candidate;
constraint forall(task in 1..n_tasks)(
  selected_slot[task] <= n_task_candidates[task] /\
  selected_candidate[task] = task_candidates[task, selected_slot[task]]
);

% ---- Fixed-point reading of float tables -------------------------------------
% Gecode has no float element propagator: MiniZinc decomposes `value = table[slot]`
% into one reified equality per slot, which (a) never tightens the bounds of
% `value` from the slots that remain and (b) costs hundreds of thousands of
% constraints on catalogs with tens of thousands of candidates, so flattening
% alone exceeded the time budget. Every float table is therefore read through
% native integer element constraints over fixed-point limbs:
%   hi = round(v * s), with s the largest power of ten keeping |hi| < 2^31, and
%   lo = round((v - hi / s) * s * 1e9) when the values are not exact decimals at
%   scale s (lo is omitted when it vanishes for the whole table).
% The value is recovered through an exact linear equality
%   value * s == hi                   or   value * (s * 1e9) == hi * 1e9 + lo.
% For decimal data (the usual case) the recovered rational is the decimal itself
% and the outward-rounded interval Gecode keeps for `value` contains the double
% v; otherwise the reconstruction is within one ulp of v. The engine and the
% gateway re-evaluate every returned binding with the original doubles.
function float: table_scale(array[int] of float: table) =
  let { float: largest = max([0.0] ++ [abs(v) | v in table]) } in
  if largest == 0.0 then 1.0 else pow(10.0, floor(log10(2147483647.0 / largest))) endif;

function var float: table_value(array[int] of float: table, var int: idx) =
  let {
    float: scale = table_scale(table),
    array[int] of int: hi = [round(v * scale) | v in table],
    array[int] of int: lo = [round((v - int2float(round(v * scale)) / scale) * scale * 1.0e9) | v in table],
    % is_defined_var keeps Gecode's FlatZinc front-end from adding its default
    % float branching on the value (it is functionally determined by idx).
    var min(table)..max(table): value :: is_defined_var,
    var int: high = hi[idx],
    constraint if forall(x in lo)(x == 0) then value * scale == int2float(high)
      else value * (scale * 1.0e9) == int2float(high) * 1.0e9 + int2float(lo[idx]) endif
  } in value;

% Per-task views of the candidate tables, read through the task's own slot so
% that every element constraint is as long as that task's eligibility list
% rather than the whole catalog.
function array[int] of float: task_table(int: task, int: metric) =
  [candidate_metric[task_candidates[task, slot], metric] | slot in 1..n_task_candidates[task]];

array[1..n_metrics] of float: metric_bound; % |global metric value| <= metric_bound
array[1..n_tasks, 1..n_metrics] of var float: task_value;
constraint forall(task in 1..n_tasks, metric in 1..n_metrics)(
  task_value[task, metric] = table_value(task_table(task, metric), selected_slot[task])
);
function var float: task_metric(int: task, int: metric) = task_value[task, metric];
function var float: task_powered_metric(int: task, int: metric, float: exponent) =
  table_value([pow(v, exponent) | v in task_table(task, metric)], selected_slot[task]);

% Logarithms of the candidate values are parameters: the solver only ever sums them.
array[1..n_candidates, 1..n_metrics] of float: candidate_log = array2d(1..n_candidates, 1..n_metrics, [
  if not metric_log_available[metric] then 0.0
  elseif candidate_metric[candidate, metric] > 0.0 then ln(candidate_metric[candidate, metric])
  else metric_zero_log[metric] endif
  | candidate in 1..n_candidates, metric in 1..n_metrics
]);

% Exact real value of a flat product: const * prod_t v[sel_t]^e_t. Unit exponents
% read candidate_metric directly; other exponents use a parameter table of powers.
function var float: flat_factor(int: flat, int: task) =
  let {
    int: metric = flat_metric[flat],
    float: exponent = flat_exponent[flat, task]
  } in
    if exponent == 1.0 then task_metric(task, metric)
    else task_powered_metric(task, metric, exponent) endif;

function var float: flat_value(int: flat) =
  flat_constant[flat] * product(task in 1..n_tasks where flat_exponent[flat, task] != 0.0)(flat_factor(flat, task));

function var float: task_log(int: task, int: metric) =
  table_value([candidate_log[task_candidates[task, slot], metric] | slot in 1..n_task_candidates[task]], selected_slot[task]);

function var float: flat_log_value(int: flat) =
  flat_log_constant[flat] + sum(task in 1..n_tasks where flat_exponent[flat, task] != 0.0)(
    flat_exponent[flat, task] * task_log(task, flat_metric[flat])
  );

% Gecode requires finite domains for float variables. The TypeScript lowering
% computes a conservative bound from candidates and the workflow.
array[1..n_nodes, 1..n_metrics] of var -node_metric_bound..node_metric_bound: node_metric;

constraint forall(node in 1..n_nodes, metric in 1..n_metrics)(
  if node_flat[node, metric] > 0 then
    node_metric[node, metric] = flat_value(node_flat[node, metric])
  elseif node_flat[node, metric] < 0 then
    node_metric[node, metric] = 0.0
  elseif node_kind[node] == 1 then
    node_metric[node, metric] = metric_neutral[metric]
  elseif node_kind[node] == 2 then
    node_metric[node, metric] = task_metric(node_task[node], metric)
  elseif node_kind[node] == 6 then
    let {
      var float: child = node_metric[node_children[node, 1], metric],
      int: op = aggregation[metric, 4]
    } in
      if op == 6 then node_metric[node, metric] = child * node_repeat_count[node]
      elseif op == 8 then node_metric[node, metric] = child
      elseif op == 9 then
        % Non-flattened power nodes only reach the solver with integer counts.
        if node_repeat_count[node] == 0.0 then node_metric[node, metric] = 1.0
        else node_metric[node, metric] = product([child | i in 1..round(node_repeat_count[node])]) endif
      else false endif
  else
    let {
      array[int] of var float: children =
        [node_metric[node_children[node, child], metric] | child in 1..node_child_count[node]],
      int: column = if node_kind[node] == 3 then 1 elseif node_kind[node] == 4 then 2 else 3 endif,
      int: op = aggregation[metric, column]
    } in
      if op == 1 then node_metric[node, metric] = sum(children)
      elseif op == 2 then node_metric[node, metric] = product(children)
      elseif op == 3 then node_metric[node, metric] = min(children)
      elseif op == 4 then node_metric[node, metric] = max(children)
      elseif op == 5 then
        node_metric[node, metric] = sum(child in 1..node_child_count[node])(
          node_weights[node, child] * children[child]
        )
      else false endif
  endif
);

predicate compare_value(var float: left, int: op, var float: right) =
  if op == 1 then left <= right
  elseif op == 2 then left >= right
  elseif op == 3 then left == right
  elseif op == 4 then left < right
  elseif op == 5 then left > right
  elseif op == 6 then left != right
  else false endif;

array[1..n_tasks] of var 1..n_pool_slots: task_pool =
  [[candidate_pool[task_candidates[task, slot]] | slot in 1..n_task_candidates[task]][selected_slot[task]] | task in 1..n_tasks];
array[1..n_tasks] of var 0..max(1, max(candidate_model)): task_model =
  [[candidate_model[task_candidates[task, slot]] | slot in 1..n_task_candidates[task]][selected_slot[task]] | task in 1..n_tasks];
% Demand columns that no bin-packing column covers are read per task through the
% slot; covered columns never materialise a variable.
array[1..n_capacity_resources] of bool: column_needs_demand =
  [exists(check in 1..n_capacity_checks)(
     capacity_column[check] == column /\ not capacity_in_bin[check] /\ not capacity_vacuous[check])
   | column in 1..n_capacity_resources];
array[1..n_tasks, 1..n_capacity_resources] of var float: task_resource_demand =
  array2d(1..n_tasks, 1..n_capacity_resources, [
    if column_needs_demand[column] then
      table_value([candidate_resource_demand[task_candidates[task, slot], column] | slot in 1..n_task_candidates[task]],
                  selected_slot[task])
    else 0.0 endif
    | task in 1..n_tasks, column in 1..n_capacity_resources]);
% "Distinct selected candidates" only differ from "one candidate per task" when a
% candidate is eligible for several tasks. With disjoint eligibility the per-candidate
% indicator array (n_candidates x n_tasks reified equalities) is never materialised.
bool: use_candidate_selected = not selection_disjoint /\
  (exists(check in 1..n_capacity_checks)(capacity_scope[check] == 2) \/
   exists(metric in 1..n_metrics)(metric_scope[metric] == 2));
array[1..n_candidates] of var bool: candidate_selected =
  if use_candidate_selected then
    [exists(task in 1..n_tasks)(selected_candidate[task] == candidate) | candidate in 1..n_candidates]
  else [false | candidate in 1..n_candidates] endif;

constraint forall(column in 1..n_bin_columns)(
  bin_packing_capa([bin_capacity[column, pool] | pool in 1..n_pool_slots], task_pool,
                   [bin_weight[column, task] | task in 1..n_tasks])
);
constraint forall(check in 1..n_capacity_checks)(
  if capacity_in_bin[check] \/ capacity_vacuous[check] then true
  elseif capacity_scope[check] == 1 then
    sum(task in 1..n_tasks)(
      bool2int(task_pool[task] == capacity_pool[check]) * task_invocation[task]
        * task_resource_demand[task, capacity_column[check]]
    ) <= capacity_limit[check]
  elseif selection_disjoint then
    sum(task in 1..n_tasks)(
      bool2int(task_pool[task] == capacity_pool[check]) * task_resource_demand[task, capacity_column[check]]
    ) <= capacity_limit[check]
  else
    sum(candidate in 1..n_candidates where candidate_pool[candidate] == capacity_pool[check])(
      bool2int(candidate_selected[candidate]) * candidate_resource_demand[candidate, capacity_column[check]]
    ) <= capacity_limit[check]
  endif
);

array[1..n_transitions] of var 1..n_pool_slots: transition_from_pool =
  [if transition_from_kind[index] == 1 then event_pool[transition_from[index]]
   else task_pool[transition_from[index]] endif | index in 1..n_transitions];
array[1..n_transitions] of var 1..n_pool_slots: transition_to_pool =
  [if transition_to_kind[index] == 1 then event_pool[transition_to[index]]
   else task_pool[transition_to[index]] endif | index in 1..n_transitions];
% Network latencies are float tables read through a pool variable (or two). Gecode has
% no float element propagator, so `pool_latency[a, b]` with variable pools would be
% decomposed into one reified equality per cell (n_pool_slots^2 of them for every
% single access) and `event_latency[e, p]` into one per pool. They go through the
% fixed-point native integer element of table_value instead; the 2-D table is
% flattened row-major, so the cell of (a, b) is (a - 1) * n_pool_slots + b.
function var float: pool_pair_latency(var int: from_pool, var int: to_pool) =
  table_value([pool_latency[a, b] | a in 1..n_pool_slots, b in 1..n_pool_slots],
              (from_pool - 1) * n_pool_slots + to_pool);
function var float: event_pool_latency(int: event, var int: to_pool) =
  table_value([event_latency[event, p] | p in 1..n_pool_slots], to_pool);

array[1..n_transitions] of var float: transition_latency =
  [if transition_from_kind[index] == 1 then
     event_pool_latency(transition_from[index], transition_to_pool[index])
   else pool_pair_latency(transition_from_pool[index], transition_to_pool[index]) endif
   | index in 1..n_transitions];
constraint forall(index in 1..n_transitions)(
  (if transition_from_kind[index] == 2 then
     task_model[transition_from[index]] == transition_model[index] else true endif) /\
  (if transition_to_kind[index] == 2 then
     task_model[transition_to[index]] == transition_model[index] else true endif) /\
  (if transition_hard[index] then transition_latency[index] <= transition_maximum[index] else true endif)
);
var 0.0..placement_penalty_bound: placement_penalty =
  sum(index in 1..n_transitions where not transition_hard[index])(
    bool2int(transition_latency[index] > transition_maximum[index]) * transition_penalty[index]
  );

array[1..n_activities] of var 1..n_pool_slots: activity_pool =
  [task_pool[activity_task[activity]] | activity in 1..n_activities];
array[1..n_activities] of var 0.0..placement_time_bound: activity_start;
array[1..n_activities] of var 0.0..placement_time_bound: activity_finish;
array[1..n_ready_values] of var 0.0..placement_time_bound: ready_value;
constraint forall(activity in 1..n_activities)(
  task_model[activity_task[activity]] == activity_model[activity] /\
  activity_start[activity] =
    if activity_predecessor_count[activity] == 0 then 0.0 else
      max(predecessor in 1..activity_predecessor_count[activity])(
        (if activity_predecessor_ready[activity, predecessor] == 0 then 0.0
         else ready_value[activity_predecessor_ready[activity, predecessor]] endif)
        + (if activity_predecessor_kind[activity, predecessor] == 1 then
             event_pool_latency(activity_predecessor_source[activity, predecessor], activity_pool[activity])
           else pool_pair_latency(activity_pool[activity_predecessor_source[activity, predecessor]], activity_pool[activity]) endif)
      )
    endif /\
  activity_finish[activity] = activity_start[activity]
    + (if activity_exec_metric[activity] == 0 then 0.0
       else task_metric(activity_task[activity], activity_exec_metric[activity]) endif)
);
constraint forall(ready in 1..n_ready_values)(
  if ready_kind[ready] == 1 then ready_value[ready] = activity_finish[ready_source[ready]]
  elseif ready_kind[ready] == 2 then
    ready_value[ready] = max(child in 1..ready_child_count[ready])(ready_value[ready_children[ready, child]])
  elseif ready_kind[ready] == 3 then
    ready_value[ready] = sum(child in 1..ready_child_count[ready])(ready_value[ready_children[ready, child]])
      - (ready_child_count[ready] - 1) * ready_value[ready_base[ready]]
  else ready_value[ready] = 0.0 endif
);

function var float: selection_metric(int: metric) =
  if n_tasks == 0 then metric_neutral[metric]
  elseif selection_disjoint then
    if selection_aggregation[metric] == 1 then
      sum(task in 1..n_tasks)(task_metric(task, metric))
    elseif selection_aggregation[metric] == 2 then
      product(task in 1..n_tasks)(task_metric(task, metric))
    elseif selection_aggregation[metric] == 3 then
      min(task in 1..n_tasks)(task_metric(task, metric))
    else
      max(task in 1..n_tasks)(task_metric(task, metric))
    endif
  elseif selection_aggregation[metric] == 1 then
    sum(candidate in 1..n_candidates)(bool2int(candidate_selected[candidate]) * candidate_metric[candidate, metric])
  elseif selection_aggregation[metric] == 2 then
    product(candidate in 1..n_candidates)(
      1.0 + bool2float(candidate_selected[candidate]) * (candidate_metric[candidate, metric] - 1.0))
  elseif selection_aggregation[metric] == 3 then
    min(candidate in 1..n_candidates)(if candidate_selected[candidate] then candidate_metric[candidate, metric] else node_metric_bound endif)
  else
    max(candidate in 1..n_candidates)(if candidate_selected[candidate] then candidate_metric[candidate, metric] else -node_metric_bound endif)
  endif;

function var float: selection_log_metric(int: metric) =
  if selection_disjoint then
    sum(task in 1..n_tasks)(task_log(task, metric))
  else
    sum(candidate in 1..n_candidates)(bool2float(candidate_selected[candidate]) * candidate_log[candidate, metric])
  endif;

% Every global metric value is pinned to an explicitly bounded variable: MiniZinc does
% not derive bounds through float min/max folds, and Gecode rejects linear constraints
% over unbounded floats ("Float::linear: Number out of limits").
array[1..n_metrics] of var float: metric_value_var;
constraint forall(metric in 1..n_metrics)(
  metric_value_var[metric] >= -metric_bound[metric] /\ metric_value_var[metric] <= metric_bound[metric] /\
  metric_value_var[metric] =
    if global_metric_model[metric] > 0 then
      sum(scenario in 1..n_scenarios where scenario_model[scenario] == global_metric_model[metric])(
        scenario_probability[scenario] * ready_value[scenario_ready[scenario]])
    elseif metric_scope[metric] == 2 then selection_metric(metric)
    else node_metric[root_node, metric] endif
);
function var float: metric_value(int: metric) = metric_value_var[metric];

% Log-space value of a product metric (only requested by the lowering when the
% metric is a pure product with log-representable values).
array[1..n_metrics] of var -log_metric_bound..log_metric_bound: log_metric;
constraint forall(metric in 1..n_metrics where metric_log_available[metric])(
  log_metric[metric] =
    if metric_scope[metric] == 2 then selection_log_metric(metric)
    else flat_log_value(node_flat[root_node, metric]) endif
);
constraint forall(metric in 1..n_metrics where not metric_log_available[metric])(log_metric[metric] = 0.0);

function var float: atom_operand(int: kind, int: index, float: value, array[int] of float: candidate_values) =
  if kind == 1 then metric_value(index)
  elseif kind == 2 \/ kind == 5 then
    table_value([candidate_values[task_candidates[index, slot]] | slot in 1..n_task_candidates[index]], selected_slot[index])
  elseif kind == 4 then log_metric[index]
  else value endif;

% Operands are materialised at the root so that the fixed-point element behind a
% task-value operand (a let with a fresh variable) is never flattened inside the
% reified context of a soft constraint.
array[1..n_atoms] of var float: atom_left_operand = [
  atom_operand(atom_left_kind[atom], atom_left_index[atom], atom_left_value[atom],
    [atom_left_candidate_value[atom, candidate] | candidate in 1..n_candidates]) | atom in 1..n_atoms];
array[1..n_atoms] of var float: atom_right_operand = [
  atom_operand(atom_right_kind[atom], atom_right_index[atom], atom_right_value[atom],
    [atom_right_candidate_value[atom, candidate] | candidate in 1..n_candidates]) | atom in 1..n_atoms];

predicate atom_holds(int: atom) =
  compare_value(atom_left_operand[atom], atom_operator[atom], atom_right_operand[atom]);

constraint forall(atom in 1..n_atoms where constraint_enforcement[atom_constraint[atom]] == 1)(atom_holds(atom));

% Soft constraints (constant penalties, weights already normalised by the compiler).
array[1..n_constraints] of var bool: constraint_satisfied = [
  if constraint_enforcement[index] == 1 then true
  else forall(atom in 1..n_atoms where atom_constraint[atom] == index)(atom_holds(atom)) endif
  | index in 1..n_constraints];
var float: soft_penalty =
  sum(index in 1..n_constraints where constraint_enforcement[index] == 2)(
    bool2float(not constraint_satisfied[index]) * constraint_penalty[index]);

% Normalised loss. The normalised variable receives an explicit domain and is
% linked to the raw metric by a linear equality instead of a division: with the
% division form, MiniZinc's flattener infers a domain for the quotient from the
% bounds of `raw` and rounds it so tightly that attainable boundary values
% (raw == term_min or raw == term_max) fall one ulp outside it, which produced
% false UNSATISFIABLE proofs and false OPTIMAL claims.
function var float: term_loss(int: index) =
  let {
    var -term_bound[index]..term_bound[index]: raw = metric_value(term_metric[index]),
    float: range = term_max[index] - term_min[index],
    float: low = min((-term_bound[index] - term_min[index]) / range, (term_bound[index] - term_min[index]) / range) - 1.0,
    float: high = max((-term_bound[index] - term_min[index]) / range, (term_bound[index] - term_min[index]) / range) + 1.0,
    var low..high: unbounded_normalized :: is_defined_var,
    constraint unbounded_normalized * range == raw - term_min[index],
    var float: normalized = if term_clamp[index] then
      min(1.0, max(0.0, unbounded_normalized))
    else unbounded_normalized endif
  } in
    if term_has_normalize[index] then
      if term_direction[index] == 1 then normalized else 1.0 - normalized endif
    else
      term_direction[index] * raw
    endif;

var -objective_bound..objective_bound: objective_value =
  sum(index in 1..n_terms)(term_weight[index] * term_loss(index)) + placement_penalty + soft_penalty;
% Branch on the slot variables only (smallest domain first); the lowering lists each
% task's candidates from the most to the least promising estimated loss, so the
% in-order value choice reaches good incumbents early. Every float variable is
% functionally determined by the slots, so no float search is needed.
solve :: int_search(selected_slot, first_fail, indomain_min, complete) minimize objective_value;

output [
  "{\"selected_cand\":[",
  join(",", [show(selected_candidate[task]) | task in 1..n_tasks]),
  "],\"objective_value\":", show(objective_value), "}\n"
];
