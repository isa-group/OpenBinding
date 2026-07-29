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

  /**
   * Every task this candidate can implement. A binding still picks one
   * candidate per task; the same candidate may be picked for several of the
   * tasks listed here, which is what makes it one thing serving all of them.
   */
  public List<String> task_ids = new ArrayList<>();

  public String provider_id;
  public Map<String, Double> features = new LinkedHashMap<>();
}
