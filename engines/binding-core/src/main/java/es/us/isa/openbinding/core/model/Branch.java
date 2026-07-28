package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Application model (M_A = (T, G, Lambda)): the tasks, the orchestration that
 * composes them, and how a feature aggregates along it.
 */
public final class Branch {
  public double p;
  public Node child;
}
