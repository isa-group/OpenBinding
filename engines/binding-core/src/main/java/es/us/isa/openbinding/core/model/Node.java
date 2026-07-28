package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Application model (M_A = (T, G, Lambda)): the tasks, the orchestration that
 * composes them, and how a feature aggregates along it.
 */
public final class Node {
  public String id;
  public String kind;
  public String task_id;
  public List<Node> children;
  public List<Branch> branches;
  public Node body;
  public Double expected_iterations;
  public NumericRange bounds;
}
