import sys
import os
import unittest
sys.path.append(os.path.join(os.path.dirname(__file__), "../src"))

from openbinding_gateway.validation.analysis import compute_binding_space_summary, generate_warnings
from openbinding_gateway.models.api import BindingSpaceSummary, AnalyzeWarning

class TestAnalysisLogic(unittest.TestCase):
    def test_compute_binding_space_simple(self):
        instance = {
            "tasks": [{"id": "t1"}, {"id": "t2"}],
            "candidates": [
                {"id": "c1", "task_id": "t1"},
                {"id": "c2", "task_id": "t1"},
                {"id": "c3", "task_id": "t2"}
            ]
        }
        summary = compute_binding_space_summary(instance)
        self.assertEqual(summary.cardinality, "2") # 2 * 1
        self.assertEqual(summary.per_task_counts, {"t1": 2, "t2": 1})
        self.assertEqual(summary.empty_tasks, [])
        self.assertGreater(summary.log10_cardinality, 0.3)

    def test_compute_binding_space_empty_task(self):
        instance = {
            "tasks": [{"id": "t1"}, {"id": "t2"}],
            "candidates": [
                {"id": "c1", "task_id": "t1"}
            ]
        }
        summary = compute_binding_space_summary(instance)
        self.assertEqual(summary.cardinality, "0")
        self.assertEqual(summary.per_task_counts, {"t1": 1, "t2": 0})
        self.assertIn("t2", summary.empty_tasks)
        self.assertEqual(summary.log10_cardinality, 0.0)

    def test_generate_warnings(self):
        summary = BindingSpaceSummary(
            cardinality="0",
            log10_cardinality=0.0,
            per_task_counts={"t1": 0},
            empty_tasks=["t1"]
        )
        warnings = generate_warnings(summary)
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0].code, "EMPTY_TASK")
        self.assertEqual(warnings[0].details["empty_task_ids"], ["t1"])

    def test_generate_warnings_explosion(self):
        summary = BindingSpaceSummary(
            cardinality="10000000000",
            log10_cardinality=10.0,
            per_task_counts={"t1": 10},
            empty_tasks=[]
        )
        warnings = generate_warnings(summary)
        self.assertGreaterEqual(len(warnings), 1)
        codes = [w.code for w in warnings]
        self.assertIn("COMBINATORIAL_EXPLOSION", codes)

if __name__ == "__main__":
    unittest.main()
