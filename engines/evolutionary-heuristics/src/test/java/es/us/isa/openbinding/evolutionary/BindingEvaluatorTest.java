package es.us.isa.openbinding.evolutionary;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.Gson;
import java.util.List;
import org.junit.jupiter.api.Test;

class BindingEvaluatorTest {
  private static final Gson GSON = new Gson();

  @Test
  void aggregatesGlobalQualityAndOrientsLosses() {
    ApiModels.SolveRequest request = parse("""
        {
          "instance": {
            "features": [
              {"id":"cost","direction":"MINIMIZE","valid_range":{"min":0,"max":100}},
              {"id":"reliability","direction":"MAXIMIZE","valid_range":{"min":0,"max":1}}
            ],
            "candidates": [
              {"id":"a1","task_id":"a","provider_id":"p1","features":{"cost":10,"reliability":0.9}},
              {"id":"b1","task_id":"b","provider_id":"p1","features":{"cost":20,"reliability":0.8}}
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
              "reliability":{"neutral":1,"compose":{"seq":{"fn":"PRODUCT"}}}
            },
            "constraints": [],
            "objective": {
              "type":"MULTI",
              "targets":["cost","reliability"],
              "weights":{"cost":0.5,"reliability":0.5}
            }
          }
        }
        """);

    BindingEvaluator.Evaluation evaluation =
        new BindingEvaluator(request.instance).evaluate(List.of(0, 0));

    assertEquals(30.0, evaluation.aggregated().get("cost"), 1e-12);
    assertEquals(0.72, evaluation.aggregated().get("reliability"), 1e-12);
    assertEquals(0.30, evaluation.losses().get("cost"), 1e-12);
    assertEquals(0.28, evaluation.losses().get("reliability"), 1e-12);
  }

  @Test
  void separatesNormalizedHardAndSoftViolations() {
    ApiModels.SolveRequest request = parse("""
        {
          "instance": {
            "features": [
              {"id":"latency","direction":"MINIMIZE","valid_range":{"min":0,"max":100}}
            ],
            "candidates": [
              {"id":"slow","task_id":"a","provider_id":"p1","features":{"latency":60}},
              {"id":"other","task_id":"b","provider_id":"p1","features":{"latency":10}}
            ],
            "composition": {
              "type":"STRUCTURED",
              "root":{"kind":"SEQ","children":[
                {"kind":"TASK","task_id":"a"},
                {"kind":"TASK","task_id":"b"}
              ]}
            },
            "aggregation_policies": {
              "latency":{"neutral":0,"compose":{"seq":{"fn":"SUM"}}}
            },
            "constraints": [
              {
                "id":"hard-global","kind":"ATTRIBUTE_BOUND","scope":"GLOBAL",
                "attribute_id":"latency","op":"<=","value":50,"hard":true
              },
              {
                "id":"soft-local","kind":"ATTRIBUTE_BOUND","scope":"LOCAL",
                "attribute_id":"latency","op":"<=","value":40,"tasks":["a"],"hard":false
              }
            ],
            "objective": {
              "type":"MONO","targets":["latency"],"weights":{"latency":1.0}
            }
          }
        }
        """);

    BindingEvaluator.Evaluation evaluation =
        new BindingEvaluator(request.instance).evaluate(List.of(0, 0));

    assertEquals(0.20, evaluation.constraints().hardViolation(), 1e-12);
    assertEquals(0.20, evaluation.constraints().softViolation(), 1e-12);
    assertEquals(2, evaluation.constraints().violations().size());
  }

  @Test
  void evaluatesProviderDependencies() {
    ApiModels.SolveRequest request = parse("""
        {
          "instance": {
            "features": [
              {"id":"cost","direction":"MINIMIZE","valid_range":{"min":0,"max":10}}
            ],
            "candidates": [
              {"id":"a1","task_id":"a","provider_id":"p1","features":{"cost":1}},
              {"id":"b1","task_id":"b","provider_id":"p2","features":{"cost":1}}
            ],
            "composition": {
              "type":"STRUCTURED",
              "root":{"kind":"SEQ","children":[
                {"kind":"TASK","task_id":"a"},
                {"kind":"TASK","task_id":"b"}
              ]}
            },
            "aggregation_policies": {
              "cost":{"neutral":0,"compose":{"seq":{"fn":"SUM"}}}
            },
            "constraints": [
              {
                "id":"same-provider","kind":"DEPENDENCY","type":"SAME_PROVIDER",
                "tasks":["a","b"],"hard":true
              }
            ],
            "objective": {
              "type":"MONO","targets":["cost"],"weights":{"cost":1.0}
            }
          }
        }
        """);

    BindingEvaluator.Evaluation evaluation =
        new BindingEvaluator(request.instance).evaluate(List.of(0, 0));

    assertEquals(0.5, evaluation.constraints().hardViolation(), 1e-12);
    assertEquals(0.0, evaluation.constraints().softViolation(), 1e-12);
  }

  @Test
  void aggregatesPercentageRatiosInProductSpace() {
    ApiModels.SolveRequest request = parse("""
        {
          "instance": {
            "features": [
              {
                "id":"availability","direction":"MAXIMIZE","scale":"RATIO",
                "valid_range":{"min":0,"max":100}
              }
            ],
            "candidates": [
              {"id":"a1","task_id":"a","features":{"availability":99}},
              {"id":"b1","task_id":"b","features":{"availability":98}}
            ],
            "composition": {
              "type":"STRUCTURED",
              "root":{"kind":"SEQ","children":[
                {"kind":"TASK","task_id":"a"},
                {"kind":"TASK","task_id":"b"}
              ]}
            },
            "aggregation_policies": {
              "availability":{"neutral":1,"compose":{"seq":{"fn":"PRODUCT"}}}
            },
            "constraints": [],
            "objective": {
              "type":"MONO","targets":["availability"],"weights":{"availability":1.0}
            }
          }
        }
        """);

    BindingEvaluator.Evaluation evaluation =
        new BindingEvaluator(request.instance).evaluate(List.of(0, 0));

    assertEquals(97.02, evaluation.aggregated().get("availability"), 1e-12);
    assertEquals(0.0298, evaluation.losses().get("availability"), 1e-12);
  }

  private ApiModels.SolveRequest parse(String json) {
    return GSON.fromJson(json, ApiModels.SolveRequest.class);
  }
}
