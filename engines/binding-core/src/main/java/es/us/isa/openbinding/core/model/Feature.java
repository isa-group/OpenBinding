package es.us.isa.openbinding.core.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Candidate model (M'_C = (P, C, F, R, L)): who can run each task and with
 * what local quality attributes.
 */
public final class Feature {
  public String id;
  public String direction;
  public String scale;
  public NumericRange valid_range;

  /**
   * What happens to this feature when one candidate serves k tasks at once:
   * REPLICATE (the default) charges every task the full value, DIVIDE splits
   * it evenly between them. The two agree when k is 1.
   */
  public String sharing;
}
