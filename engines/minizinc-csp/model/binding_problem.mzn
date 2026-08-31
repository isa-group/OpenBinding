% Exact deterministic BIM v1 subset consumed by minizinc-csp/exact-weighted.

int: n_tasks;
int: n_candidates;
int: n_metrics;
int: max_candidates_per_task;
array[1..n_tasks] of int: n_task_candidates;
array[1..n_tasks, 1..max_candidates_per_task] of int: task_candidates;
array[1..n_candidates, 1..n_metrics] of float: candidate_metric;
array[1..n_metrics] of float: metric_neutral;
array[1..n_metrics] of int: metric_scope; % 1 invocation, 2 selectedCandidate
array[1..n_metrics] of int: selection_aggregation; % 1 sum, 3 min, 4 max
float: node_metric_bound;
float: objective_bound;

int: root_node;
int: n_nodes;
int: max_children;
array[1..n_nodes] of int: node_kind; % 1 empty/local, 2 task, 3 seq, 4 parallel, 5 xor, 6 repeat
array[1..n_nodes] of int: node_task;
array[1..n_nodes] of int: node_child_count;
array[1..n_nodes, 1..max_children] of int: node_children;
array[1..n_nodes, 1..max_children] of float: node_weights;
array[1..n_nodes] of int: node_repeat_count;
array[1..n_metrics, 1..4] of int: aggregation; % sequence, parallel, exclusive, repeat

int: n_constraints;
array[1..n_constraints] of int: constraint_operator;
array[1..n_constraints] of int: constraint_left_kind; % 1 global metric, 2 selected task value, 3 literal
array[1..n_constraints] of int: constraint_left_index;
array[1..n_constraints] of float: constraint_left_value;
array[1..n_constraints, 1..n_candidates] of float: constraint_left_candidate_value;
array[1..n_constraints] of int: constraint_right_kind;
array[1..n_constraints] of int: constraint_right_index;
array[1..n_constraints] of float: constraint_right_value;
array[1..n_constraints, 1..n_candidates] of float: constraint_right_candidate_value;

int: n_terms;
array[1..n_terms] of int: term_metric;
array[1..n_terms] of float: term_weight;
array[1..n_terms] of int: term_direction;
array[1..n_terms] of bool: term_has_normalize;
array[1..n_terms] of float: term_min;
array[1..n_terms] of float: term_max;
array[1..n_terms] of bool: term_clamp;

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
array[1..n_capacity_checks] of int: capacity_pool;
array[1..n_capacity_checks] of int: capacity_scope; % 1 invocation, 2 distinct selected candidate
array[1..n_capacity_checks] of float: capacity_limit;
array[1..n_capacity_checks, 1..n_candidates] of float: capacity_demand;

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

% Gecode requires finite domains for float variables. The TypeScript lowering
% computes a conservative bound from candidates and the workflow.
array[1..n_nodes, 1..n_metrics] of var -node_metric_bound..node_metric_bound: node_metric;

constraint forall(node in 1..n_nodes, metric in 1..n_metrics)(
  if node_kind[node] == 1 then
    node_metric[node, metric] = metric_neutral[metric]
  elseif node_kind[node] == 2 then
    node_metric[node, metric] = candidate_metric[selected_candidate[node_task[node]], metric]
  elseif node_kind[node] == 6 then
    let {
      var float: child = node_metric[node_children[node, 1], metric],
      int: op = aggregation[metric, 4]
    } in
      if op == 6 then node_metric[node, metric] = child * node_repeat_count[node]
      elseif op == 8 then node_metric[node, metric] = child
      else false endif
  else
    let {
      array[int] of var float: children =
        [node_metric[node_children[node, child], metric] | child in 1..node_child_count[node]],
      int: column = if node_kind[node] == 3 then 1 elseif node_kind[node] == 4 then 2 else 3 endif,
      int: op = aggregation[metric, column]
    } in
      if op == 1 then node_metric[node, metric] = sum(children)
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
  [candidate_pool[selected_candidate[task]] | task in 1..n_tasks];
array[1..n_tasks] of var 0..max(1, max(candidate_model)): task_model =
  [candidate_model[selected_candidate[task]] | task in 1..n_tasks];
array[1..n_candidates] of var bool: candidate_selected =
  [exists(task in 1..n_tasks)(selected_candidate[task] == candidate) | candidate in 1..n_candidates];

constraint forall(check in 1..n_capacity_checks)(
  if capacity_scope[check] == 1 then
    sum(task in 1..n_tasks)(
      bool2int(task_pool[task] == capacity_pool[check]) * task_invocation[task]
        * capacity_demand[check, selected_candidate[task]]
    ) <= capacity_limit[check]
  else
    sum(candidate in 1..n_candidates where candidate_pool[candidate] == capacity_pool[check])(
      bool2int(candidate_selected[candidate]) * capacity_demand[check, candidate]
    ) <= capacity_limit[check]
  endif
);

array[1..n_transitions] of var 1..n_pool_slots: transition_from_pool =
  [if transition_from_kind[index] == 1 then event_pool[transition_from[index]]
   else task_pool[transition_from[index]] endif | index in 1..n_transitions];
array[1..n_transitions] of var 1..n_pool_slots: transition_to_pool =
  [if transition_to_kind[index] == 1 then event_pool[transition_to[index]]
   else task_pool[transition_to[index]] endif | index in 1..n_transitions];
array[1..n_transitions] of var float: transition_latency =
  [if transition_from_kind[index] == 1 then
     event_latency[transition_from[index], transition_to_pool[index]]
   else pool_latency[transition_from_pool[index], transition_to_pool[index]] endif
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
             event_latency[activity_predecessor_source[activity, predecessor], activity_pool[activity]]
           else pool_latency[activity_pool[activity_predecessor_source[activity, predecessor]], activity_pool[activity]] endif)
      )
    endif /\
  activity_finish[activity] = activity_start[activity]
    + (if activity_exec_metric[activity] == 0 then 0.0
       else candidate_metric[selected_candidate[activity_task[activity]], activity_exec_metric[activity]] endif)
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
  if not exists(candidate in 1..n_candidates)(candidate_selected[candidate]) then metric_neutral[metric]
  elseif selection_aggregation[metric] == 1 then
    sum(candidate in 1..n_candidates)(bool2int(candidate_selected[candidate]) * candidate_metric[candidate, metric])
  elseif selection_aggregation[metric] == 3 then
    min(candidate in 1..n_candidates)(if candidate_selected[candidate] then candidate_metric[candidate, metric] else node_metric_bound endif)
  else
    max(candidate in 1..n_candidates)(if candidate_selected[candidate] then candidate_metric[candidate, metric] else -node_metric_bound endif)
  endif;

function var float: metric_value(int: metric) =
  if global_metric_model[metric] > 0 then
    sum(scenario in 1..n_scenarios where scenario_model[scenario] == global_metric_model[metric])(
      scenario_probability[scenario] * ready_value[scenario_ready[scenario]])
  elseif metric_scope[metric] == 2 then selection_metric(metric)
  else node_metric[root_node, metric] endif;

function var float: constraint_left(int: index) =
  if constraint_left_kind[index] == 1 then metric_value(constraint_left_index[index])
  elseif constraint_left_kind[index] == 2 then
    constraint_left_candidate_value[index, selected_candidate[constraint_left_index[index]]]
  else constraint_left_value[index] endif;
function var float: constraint_right(int: index) =
  if constraint_right_kind[index] == 1 then metric_value(constraint_right_index[index])
  elseif constraint_right_kind[index] == 2 then
    constraint_right_candidate_value[index, selected_candidate[constraint_right_index[index]]]
  else constraint_right_value[index] endif;

constraint forall(index in 1..n_constraints)(
  compare_value(
    constraint_left(index), constraint_operator[index], constraint_right(index))
);

function var float: term_loss(int: index) =
  let {
    var float: raw = metric_value(term_metric[index]),
    var float: unbounded_normalized = (raw - term_min[index]) / (term_max[index] - term_min[index]),
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
  sum(index in 1..n_terms)(term_weight[index] * term_loss(index)) + placement_penalty;
solve minimize objective_value;

output [
  "{\"selected_cand\":[",
  join(",", [show(selected_candidate[task]) | task in 1..n_tasks]),
  "],\"objective_value\":", show(objective_value), "}\n"
];
