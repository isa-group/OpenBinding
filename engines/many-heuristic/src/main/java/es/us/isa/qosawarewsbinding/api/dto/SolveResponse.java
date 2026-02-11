package es.us.isa.qosawarewsbinding.api.dto;

import java.util.Map;
import java.util.List;

public class SolveResponse {
    public String status; // optimized, error
    public Map<String, String> selection; // task_id -> service_id
    public Map<String, Double> aggregated_features; // aggregated qos
    public Object metadata;
    public String error;
    public Long execution_time;
    public Integer iterations_count;

    public List<SolutionDTO> solutions;

    public static class SolutionDTO {
        public Map<String, String> selection;
        public Map<String, Double> aggregated_features;
        public boolean is_feasible;
        public Double objective_value;
    }
}
