% Meta-Routing 1-Task Optimization Model (MAPE-K Plan Phase)
% Selects optimal candidate engine given instance features and QoS goals.

int: n_candidates;
set of int: CANDIDATES = 1..n_candidates;

% Candidate predicted metrics
array[CANDIDATES] of float: latency;
array[CANDIDATES] of float: quality;
array[CANDIDATES] of float: failure_risk;
array[CANDIDATES] of float: credits;
array[CANDIDATES] of float: confidence;
array[CANDIDATES] of bool: is_exact;
array[CANDIDATES] of bool: is_available;

% Hard constraints
float: max_time_budget;
float: max_credits;
float: min_quality;
float: max_failure_risk;
float: min_confidence;
bool: require_exact;

% Soft preferences weights
float: weight_quality;
float: weight_latency;
float: weight_cost;
float: weight_reliability;

% Normalization scales
float: max_latency_scale;
float: max_credits_scale;

% Decision variable: index of selected engine
var CANDIDATES: selected;

% Hard constraints enforcement
constraint is_available[selected] == true;
constraint latency[selected] <= max_time_budget;
constraint credits[selected] <= max_credits;
constraint quality[selected] >= min_quality;
constraint failure_risk[selected] <= max_failure_risk;
constraint confidence[selected] >= min_confidence;
constraint (require_exact -> is_exact[selected] == true);

% Objective: Simple Additive Weighting (SAW) utility function
var float: utility =
    weight_quality * quality[selected]
    - weight_latency * (latency[selected] / max_latency_scale)
    - weight_cost * (credits[selected] / max_credits_scale)
    - weight_reliability * failure_risk[selected];

solve maximize utility;

output [
  "{\n",
  "  \"selected\": ", show(selected), ",\n",
  "  \"utility\": ", show(utility), ",\n",
  "  \"latency\": ", show(latency[selected]), ",\n",
  "  \"quality\": ", show(quality[selected]), ",\n",
  "  \"credits\": ", show(credits[selected]), ",\n",
  "  \"failure_risk\": ", show(failure_risk[selected]), ",\n",
  "  \"confidence\": ", show(confidence[selected]), "\n",
  "}\n"
];
