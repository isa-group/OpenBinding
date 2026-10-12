"""A minimal self-contained BIM Instance (one BPMN service task) for tests that need no corpus."""

from __future__ import annotations

import io
import json
import zipfile

from bim_core import InstancePackage

ROOT = {
    "apiVersion": "bim/v1",
    "kind": "Instance",
    "metadata": {"name": "test"},
    "spec": {"profile": "qos-binding/v1", "resources": {}},
}

BPMN = b'''<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="https://example.test/bpmn">
  <process id="p1" isExecutable="true">
    <startEvent id="start"><outgoing>f1</outgoing></startEvent>
    <serviceTask id="task"><incoming>f1</incoming><outgoing>f2</outgoing></serviceTask>
    <endEvent id="end"><incoming>f2</incoming></endEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="task"/>
    <sequenceFlow id="f2" sourceRef="task" targetRef="end"/>
  </process>
</definitions>'''


def make_zip(files: dict[str, bytes], *, compression: int = zipfile.ZIP_STORED) -> bytes:
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=compression) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return result.getvalue()


def package_with_bpmn(xml: bytes = BPMN) -> InstancePackage:
    application = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": "application"},
        "spec": {
            "tasks": {"task": "service/test"},
            "features": {},
            "workflow": {"bpmn": {"resource": "workflow", "id": "p1"}},
        },
    }
    candidates = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": "catalog"},
        "spec": {
            "featureBindings": {},
            "candidates": {
                "candidate": {"provides": "service/test", "features": {}}
            }
        },
    }
    optimization = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": "optimization"},
        "spec": {"criteria": []},
    }
    root = {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {"name": "bpmn-conformance"},
        "spec": {
            "profile": "qos-binding/v1",
            "resources": {
                "application": {
                    "application": "application.json",
                    "workflow": "workflow.bpmn",
                },
                "candidateCatalog": {"catalog": "candidates.json"},
                "optimization": {"optimization": "optimization.json"},
            }
        },
    }
    return InstancePackage(
        {
            "instance.json": json.dumps(root).encode(),
            "application.json": json.dumps(application).encode(),
            "candidates.json": json.dumps(candidates).encode(),
            "optimization.json": json.dumps(optimization).encode(),
            "workflow.bpmn": xml,
        }
    )
