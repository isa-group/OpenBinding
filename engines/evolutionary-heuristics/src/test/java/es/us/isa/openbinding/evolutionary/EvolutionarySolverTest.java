package es.us.isa.openbinding.evolutionary;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.google.gson.Gson;
import org.junit.jupiter.api.Test;

class EvolutionarySolverTest {
  private static final Gson GSON = new Gson();

  @Test
  void runsNsgaIIForMonoObjective() {
    ApiModels.SolveRequest request = request("MONO", """
        ["cost"]
        """, """
        {"cost":1.0}
        """);

    ApiModels.SolveResponse response = new EvolutionarySolver().solve(request);

    assertFalse(response.solutions.isEmpty());
    assertEquals("NSGAII", response.provenance.metadata.get("algorithm"));
  }

  @Test
  void runsNsgaIIIForManyObjectives() {
    ApiModels.SolveRequest request = request("MANY", """
        ["cost","latency","reliability"]
        """, """
        {"cost":0.34,"latency":0.33,"reliability":0.33}
        """);

    ApiModels.SolveResponse response = new EvolutionarySolver().solve(request);

    assertFalse(response.solutions.isEmpty());
    assertEquals("NSGAIII", response.provenance.metadata.get("algorithm"));
  }

  private ApiModels.SolveRequest request(String type, String targets, String weights) {
    String json = """
        {
          "instance": {
            "features": [
              {"id":"cost","direction":"MINIMIZE","valid_range":{"min":0,"max":100}},
              {"id":"latency","direction":"MINIMIZE","valid_range":{"min":0,"max":100}},
              {"id":"reliability","direction":"MAXIMIZE","valid_range":{"min":0,"max":1}}
            ],
            "candidates": [
              {"id":"a1","task_ids":["a"],"features":{"cost":10,"latency":30,"reliability":0.9}},
              {"id":"a2","task_ids":["a"],"features":{"cost":30,"latency":10,"reliability":0.99}},
              {"id":"b1","task_ids":["b"],"features":{"cost":20,"latency":20,"reliability":0.95}},
              {"id":"b2","task_ids":["b"],"features":{"cost":5,"latency":50,"reliability":0.8}}
            ],
            "composition": {
              "type":"STRUCTURED",
              "root":{"kind":"SEQ","children":[
                {"kind":"TASK","task_id":"a"},
                {"kind":"TASK","task_id":"b"}
              ]}
            },
            "aggregation_policies": {
              "cost":{"neutral":0,"compose":{"seq":{"fn":"SUM"}}},
              "latency":{"neutral":0,"compose":{"seq":{"fn":"SUM"}}},
              "reliability":{"neutral":1,"compose":{"seq":{"fn":"PRODUCT"}}}
            },
            "constraints": [],
            "objective": {
              "type":"%s","targets":%s,"weights":%s
            }
          },
          "options": {
            "population_size":20,
            "max_evaluations":100,
            "archive_size":10,
            "seed":7,
            "reference_divisions":4
          }
        }
        """.formatted(type, targets, weights);
    return GSON.fromJson(json, ApiModels.SolveRequest.class);
  }
}
