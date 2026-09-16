"""Tests for legacy QACO problem parser."""

from __future__ import annotations

from pathlib import Path
import pytest

from openbinding_gateway.generator.legacy_parser import (
    LegacyProblem,
    StructureNode,
    parse_legacy_file,
    parse_legacy_text,
)


@pytest.fixture
def sample_legacy_text() -> str:
    return """%#============================= HEADER ======================================#
% Problem Statistics: 
% Number of activities: 4
% Number of Candidate Services: 6
% Number of Constraints: 2
%#======================= COMPOSITION STRUCTURE =============================#
% Abstract Services:
4
t1
t2
t3
t4
% CompositionStructure:
SEC[
    t1,
    BRANCH(0.6;0.4;)[
        t2,
        t3,
    ],
    LOOP(5)[
        t4,
    ],
]
%#======================= QOS MODEL =============================#
QoSModel{
    Properties{
         ExecTime:NEGATIVE€Double[0.0,1.0]
         Cost:NEGATIVE€Double[0.0,1.0]
         Availability:POSITIVE€Double[0.0,1.0]
    }
    AggregationFunctions(
         ExecTime{
             Loop:SUM
             Branch:SUM
             Flow:MAX
             Sequence:SUM
         }
         Cost{
             Loop:SUM
             Branch:SUM
             Flow:SUM
             Sequence:SUM
         }
    )
    Weights(
         ExecTime:0.5
         Cost:0.5
    )
}
%#======================= CANDIDATE SERVICES =============================#
------------------------
t1
------------------------
s11(ExecTime:0.1,Cost:0.2,Availability:0.9,)
s12(ExecTime:0.3,Cost:0.4,Availability:0.8,)
------------------------
t2
------------------------
s21(ExecTime:0.2,Cost:0.1,Availability:0.95,)
------------------------
t3
------------------------
s31(ExecTime:0.4,Cost:0.3,Availability:0.85,)
------------------------
t4
------------------------
s41(ExecTime:0.05,Cost:0.05,Availability:0.99,)
------------------------
%#======================= CONSTRAINTS =============================#
2
LOWEREQUAL(ExecTime, 50.0)
GREATEREQUAL(Availability, 0.8)
"""


def test_parse_legacy_text_structures(sample_legacy_text: str):
    parsed = parse_legacy_text(sample_legacy_text)
    assert isinstance(parsed, LegacyProblem)

    # Workflow checks
    assert isinstance(parsed.structure, StructureNode)
    assert parsed.structure.kind == "sequence"
    assert len(parsed.structure.children) == 3

    # Child 0: Leaf Task t1
    assert parsed.structure.children[0].kind == "task"
    assert parsed.structure.children[0].id == "t1"

    # Child 1: BranchNode (t2, t3)
    branch = parsed.structure.children[1]
    assert branch.kind == "branch"
    assert len(branch.children) == 2
    assert branch.children[0].id == "t2"
    assert branch.children[1].id == "t3"
    assert branch.probabilities == [0.6, 0.4]

    # Child 2: LoopNode (5 iterations, t4)
    loop = parsed.structure.children[2]
    assert loop.kind == "loop"
    assert loop.iterations == 5
    assert loop.children[0].id == "t4"

    # Candidates check
    assert len(parsed.candidates) == 4
    assert "t1" in parsed.candidates
    assert len(parsed.candidates["t1"]) == 2
    assert parsed.candidates["t1"][0].name == "s11"
    assert parsed.candidates["t1"][0].metrics["ExecTime"] == 0.1

    # QoS Model check
    assert len(parsed.qos_properties) == 3
    assert "ExecTime" in parsed.qos_properties
    assert parsed.qos_properties["ExecTime"].direction == "minimize"
    assert parsed.qos_properties["Availability"].direction == "maximize"

    # Constraints check
    assert len(parsed.constraints) == 2
    assert parsed.constraints[0].property_name == "ExecTime"
    assert parsed.constraints[0].operator == "<="
    assert parsed.constraints[0].value == 50.0

    assert parsed.constraints[1].property_name == "Availability"
    assert parsed.constraints[1].operator == ">="
    assert parsed.constraints[1].value == 0.8


def test_parse_pruebatonta_fixture():
    fixture_path = Path(__file__).parent / "fixtures" / "generator" / "pruebatonta.txt"
    if not fixture_path.exists():
        pytest.skip(f"Fixture not found at {fixture_path}")

    parsed = parse_legacy_file(str(fixture_path))
    assert isinstance(parsed, LegacyProblem)
    assert len(parsed.candidates) > 0
    assert len(parsed.qos_properties) > 0
    assert parsed.structure.kind == "sequence"


def test_parse_legacy_text_empty_structure():
    empty_spec = """%#============================= HEADER ======================================#
%#======================= COMPOSITION STRUCTURE =============================#
% Abstract Services:
0
% CompositionStructure:
%#======================= QOS MODEL =============================#
%#======================= CANDIDATE SERVICES =============================#
%#======================= CONSTRAINTS =============================#
"""
    parsed = parse_legacy_text(empty_spec)
    assert isinstance(parsed, LegacyProblem)
    assert len(parsed.candidates) == 0
    assert len(parsed.constraints) == 0
