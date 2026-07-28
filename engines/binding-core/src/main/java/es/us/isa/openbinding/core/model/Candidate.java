package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Candidate model (M'_C = (P, C, F, R, L)): who can run each task and with
 * what local quality attributes.
 */
public final class Candidate {
  public String id;
  public String task_id;
  public String provider_id;
  public Map<String, Double> features = new LinkedHashMap<>();
}
