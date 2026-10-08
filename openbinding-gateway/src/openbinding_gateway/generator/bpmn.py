"""Serialize a generated structured workflow as executable BPMN 2.0.2."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

from ..v1.package import InstancePackage

NS = "http://www.omg.org/spec/BPMN/20100524/MODEL"
ET.register_namespace("bpmn", NS)


def workflow_as_bpmn(package: InstancePackage, name: str) -> InstancePackage:
    """Change only the workflow notation; retain the generated binding problem."""
    application = package.json("application.json")
    instance = package.json("instance.json")
    routing = package.json("routing.json")
    workflow = application["spec"]["workflow"]
    process_id = f"Process_{name}"
    definitions = ET.Element(f"{{{NS}}}definitions", {
        "id": f"Definitions_{name}", "targetNamespace": "https://openbinding.dev/generated",
    })
    process = ET.SubElement(definitions, f"{{{NS}}}process", {"id": process_id, "isExecutable": "true"})
    counter = 0

    def ident(prefix: str) -> str:
        nonlocal counter
        counter += 1
        return f"{prefix}_{counter}"

    def flow(parent: ET.Element, source: str, target: str, flow_id: str | None = None) -> None:
        ET.SubElement(parent, f"{{{NS}}}sequenceFlow", {
            "id": flow_id or ident("flow"), "sourceRef": source, "targetRef": target,
        })

    def emit(parent: ET.Element, node: dict) -> tuple[str, str] | None:
        if "empty" in node:
            return None
        if "task" in node:
            task_id = node["task"]["id"]
            element_id = ident("task")
            ET.SubElement(parent, f"{{{NS}}}serviceTask", {"id": element_id, "name": task_id})
            return element_id, element_id
        if "sequence" in node:
            parts = [emit(parent, child) for child in node["sequence"]]
            parts = [part for part in parts if part is not None]
            for before, after in zip(parts, parts[1:]):
                flow(parent, before[1], after[0])
            return (parts[0][0], parts[-1][1]) if parts else None
        if "parallel" in node or "exclusive" in node:
            exclusive = "exclusive" in node
            tag = "exclusiveGateway" if exclusive else "parallelGateway"
            split, join = ident("split"), ident("join")
            ET.SubElement(parent, f"{{{NS}}}{tag}", {"id": split})
            ET.SubElement(parent, f"{{{NS}}}{tag}", {"id": join})
            children = node["exclusive"] if exclusive else node["parallel"]
            for child in children:
                branch = child["flow"] if exclusive else child
                result = emit(parent, branch)
                branch_id = child["id"] if exclusive else None
                if result is None:
                    flow(parent, split, join, branch_id)
                else:
                    flow(parent, split, result[0], branch_id)
                    flow(parent, result[1], join)
            return split, join
        if "repeat" in node:
            repeat = node["repeat"]
            if "count" not in repeat:
                raise ValueError("BPMN requires an exact integer repeat count")
            sub_id = ident("subprocess")
            sub = ET.SubElement(parent, f"{{{NS}}}subProcess", {"id": sub_id})
            multi = ET.SubElement(sub, f"{{{NS}}}multiInstanceLoopCharacteristics", {"isSequential": "true"})
            ET.SubElement(multi, f"{{{NS}}}loopCardinality").text = str(repeat["count"])
            emit_scope(sub, repeat["body"])
            return sub_id, sub_id
        raise ValueError("unsupported generated workflow node")

    def emit_scope(parent: ET.Element, node: dict) -> None:
        start, end = ident("start"), ident("end")
        ET.SubElement(parent, f"{{{NS}}}startEvent", {"id": start})
        ET.SubElement(parent, f"{{{NS}}}endEvent", {"id": end})
        result = emit(parent, node)
        if result is None:
            flow(parent, start, end)
        else:
            flow(parent, start, result[0])
            flow(parent, result[1], end)

    emit_scope(process, workflow)
    application["spec"]["workflow"] = {"bpmn": {"resource": "workflow", "id": process_id}}
    instance["spec"]["resources"]["application"]["workflow"] = "workflow.bpmn"
    for entry in routing["spec"].get("entries", []):
        entry["target"]["resource"] = "workflow"
    files = dict(package.files)
    files["instance.json"] = json.dumps(instance, indent=2).encode()
    files["application.json"] = json.dumps(application, indent=2).encode()
    files["routing.json"] = json.dumps(routing, indent=2).encode()
    files["workflow.bpmn"] = ET.tostring(definitions, encoding="utf-8", xml_declaration=True)
    return InstancePackage(files)
