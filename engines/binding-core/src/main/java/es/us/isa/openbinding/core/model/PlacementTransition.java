package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Deployment part of the candidate model (R and L): the pools a candidate can
 * run on, their capacities, and the network between them.
 */
public final class PlacementTransition {
  public String id;
  public Boolean hard;
  public String from_task;
  public String from_event;
  public String to_task;
  public String op;
  public Object value;

  public boolean isHard() {
    return hard == null || hard;
  }
}
