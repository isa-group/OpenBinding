package es.us.isa.qosawarewsbinding.api.dto;

import java.util.Map;

public class SolveResponse {
    public String status; // optimized, error
    public Map<String, String> selection; // task_id -> service_id
    public Map<String, Double> aggregated_features; // aggregated qos
    public Object metadata;
    public String error;
    public Long execution_time;
    public Integer iterations_count;
    public Long seed;
    public Object trace; // best-so-far improvements (BIM* path)
    // BIM* path: the engine's internal search objective for the returned
    // binding (weighted mean of normalized losses; lower is better) and its
    // own feasibility verdict. Audited by the gateway against the canonical
    // reference evaluation.
    public Double objective_value;
    public Boolean feasible;
}
