package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Deployment part of the candidate model (R and L): the pools a candidate can
 * run on, their capacities, and the network between them.
 */
public final class PlacementResourceConstraint {
  public String id;
  public Boolean hard;
  public List<String> resources = new ArrayList<>();
  public List<String> pools = new ArrayList<>();

  public boolean isHard() {
    return hard == null || hard;
  }
}
