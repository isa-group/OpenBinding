// RETIRED (S5d). The BIM instance workspace became the Workbench screen (`wb-workbench`, /app/:org/:project/workbench), which lives in
// src/pages/Workbench/**: the resource forms moved to Workbench/resourceForms.tsx and formParts.tsx, the state to Workbench/useWorkbench.ts,
// the BPMN editor to Workbench/BpmnModeler.tsx. Nothing routes here any more; this name stays only so old imports keep resolving.
export { Workbench as InstanceWorkspace } from '../Workbench/Workbench';
