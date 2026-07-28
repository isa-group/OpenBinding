package es.us.isa.openbinding.evolutionary;

import es.us.isa.openbinding.core.EngineModels;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What is this engine's own: its jMetal options and the shape of its response.
 *
 * <p>The instance and placement models come from {@code binding-core}, shared
 * with every other JVM engine. They used to be duplicated here, with a javadoc
 * on each copy promising it was kept in sync with the other by hand.
 */
final class ApiModels {
  private ApiModels() {}

  /**
   * This engine's request. The instance and the placement view come from the
   * shared core; the options are its own, since jMetal takes parameters no
   * other engine has.
   */
  static final class SolveRequest {
    EngineModels.Instance instance;
    Options options = new Options();
    es.us.isa.openbinding.core.model.Placement placement;
  }

  static final class Options {
    String algorithm = "AUTO";
    // Variation operators: SBX (IntegerSBX + polynomial mutation, jMetal
    // defaults) or UNIFORM (uniform crossover + random-reset mutation, the
    // standard choice for categorical candidate indices).
    String operators = "SBX";
    int population_size = 100;
    // Without a time budget: total evaluation budget. With a time budget:
    // minimum number of evaluations that is always honoured.
    int max_evaluations = 10_000;
    double crossover_probability = 0.9;
    Double mutation_probability;
    double distribution_index = 20.0;
    int archive_size = 100;
    double soft_penalty = 10.0;
    long seed = 1L;
    int reference_divisions = 12;
    // Wall-clock stopping criterion (MONO only).
    Long time_budget_ms;
  }

  static final class SolveResponse {
    List<SolutionDto> solutions = new ArrayList<>();
    Provenance provenance = new Provenance();
  }

  static final class SolutionDto {
    double objective_value;
    Map<String, String> binding = new LinkedHashMap<>();
    Map<String, Double> aggregated_features = new LinkedHashMap<>();
    List<EngineModels.ViolationDto> violations = new ArrayList<>();
    Map<String, Object> metadata = new LinkedHashMap<>();
  }

  static final class Provenance {
    String engine_id = "evolutionary-heuristics";
    long execution_time_ms;
    Map<String, Object> metadata = new LinkedHashMap<>();
  }

}
