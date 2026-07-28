package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Deployment part of the candidate model (R and L): the pools a candidate can
 * run on, their capacities, and the network between them.
 */
public final class E2eScenario {
  public double prob;
  public List<String> order = new ArrayList<>();
  public Map<String, List<List<String>>> preds = new LinkedHashMap<>();
  public List<String> sinks = new ArrayList<>();
}
