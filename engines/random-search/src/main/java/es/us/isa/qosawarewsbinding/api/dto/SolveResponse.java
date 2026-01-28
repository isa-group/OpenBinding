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
}
