package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Objective (O): how eligible bindings are ranked against each other.
 */
public final class Objective {
  public String type;
  public List<String> targets = new ArrayList<>();
  public Map<String, Double> weights = new LinkedHashMap<>();
}
