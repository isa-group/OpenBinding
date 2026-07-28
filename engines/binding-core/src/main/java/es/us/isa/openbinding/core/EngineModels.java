package es.us.isa.openbinding.core;

import es.us.isa.openbinding.core.model.AggregationPolicy;
import es.us.isa.openbinding.core.model.Candidate;
import es.us.isa.openbinding.core.model.Composition;
import es.us.isa.openbinding.core.model.Constraint;
import es.us.isa.openbinding.core.model.Feature;
import es.us.isa.openbinding.core.model.Objective;
import es.us.isa.openbinding.core.model.Placement;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The request a JVM engine receives, and the instance inside it.
 *
 * <p>The instance is I' = (M_A, M'_C, Delta, O); each component of the tuple
 * lives in {@code core.model}, one class per file, so a model can be read and
 * reused on its own.
 *
 * <p>The placement view is not part of the request: engines derive it from the
 * instance's optional {@code resource_model} and {@code latency_model} blocks
 * through {@link PlacementAdapter}, so the field is filled in locally rather
 * than received.
 */
public final class EngineModels {
  private EngineModels() {}

  public static final class SolveRequest {
    public String id;
    public Instance instance;
    public Placement placement;
    public Options options = new Options();
  }

  /** Search budget and seed, shared by the engines that take them. */
  public static final class Options {
    // Minimum number of evaluations (the sole budget when no time budget is set).
    public int max_iterations = 1000;
    public Long seed;
    // Wall-clock stopping criterion; the search always completes at least
    // max_iterations evaluations even if the budget has expired.
    public Long time_budget_ms;
    // Size of the Pareto archive, for the engines that keep one.
    public int archive_size = 20;
  }

  public static final class Instance {
    public Metadata metadata;
    public List<Feature> features = new ArrayList<>();
    public List<Candidate> candidates = new ArrayList<>();
    public Composition composition;
    public Map<String, AggregationPolicy> aggregation_policies = new LinkedHashMap<>();
    public List<Constraint> constraints = new ArrayList<>();
    public Objective objective;
  }

  public static final class Metadata {
    public String id;
  }

  public static final class ViolationDto {
    public String constraint_id;
    public String message;
    public String code = "constraint_violation";
    public double penalty;
    public String description;
  }

}
