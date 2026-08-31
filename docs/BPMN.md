# BPMN workflows in BIM v1

BPMN illustrates BIM's container/sublanguage boundary. The
`qos-binding/v1` Profile offers a compact native workflow, while the installed
`bpmn-workflow/v1` Dialect lets an OMG BPMN 2.0.2 document occupy the
Profile's `application` role. The Dialect recognizes media type
`application/vnd.omg.bpmn+xml` and root QName
`{http://www.omg.org/spec/BPMN/20100524/MODEL}definitions`; its resource
contract represents that external identity as `omg/bpmn/2.0.2` `BPMN`. The
XML is not rewritten as a `bim/v1` JSON resource.

BPMN XML is preserved for editing, while the Profile/Dialect adapter lowers
only a well-defined executable subset: one structured SESE process,
service/local tasks, none start/end events, sequence flow, structured XOR/AND
gateways, and exact static sequential multi-instance activities. Unsupported
elements produce element-local diagnostics; the compiler never guesses or
silently degrades them. BPMN task ids, or task names when ids differ, must
resolve to tasks declared by the Application resource.

Routing data is a separate JSON `RoutingOverlay`. It references branches or
`sequenceFlow` ids and never modifies the BPMN XML. Every XOR has either all
probabilities or none. Supplied probabilities must sum exactly to one; uniform
routing requires an explicit opt-in. A static condition and a probability
cannot coexist on the same flow.

Native `repeat` accepts either an exact integer `count` or a decimal
`expectedCount`. The latter is a deterministic expected invocation multiplier,
not an uncertain QoS distribution. Parallel and exclusive structures use the
metric aggregation declared by the application.

An executable BPMN repeat has this exact shape on an activity:

```xml
<multiInstanceLoopCharacteristics isSequential="true">
  <loopCardinality>3</loopCardinality>
</multiInstanceLoopCharacteristics>
```

`loopCardinality` must be a static, finite, non-negative integer literal and is
lowered to native `repeat.count`. Parallel multi-instance execution, dynamic
cardinality expressions, and graph cycles are rejected. In particular,
`standardLoopCharacteristics` is always rejected, even when it contains
`loopMaximum`: BPMN defines that value as a bound on a condition-controlled
loop, so interpreting it as an exact or expected BIM count would change the
model. `expectedCount` has no BPMN encoding in the executable v1 subset.

The routing overlay targets an exclusive branch id for native JSON or a
`sequenceFlow` id for BPMN. Conditions are permitted only on XOR split flows.
Every XOR is either condition-selected or fully probabilistic; conditions and
probabilities cannot be mixed for one XOR.

The normative external notation remains [OMG BPMN
2.0.2](https://www.omg.org/spec/BPMN/2.0.2/). BIM supplies the role, schema
digest, QName, adapter, and lowering contract; it does not redefine BPMN.
