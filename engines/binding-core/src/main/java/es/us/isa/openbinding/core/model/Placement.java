package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Deployment part of the candidate model (R and L): the pools a candidate can
 * run on, their capacities, and the network between them.
 */
public final class Placement {
  public Map<String, String> pool_of_candidate = new LinkedHashMap<>();
  public Map<String, Map<String, Double>> demand_of_candidate = new LinkedHashMap<>();
  public List<Pool> pools = new ArrayList<>();
  public List<PlacementResourceConstraint> resource_constraints = new ArrayList<>();
  public Map<String, Map<String, Double>> latency_matrix = new LinkedHashMap<>();
  public Map<String, Map<String, Double>> event_latency = new LinkedHashMap<>();
  public Map<String, String> event_pools = new LinkedHashMap<>();
  public List<PlacementTransition> transitions = new ArrayList<>();
  public E2eModel e2e;
}
