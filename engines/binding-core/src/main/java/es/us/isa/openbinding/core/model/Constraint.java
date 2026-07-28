package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Constraints (Delta): what a binding must satisfy to be eligible.
 */
public final class Constraint {
  public String id;
  public String kind;
  public String scope;
  public String attribute_id;
  public String op;
  public Object value;
  public List<String> tasks = new ArrayList<>();
  public String type;
  public Boolean hard;

  public boolean isHard() {
    return hard == null || hard;
  }
}
