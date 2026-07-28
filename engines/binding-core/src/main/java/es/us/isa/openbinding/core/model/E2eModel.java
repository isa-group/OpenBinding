package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Deployment part of the candidate model (R and L): the pools a candidate can
 * run on, their capacities, and the network between them.
 */
public final class E2eModel {
  public String attribute_id;
  public boolean include_execution_latency_feature;
  public String xor_semantics;
  public List<E2eScenario> scenarios = new ArrayList<>();
}
