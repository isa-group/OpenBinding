import { useState } from 'react';
import { Action } from '../../components/ui/Action';
import { FeatureCell } from '../Library/FeatureCell';
import {
  DEFAULT_AST_ASSERTION, IDENTIFIER_PATTERN, candidateFeatures, isRecord, isRegisteredResourceRef, nextIdentifier, optionalNumber, withCandidateFeatures,
  type BimDocument, type BimSpecDocument, type CandidateDocument, type CapabilityDocument, type ConstraintDocument, type InternalReference,
  type MetricDocument, type OptimizationPenaltyDocument, type OptimizationTermDocument, type PlacementCapacityRuleDocument,
  type PlacementGlobalLatencyDocument, type PlacementTransitionDocument, type RoutingEntryDocument, type ScalarMap, type TaskDocument,
} from './bimDocuments';
import {
  ConstraintExpressionEditor, EmptyFormState, FormCard, FormSection, JsonObjectEditor, NumberMapEditor, ReferenceEditor, ReferenceListEditor,
  RenameField,
} from './formParts';

/** One form per kind of document a package holds. They edit the document in place and never see raw JSON unless the person asks for the source. */

interface CommonResourceFormProps {
  document: BimDocument;
  onChange: (next: BimDocument) => void;
  availablePaths: string[];
}

type SpecProps = { spec: BimSpecDocument; updateSpec: (next: BimSpecDocument) => void };

export function CommonResourceForm({ document, onChange, availablePaths }: CommonResourceFormProps) {
  const setName = (name: string) => onChange({ ...document, metadata: { ...document.metadata, name } });
  const setOptionalMetadata = (key: 'description' | 'version', value: string) => {
    const metadata = { ...document.metadata };
    if (value) metadata[key] = value;
    else delete metadata[key];
    onChange({ ...document, metadata });
  };
  return (
    <div className="resource-form">
      <FormSection eyebrow="Document" title="Resource identity" description="Stable metadata used in diagnostics, packages and registry references." className="form-section-identity">
        <div className="form-grid">
          <label>Name<input value={document.metadata?.name || ''} onChange={(event) => setName(event.target.value)} /></label>
          <label>Version<input value={document.metadata?.version || ''} onChange={(event) => setOptionalMetadata('version', event.target.value)} placeholder="Optional…" /></label>
          <label className="form-field-wide">Description<textarea value={document.metadata?.description || ''} onChange={(event) => setOptionalMetadata('description', event.target.value)} placeholder="What role does this resource play?" /></label>
        </div>
      </FormSection>
      <SpecificResourceForm document={document} onChange={onChange} availablePaths={availablePaths} />
    </div>
  );
}

function ConstraintSetForm({ spec, updateSpec }: SpecProps) {
  const constraints = spec.constraints ?? {};
  const updateConstraint = (id: string, next: ConstraintDocument) => updateSpec({ ...spec, constraints: { ...constraints, [id]: next } });
  const removeConstraint = (id: string) => {
    const next = { ...constraints };
    delete next[id];
    updateSpec({ ...spec, constraints: next });
  };
  const addConstraint = (assertion: unknown) => {
    const id = nextIdentifier(constraints, 'constraint');
    updateSpec({ ...spec, constraints: { ...constraints, [id]: { assert: assertion, enforcement: 'hard' } } });
  };

  return <FormSection eyebrow="Policy" title="Constraints" description="Declare hard feasibility gates and soft preferences. Each card keeps its assertion and penalty together." count={Object.keys(constraints).length}>
    {Object.keys(constraints).length === 0 && <EmptyFormState>No constraints. The binding is governed only by candidate eligibility and optimization.</EmptyFormState>}
    <div className="form-card-list constraint-list">{Object.entries(constraints).map(([id, constraint], index) => <FormCard
      key={id}
      eyebrow={`Rule ${String(index + 1).padStart(2, '0')}`}
      title={<code>{id}</code>}
      summary={constraint.enforcement === 'soft' ? 'Preference with an explicit cost when violated.' : 'Required for every feasible solution.'}
      actions={<Action variant="ghost" size="sm" onClick={() => removeConstraint(id)}>Remove constraint</Action>}
    >
      <div className="form-grid form-grid-compact">
        <label>Enforcement<select aria-label={`${id} enforcement`} value={constraint.enforcement} onChange={(event) => {
          const enforcement = event.target.value as ConstraintDocument['enforcement'];
          const next: ConstraintDocument = { ...constraint, enforcement };
          if (event.target.value === 'soft' && next.penalty === undefined) next.penalty = { literal: 1 };
          if (event.target.value === 'hard') delete next.penalty;
          updateConstraint(id, next);
        }}><option value="hard">hard · must hold</option><option value="soft">soft · may be penalized</option></select></label>
      </div>
      <ConstraintExpressionEditor id={id} label="assertion" value={constraint.assert} onChange={(assertion) => updateConstraint(id, { ...constraint, assert: assertion })} />
      {constraint.enforcement === 'soft' && <ConstraintExpressionEditor id={id} label="penalty" value={constraint.penalty ?? { literal: 1 }} onChange={(penalty) => updateConstraint(id, { ...constraint, penalty })} />}
    </FormCard>)}</div>
    <div className="form-add-bar">
      <div><strong>Add a rule</strong><small>CEL is concise; AST is portable and structurally validated.</small></div>
      <div className="inline-actions"><Action variant="secondary" onClick={() => addConstraint('metrics.latency >= 0')}>Add CEL constraint</Action><Action variant="secondary" onClick={() => addConstraint(DEFAULT_AST_ASSERTION)}>Add AST constraint</Action></div>
    </div>
  </FormSection>;
}

function OptimizationForm({ spec, updateSpec }: SpecProps) {
  const terms = spec.terms ?? [];
  const penalties = spec.penalties ?? [];
  const objectiveType: NonNullable<BimSpecDocument['type']> = spec.type || (
    spec.mode === 'pareto' ? terms.length >= 3 ? 'MANY' : terms.length === 2 ? 'MULTI' : 'MONO' : 'MONO'
  );
  const minimumTerms = objectiveType === 'MANY' ? 3 : objectiveType === 'MULTI' ? 2 : spec.mode === 'satisfy' ? 0 : 1;
  const maximumTerms = objectiveType === 'MULTI' ? 3 : Number.POSITIVE_INFINITY;
  const defaultTerm = (): OptimizationTermDocument => ({ metric: { resource: 'application', id: 'latency' }, weight: 1 });
  const withMinimumTerms = (items: OptimizationTermDocument[], minimum: number) => {
    const next = [...items];
    while (next.length < minimum) next.push(defaultTerm());
    return next;
  };
  const updateTerm = (index: number, term: OptimizationTermDocument) => updateSpec({ ...spec, terms: terms.map((current, itemIndex) => itemIndex === index ? term : current) });
  const updatePenalty = (index: number, penalty: OptimizationPenaltyDocument) => updateSpec({ ...spec, penalties: penalties.map((current, itemIndex) => itemIndex === index ? penalty : current) });
  const updateMode = (mode: string) => {
    const next: BimSpecDocument = { ...spec, mode: mode as BimSpecDocument['mode'] };
    if (mode === 'satisfy') {
      next.type = 'MONO';
      next.terms = [];
    } else next.terms = withMinimumTerms(terms, objectiveType === 'MANY' ? 3 : objectiveType === 'MULTI' ? 2 : 1);
    updateSpec(next);
  };
  const updateType = (type: NonNullable<BimSpecDocument['type']>) => {
    const next: BimSpecDocument = { ...spec, type };
    const minimum = type === 'MANY' ? 3 : type === 'MULTI' ? 2 : spec.mode === 'satisfy' ? 0 : 1;
    if (type !== 'MONO' && next.mode === 'satisfy') next.mode = 'pareto';
    next.terms = withMinimumTerms(terms, minimum);
    if (type === 'MULTI') next.terms = next.terms.slice(0, 3);
    updateSpec(next);
  };

  return <>
    <FormSection eyebrow="Contract" title="Optimization shape" description="Objective type controls cardinality; strategy controls how those objectives are compared.">
      <div className="objective-contract">
        <div className="form-grid">
          <label>Objective type<select aria-label="Objective type" value={objectiveType} onChange={(event) => updateType(event.target.value as NonNullable<BimSpecDocument['type']>)}><option value="MONO">MONO · 1 or more utility terms</option><option value="MULTI">MULTI · 2 to 3 terms</option><option value="MANY">MANY · 3 or more terms</option></select></label>
          <label>Strategy<select aria-label="Strategy" value={spec.mode || 'satisfy'} onChange={(event) => updateMode(event.target.value)}><option value="satisfy">satisfy · feasibility only</option><option value="weighted">weighted sum</option><option value="lexicographic">lexicographic order</option><option value="pareto">Pareto frontier</option></select></label>
        </div>
        <div className="objective-readout" aria-live="polite">
          <strong>{objectiveType}</strong>
          <span>{terms.length} objective{terms.length === 1 ? '' : 's'}</span>
          <small>{spec.mode === 'satisfy' ? 'Feasibility mode uses no terms.' : objectiveType === 'MULTI' ? 'Valid range: 2–3.' : objectiveType === 'MANY' ? 'Valid range: 3 or more.' : 'Valid range: 1 or more.'}</small>
        </div>
      </div>
    </FormSection>

    <FormSection eyebrow="Utility" title="Objective terms" description="Reference application metrics, then optionally override direction, relative weight and normalization." count={terms.length}>
      {terms.length === 0 && <EmptyFormState>Satisfy mode has no objective terms. Choose another strategy to optimize metrics.</EmptyFormState>}
      <div className="form-card-list">{terms.map((term, index) => <FormCard
        key={index}
        eyebrow={`Objective ${String(index + 1).padStart(2, '0')}`}
        title={<>{term.metric?.id || 'Unnamed metric'} <span className="form-title-muted">from {term.metric?.resource || 'resource'}</span></>}
        actions={<Action variant="ghost" size="sm" disabled={terms.length <= minimumTerms} onClick={() => updateSpec({ ...spec, terms: terms.filter((_, itemIndex) => itemIndex !== index) })}>Remove term</Action>}
      >
        <div className="form-grid">
          <label>Metric resource<input aria-label={`Term ${index + 1} metric resource`} value={term.metric?.resource || ''} onChange={(event) => updateTerm(index, { ...term, metric: { ...term.metric, resource: event.target.value } })} /></label>
          <label>Metric id<input aria-label={`Term ${index + 1} metric id`} value={term.metric?.id || ''} onChange={(event) => updateTerm(index, { ...term, metric: { ...term.metric, id: event.target.value } })} /></label>
          <label>Direction<select aria-label={`Term ${index + 1} direction`} value={term.direction || ''} onChange={(event) => {
            const next = { ...term };
            if (event.target.value) next.direction = event.target.value as OptimizationTermDocument['direction'];
            else delete next.direction;
            updateTerm(index, next);
          }}><option value="">metric default</option><option value="minimize">minimize</option><option value="maximize">maximize</option></select></label>
          <label>Weight<input aria-label={`Term ${index + 1} weight`} type="number" min="0" step="any" value={term.weight ?? ''} onChange={(event) => {
            const next = { ...term };
            const weight = optionalNumber(event.target.value);
            if (weight !== undefined && weight > 0) next.weight = weight;
            else delete next.weight;
            updateTerm(index, next);
          }} placeholder="relative" /></label>
        </div>
        <label className="check-field"><input aria-label={`Term ${index + 1} normalize`} type="checkbox" checked={Boolean(term.normalize)} onChange={(event) => {
          const next = { ...term };
          if (event.target.checked) next.normalize = { min: 0, max: 1, clamp: false };
          else delete next.normalize;
          updateTerm(index, next);
        }} /> Normalize this metric explicitly</label>
        {term.normalize && <div className="form-grid nested-fields">
          <label>Minimum<input aria-label={`Term ${index + 1} normalization minimum`} type="number" step="any" value={term.normalize.min} onChange={(event) => {
            const minimum = optionalNumber(event.target.value);
            if (minimum !== undefined) updateTerm(index, { ...term, normalize: { min: minimum, max: term.normalize!.max, clamp: term.normalize!.clamp } });
          }} /></label>
          <label>Maximum<input aria-label={`Term ${index + 1} normalization maximum`} type="number" step="any" value={term.normalize.max} onChange={(event) => {
            const maximum = optionalNumber(event.target.value);
            if (maximum !== undefined) updateTerm(index, { ...term, normalize: { min: term.normalize!.min, max: maximum, clamp: term.normalize!.clamp } });
          }} /></label>
          <label className="check-field"><input aria-label={`Term ${index + 1} normalization clamp`} type="checkbox" checked={Boolean(term.normalize.clamp)} onChange={(event) => updateTerm(index, { ...term, normalize: { min: term.normalize!.min, max: term.normalize!.max, clamp: event.target.checked } })} /> Clamp outside values</label>
        </div>}
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Expand the objective</strong><small>{objectiveType === 'MULTI' ? `${Math.max(0, 3 - terms.length)} slot${3 - terms.length === 1 ? '' : 's'} remaining.` : 'Add another metric utility term.'}</small></div><Action variant="secondary" disabled={spec.mode === 'satisfy' || terms.length >= maximumTerms} onClick={() => updateSpec({ ...spec, terms: [...terms, defaultTerm()] })}>Add objective term</Action></div>
    </FormSection>

    <FormSection eyebrow="Policy cost" title="Soft-constraint penalties" description="Optional weights link soft constraint violations into the optimization utility." count={penalties.length}>
      {penalties.length === 0 && <EmptyFormState>No explicit penalty weights. Constraint defaults remain in effect.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{penalties.map((penalty, index) => <FormCard
        key={index}
        eyebrow={`Penalty ${String(index + 1).padStart(2, '0')}`}
        title={<code>{penalty.constraint?.id || 'constraint'}</code>}
        actions={<Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, penalties: penalties.filter((_, itemIndex) => itemIndex !== index) })}>Remove penalty</Action>}
      >
        <div className="form-grid">
          <label>Constraint resource<input aria-label={`Penalty ${index + 1} constraint resource`} value={penalty.constraint?.resource || ''} onChange={(event) => updatePenalty(index, { ...penalty, constraint: { ...penalty.constraint, resource: event.target.value } })} /></label>
          <label>Constraint id<input aria-label={`Penalty ${index + 1} constraint id`} value={penalty.constraint?.id || ''} onChange={(event) => updatePenalty(index, { ...penalty, constraint: { ...penalty.constraint, id: event.target.value } })} /></label>
          <label>Weight<input aria-label={`Penalty ${index + 1} weight`} type="number" min="0" step="any" value={penalty.weight ?? ''} onChange={(event) => {
            const next = { ...penalty };
            const weight = optionalNumber(event.target.value);
            if (weight !== undefined && weight > 0) next.weight = weight;
            else delete next.weight;
            updatePenalty(index, next);
          }} placeholder="relative" /></label>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Link a soft rule</strong><small>Use the resource id and constraint id declared in the package.</small></div><Action variant="secondary" onClick={() => updateSpec({ ...spec, penalties: [...penalties, { constraint: { resource: 'constraints', id: 'constraint1' }, weight: 1 }] })}>Add penalty</Action></div>
    </FormSection>
  </>;
}

function InstanceForm({ spec, updateSpec, availablePaths }: SpecProps & { availablePaths: string[] }) {
  const resources = isRecord(spec.resources) ? spec.resources : {};
  const entries = Object.entries(resources).flatMap(([role, group]) => isRecord(group)
    ? Object.entries(group).map(([id, target]) => ({ role, id, target }))
    : []);
  const [newRole, setNewRole] = useState('constraintSet');
  const [newId, setNewId] = useState('resource1');
  const [chosenPath, setNewPath] = useState(availablePaths[0] || 'resource.json');
  // A file that left the package cannot stay chosen: the first one that is still there takes its place.
  const newPath = availablePaths.includes(chosenPath) ? chosenPath : availablePaths[0] ?? chosenPath;

  const replaceEntry = (role: string, id: string, nextRole: string, nextId: string, target: unknown) => {
    if (!IDENTIFIER_PATTERN.test(nextRole) || !IDENTIFIER_PATTERN.test(nextId)) return;
    const nextResources: Record<string, Record<string, unknown>> = {};
    Object.entries(resources).forEach(([groupRole, group]) => {
      if (isRecord(group)) nextResources[groupRole] = { ...group };
    });
    if ((nextRole !== role || nextId !== id) && nextResources[nextRole]?.[nextId] !== undefined) return;
    delete nextResources[role]?.[id];
    if (nextResources[role] && Object.keys(nextResources[role]).length === 0) delete nextResources[role];
    nextResources[nextRole] = { ...(nextResources[nextRole] || {}), [nextId]: target };
    updateSpec({ ...spec, resources: nextResources });
  };

  const removeEntry = (role: string, id: string) => {
    if (entries.length <= 1) return;
    const nextResources: Record<string, Record<string, unknown>> = {};
    Object.entries(resources).forEach(([groupRole, group]) => {
      if (isRecord(group)) nextResources[groupRole] = { ...group };
    });
    delete nextResources[role]?.[id];
    if (Object.keys(nextResources[role] || {}).length === 0) delete nextResources[role];
    updateSpec({ ...spec, resources: nextResources });
  };

  const addLocalEntry = () => {
    if (!IDENTIFIER_PATTERN.test(newRole) || !IDENTIFIER_PATTERN.test(newId) || !newPath || isRecord(resources[newRole]) && newId in resources[newRole]) return;
    updateSpec({ ...spec, resources: { ...resources, [newRole]: { ...(isRecord(resources[newRole]) ? resources[newRole] : {}), [newId]: newPath } } });
    setNewId(`resource${entries.length + 2}`);
  };

  return <>
    <FormSection eyebrow="Language" title="Profile" description="The profile defines the core vocabulary and compatible dialect set for this package.">
      <div className="form-grid"><label>Profile identifier<input aria-label="Profile" value={spec.profile || ''} pattern="[A-Za-z][A-Za-z0-9_.-]*/v[1-9][0-9]*" onChange={(event) => updateSpec({ ...spec, profile: event.target.value })} /></label></div>
    </FormSection>
    <FormSection eyebrow="Package graph" title="Resource index" description="Every logical id resolves either to a file in this package or to an immutable registry object." count={entries.length}>
    <div className="form-card-list">{entries.map(({ role, id, target }, index) => {
      const local = typeof target === 'string';
      const registered = isRegisteredResourceRef(target) ? target : { namespace: '', name: '', version: '', digest: '' };
      const localOptions = local && !availablePaths.includes(target) ? [target, ...availablePaths] : availablePaths;
      return <FormCard
        key={`${role}/${id}`}
        eyebrow={`Reference ${String(index + 1).padStart(2, '0')} · ${role}`}
        title={<code>{id}</code>}
        summary={local ? `Local package file · ${target}` : `Registered · ${registered.namespace}/${registered.name}@${registered.version}`}
        actions={<Action variant="ghost" size="sm" disabled={entries.length <= 1} onClick={() => removeEntry(role, id)}>Remove reference</Action>}
      >
        <div className="form-grid form-grid-compact">
          <RenameField
            label="Role"
            ariaLabel={`${role}/${id} role`}
            value={role}
            validate={(nextRole) => nextRole !== role && isRecord(resources[nextRole]) && resources[nextRole][id] !== undefined
              ? `The ${nextRole}/${id} reference already exists.`
              : undefined}
            onCommit={(nextRole) => replaceEntry(role, id, nextRole, id, target)}
          />
          <RenameField
            label="Resource id"
            ariaLabel={`${role}/${id} resource id`}
            value={id}
            validate={(nextId) => nextId !== id && isRecord(resources[role]) && resources[role][nextId] !== undefined
              ? `The ${role}/${nextId} reference already exists.`
              : undefined}
            onCommit={(nextId) => replaceEntry(role, id, role, nextId, target)}
          />
          <label>Reference type<select aria-label={`${role}/${id} reference type`} value={local ? 'local' : 'registered'} onChange={(event) => replaceEntry(role, id, role, id, event.target.value === 'local'
            ? availablePaths[0] || 'resource.json'
            : { namespace: 'example', name: id, version: '1.0.0', digest: `sha256-${'0'.repeat(64)}` })}><option value="local">package file</option><option value="registered">registered resource</option></select></label>
        </div>
        {local ? <div className="form-grid nested-fields"><label>Package file<select aria-label={`${role}/${id} package file`} value={target} onChange={(event) => replaceEntry(role, id, role, id, event.target.value)}>{localOptions.map((path) => <option value={path} key={path}>{path}</option>)}</select></label></div> : <div className="form-grid nested-fields">
          <label>Namespace<input aria-label={`${role}/${id} namespace`} value={registered.namespace} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, namespace: event.target.value })} /></label>
          <label>Name<input aria-label={`${role}/${id} registered name`} value={registered.name} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, name: event.target.value })} /></label>
          <label>Version<input aria-label={`${role}/${id} registered version`} value={registered.version} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, version: event.target.value })} /></label>
          <label className="form-field-wide">SHA-256 digest<input aria-label={`${role}/${id} digest`} value={registered.versionDigest || registered.digest || ''} onChange={(event) => replaceEntry(role, id, role, id, { ...registered, [registered.versionDigest ? 'versionDigest' : 'digest']: event.target.value })} /></label>
        </div>}
      </FormCard>;
    })}</div>
    <div className="form-add-bar form-add-bar-fields">
      <div><strong>Add package reference</strong><small>Choose a semantic role, stable id and an existing file.</small></div>
      <div className="form-grid">
        <label>Role<input aria-label="New resource role" value={newRole} pattern="[A-Za-z][A-Za-z0-9_.-]*" onChange={(event) => setNewRole(event.target.value)} /></label>
        <label>Resource id<input aria-label="New resource id" value={newId} pattern="[A-Za-z][A-Za-z0-9_.-]*" onChange={(event) => setNewId(event.target.value)} /></label>
        <label>Package file<select aria-label="New resource package file" value={newPath} onChange={(event) => setNewPath(event.target.value)}>{availablePaths.map((path) => <option value={path} key={path}>{path}</option>)}</select></label>
      </div>
      <Action variant="secondary" disabled={!availablePaths.length || !IDENTIFIER_PATTERN.test(newRole) || !IDENTIFIER_PATTERN.test(newId) || Boolean(isRecord(resources[newRole]) && resources[newRole][newId] !== undefined)} onClick={addLocalEntry}>Add local reference</Action>
    </div>
    </FormSection>
  </>;
}

function ApplicationForm({ spec, updateSpec }: SpecProps) {
  const tasks = spec.tasks || {};
  const metrics = spec.metrics || {};
  const [newMetricId, setNewMetricId] = useState('metric');
  const updateTask = (id: string, next: TaskDocument) => updateSpec({ ...spec, tasks: { ...tasks, [id]: next } });
  const updateMetric = (id: string, next: MetricDocument) => updateSpec({ ...spec, metrics: { ...metrics, [id]: next } });
  const removeTask = (id: string) => {
    if (Object.keys(tasks).length <= 1) return;
    const next = { ...tasks };
    delete next[id];
    updateSpec({ ...spec, tasks: next });
  };
  const removeMetric = (id: string) => {
    const next = { ...metrics };
    delete next[id];
    updateSpec({ ...spec, metrics: next });
  };
  const setMetricField = (id: string, metric: MetricDocument, key: keyof MetricDocument, value: unknown) => {
    const next = { ...metric };
    if (value === '' || value === undefined) delete next[key];
    else next[key] = value as never;
    updateMetric(id, next);
  };

  return <>
    <FormSection eyebrow="Composition" title="Tasks" description="Service tasks select candidates by capability; local tasks stay inside the workflow and require no binding." count={Object.keys(tasks).length}>
    <div className="form-card-list">
      {Object.entries(tasks).map(([id, task]) => {
        const taskObject = typeof task === 'string' ? {} : task;
        const kind = typeof task === 'string' ? 'service' : task.kind || 'service';
        const requirement = typeof task === 'string' ? task : task.requires;
        const capability = typeof requirement === 'string' ? requirement : requirement?.type || '';
        const predicate = typeof requirement === 'object' ? requirement.predicate : undefined;
        return <FormCard
          key={id}
          eyebrow={kind === 'local' ? 'Local step' : 'Bound service'}
          title={<code>{id}</code>}
          summary={kind === 'local' ? 'Executed without candidate selection.' : `Requires ${capability || 'an unspecified capability'}.`}
          actions={<Action variant="ghost" size="sm" disabled={Object.keys(tasks).length <= 1} onClick={() => removeTask(id)}>Remove task</Action>}
        >
          <div className="form-grid form-grid-compact">
            <label>Kind<select aria-label={`${id} kind`} value={kind} onChange={(event) => {
              if (event.target.value === 'local') {
                const next = { ...taskObject, kind: 'local' as const };
                delete next.requires;
                updateTask(id, next);
              } else {
                updateTask(id, { ...taskObject, kind: 'service', requires: capability || 'service/new' });
              }
            }}><option value="service">service</option><option value="local">local</option></select></label>
            <label>Capability type<input disabled={kind === 'local'} aria-label={`${id} capability`} value={capability} onChange={(event) => {
              const type = event.target.value;
              if (predicate === undefined && typeof task === 'string') updateTask(id, type);
              else updateTask(id, {
                ...taskObject,
                kind: 'service',
                requires: predicate === undefined ? type : { type, predicate },
              });
            }} placeholder="capability type" /></label>
          </div>
          {kind === 'service' && <>
            <label className="check-field"><input aria-label={`${id} predicate enabled`} type="checkbox" checked={predicate !== undefined} onChange={(event) => {
              updateTask(id, {
                ...taskObject,
                kind: 'service',
                requires: event.target.checked
                  ? { type: capability || 'service/new', predicate: 'candidate.properties.enabled == true' }
                  : capability || 'service/new',
              });
            }} /> Filter candidates with a typed predicate</label>
            {predicate !== undefined && <ConstraintExpressionEditor id={id} label="predicate" value={predicate} onChange={(nextPredicate) => updateTask(id, {
              ...taskObject,
              kind: 'service',
              requires: { type: capability || 'service/new', predicate: nextPredicate },
            })} />}
          </>}
        </FormCard>;
      })}
    </div>
    <div className="form-add-bar"><div><strong>Add composition task</strong><small>The new task starts as a bindable service requirement.</small></div><Action variant="secondary" onClick={() => {
      const id = nextIdentifier(tasks, 'task');
      updateSpec({ ...spec, tasks: { ...tasks, [id]: `service/${id}` } });
    }}>Add task</Action></div>
    </FormSection>

    <FormSection eyebrow="Quality model" title="Metrics" description="Define units and aggregation once; catalogs provide candidate values through metric bindings." count={Object.keys(metrics).length}>
    {Object.keys(metrics).length === 0 && <EmptyFormState>No quality metrics are declared.</EmptyFormState>}
    <div className="form-card-list">
      {Object.entries(metrics).map(([id, metric]) => {
        const domain = typeof metric.domain === 'string' ? metric.domain : isRecord(metric.domain) ? 'custom' : '';
        const aggregation = typeof metric.aggregation === 'string' ? metric.aggregation : isRecord(metric.aggregation) ? 'custom' : '';
        return <FormCard
          key={id}
          eyebrow={`${metric.direction || 'profile direction'} · ${metric.scope || 'profile scope'}`}
          title={<code>{id}</code>}
          summary={`${metric.unit || 'unit not set'} · ${aggregation || 'aggregation not set'}`}
          actions={<Action variant="ghost" size="sm" onClick={() => removeMetric(id)}>Remove metric</Action>}
        >
          <div className="form-grid">
            <label>Unit<input aria-label={`${id} unit`} value={metric.unit || ''} onChange={(event) => setMetricField(id, metric, 'unit', event.target.value)} placeholder="For example, ms…" /></label>
            <label>Direction<select aria-label={`${id} direction`} value={metric.direction || ''} onChange={(event) => setMetricField(id, metric, 'direction', event.target.value)}><option value="">profile default</option><option value="minimize">minimize</option><option value="maximize">maximize</option></select></label>
            <label>Scope<select aria-label={`${id} scope`} value={metric.scope || ''} onChange={(event) => setMetricField(id, metric, 'scope', event.target.value)}><option value="">profile default</option><option value="invocation">per invocation</option><option value="selectedCandidate">once per selected candidate</option></select></label>
            <label>Domain<select aria-label={`${id} domain`} value={domain} onChange={(event) => {
              if (event.target.value !== 'custom') setMetricField(id, metric, 'domain', event.target.value);
            }}><option value="">unspecified</option><option value="real">real</option><option value="integer">integer</option><option value="ratio">ratio</option>{domain === 'custom' && <option value="custom">custom (view source)</option>}</select></label>
            <label>Aggregation<select aria-label={`${id} aggregation`} value={aggregation} onChange={(event) => {
              if (event.target.value !== 'custom') setMetricField(id, metric, 'aggregation', event.target.value);
            }}><option value="">unspecified</option><option value="sum">sum</option><option value="product">product</option><option value="min">minimum</option><option value="max">maximum</option>{aggregation === 'custom' && <option value="custom">custom (view source)</option>}</select></label>
            <label>Neutral value<input aria-label={`${id} neutral`} type="number" step="any" value={metric.neutral ?? ''} onChange={(event) => setMetricField(id, metric, 'neutral', optionalNumber(event.target.value))} /></label>
          </div>
        </FormCard>;
      })}
    </div>
    <div className="form-add-bar form-add-bar-fields">
      <div><strong>Add quality metric</strong><small>Identifiers become stable references in catalogs, constraints and objectives.</small></div>
      <div className="form-grid"><label>New metric id<input aria-label="New metric id" value={newMetricId} pattern="[A-Za-z][A-Za-z0-9_.-]*" onChange={(event) => setNewMetricId(event.target.value)} /></label></div>
      <Action variant="secondary" disabled={!IDENTIFIER_PATTERN.test(newMetricId) || Boolean(metrics[newMetricId])} onClick={() => {
      updateSpec({
        ...spec,
        metrics: {
          ...metrics,
          [newMetricId]: { type: 'number', unit: '1', domain: 'real', direction: 'minimize', scope: 'invocation', aggregation: 'sum' },
        },
      });
      setNewMetricId(nextIdentifier({ ...metrics, [newMetricId]: {} }, 'metric'));
      }}>Add metric</Action>
    </div>
    </FormSection>

    <FormSection eyebrow="Control flow" title="Workflow" description="The workflow orders task invocations and feeds metric aggregation.">
      {isRecord(spec.workflow) && isRecord(spec.workflow.bpmn)
        ? <ReferenceEditor id="application workflow" label="BPMN process" value={spec.workflow.bpmn as InternalReference} onChange={(bpmn) => updateSpec({ ...spec, workflow: { ...spec.workflow as Record<string, unknown>, bpmn } })} />
        : <div className="workflow-form-summary"><strong>Structured BIM workflow</strong><p>Edit its nested sequence, parallel, exclusive and repeat nodes in the Workflow JSON view under View source.</p></div>}
    </FormSection>
  </>;
}

function capabilityItems(value: CandidateDocument['provides']): CapabilityDocument[] {
  if (Array.isArray(value)) return value.length ? value : ['service/new'];
  return value === undefined ? ['service/new'] : [value];
}

function capabilityType(value: CapabilityDocument): string {
  return typeof value === 'string' ? value : value.type || '';
}

function CandidateCatalogForm({ spec, updateSpec }: SpecProps) {
  const candidates = spec.candidates || {};
  const metricBindings = spec.metricBindings || {};
  const [newMetricAlias, setNewMetricAlias] = useState('metric');
  const updateCandidate = (id: string, next: CandidateDocument) => updateSpec({ ...spec, candidates: { ...candidates, [id]: next } });
  const updateBinding = (alias: string, next: InternalReference) => updateSpec({ ...spec, metricBindings: { ...metricBindings, [alias]: next } });

  const replaceMetricAlias = (alias: string, nextAlias: string) => {
    if (nextAlias === alias || !IDENTIFIER_PATTERN.test(nextAlias) || metricBindings[nextAlias]) return;
    const nextBindings = Object.fromEntries(Object.entries(metricBindings).map(([key, value]) => [key === alias ? nextAlias : key, value]));
    const nextCandidates = Object.fromEntries(Object.entries(candidates).map(([id, candidate]) => {
      const features = candidateFeatures(candidate);
      if (alias in features) {
        features[nextAlias] = features[alias];
        delete features[alias];
      }
      return [id, withCandidateFeatures(candidate, features)];
    }));
    updateSpec({ ...spec, metricBindings: nextBindings, candidates: nextCandidates });
  };

  const removeMetricBinding = (alias: string) => {
    const nextBindings = { ...metricBindings };
    delete nextBindings[alias];
    const nextCandidates = Object.fromEntries(Object.entries(candidates).map(([id, candidate]) => {
      const features = candidateFeatures(candidate);
      delete features[alias];
      return [id, withCandidateFeatures(candidate, features)];
    }));
    updateSpec({ ...spec, metricBindings: nextBindings, candidates: nextCandidates });
  };

  return <>
    <FormSection eyebrow="Metric bridge" title="Metric bindings" description="Aliases connect every candidate QoS column to a metric declared by the Application." count={Object.keys(metricBindings).length}>
    {Object.keys(metricBindings).length === 0 && <EmptyFormState>No metric aliases. Candidates can still be selected, but they provide no QoS values.</EmptyFormState>}
    <div className="form-card-list form-card-list-compact">{Object.entries(metricBindings).map(([alias, reference], index) => <FormCard
      key={alias}
      eyebrow={`Binding ${String(index + 1).padStart(2, '0')}`}
      title={<code>{alias}</code>}
      summary={`${reference.resource || 'resource'}/${reference.id || 'metric'}`}
      actions={<Action variant="ghost" size="sm" onClick={() => removeMetricBinding(alias)}>Remove metric binding</Action>}
    >
      <div className="form-grid">
        <RenameField
          label="Alias"
          ariaLabel={`${alias} metric alias`}
          value={alias}
          validate={(nextAlias) => nextAlias !== alias && nextAlias in metricBindings
            ? `The ${nextAlias} metric alias already exists.`
            : undefined}
          onCommit={(nextAlias) => replaceMetricAlias(alias, nextAlias)}
        />
        <label>Metric resource<input aria-label={`${alias} metric resource`} value={reference.resource || ''} onChange={(event) => updateBinding(alias, { ...reference, resource: event.target.value })} /></label>
        <label>Metric id<input aria-label={`${alias} metric id`} value={reference.id || ''} onChange={(event) => updateBinding(alias, { ...reference, id: event.target.value })} /></label>
      </div>
    </FormCard>)}</div>
    <div className="form-add-bar form-add-bar-fields">
      <div><strong>Add metric alias</strong><small>The alias becomes a QoS column on every candidate card.</small></div>
      <div className="form-grid"><label>New metric alias<input aria-label="New metric alias" value={newMetricAlias} onChange={(event) => setNewMetricAlias(event.target.value)} /></label></div>
      <Action variant="secondary" disabled={!IDENTIFIER_PATTERN.test(newMetricAlias) || Boolean(metricBindings[newMetricAlias])} onClick={() => {
        updateSpec({ ...spec, metricBindings: { ...metricBindings, [newMetricAlias]: { resource: 'application', id: newMetricAlias } } });
        setNewMetricAlias(nextIdentifier({ ...metricBindings, [newMetricAlias]: {} }, 'metric'));
      }}>Add metric binding</Action>
    </div>
    </FormSection>

    <FormSection eyebrow="Supply" title="Candidates" description="Capabilities determine eligibility; QoS values let engines compare the eligible implementations." count={Object.keys(candidates).length}>
    {Object.keys(candidates).length === 0 && <EmptyFormState>No candidate implementations are available.</EmptyFormState>}
    <div className="form-card-list candidate-list">{Object.entries(candidates).map(([id, candidate], candidateIndex) => {
      const capabilities = capabilityItems(candidate.provides);
      const aliases = Array.from(new Set([...Object.keys(metricBindings), ...Object.keys(candidateFeatures(candidate))]));
      const setCapabilities = (next: CapabilityDocument[]) => updateCandidate(id, {
        ...candidate,
        provides: Array.isArray(candidate.provides) || next.length > 1 ? next : next[0],
      });
      return <FormCard
        key={id}
        eyebrow={`Candidate ${String(candidateIndex + 1).padStart(2, '0')} · ${capabilities.length} capabilit${capabilities.length === 1 ? 'y' : 'ies'}`}
        title={<code>{id}</code>}
        summary={aliases.length ? `${aliases.length} QoS field${aliases.length === 1 ? '' : 's'} available.` : 'No QoS fields are bound.'}
        actions={<Action variant="ghost" size="sm" disabled={Object.keys(candidates).length <= 1} onClick={() => {
          const next = { ...candidates };
          delete next[id];
          updateSpec({ ...spec, candidates: next });
        }}>Remove candidate</Action>}
      >
        <div className="form-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Eligibility</span><h5>Capabilities</h5></div><Action variant="secondary" size="sm" onClick={() => setCapabilities([...capabilities, 'service/new'])}>Add capability</Action></div>
          <div className="nested-card-list">{capabilities.map((capability, index) => <div className="nested-card" key={index}>
            <div className="form-grid form-grid-compact"><label>Capability type<input aria-label={`${id} capability ${index + 1} type`} value={capabilityType(capability)} onChange={(event) => {
              const next = [...capabilities];
              next[index] = typeof capability === 'string' ? event.target.value : { ...capability, type: event.target.value };
              setCapabilities(next);
            }} /></label></div>
            <JsonObjectEditor id={`${id} capability ${index + 1}`} label="properties" value={typeof capability === 'string' ? {} : capability.properties} onChange={(properties) => {
              const next = [...capabilities];
              next[index] = { type: capabilityType(capability), properties: properties as ScalarMap };
              setCapabilities(next);
            }} />
            <Action variant="ghost" size="sm" disabled={capabilities.length <= 1} onClick={() => setCapabilities(capabilities.filter((_, itemIndex) => itemIndex !== index))}>Remove capability</Action>
          </div>)}</div>
        </div>
        <div className="form-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Ownership</span><h5>Provider</h5></div></div>
          <div className="form-grid">
          <label>Provider resource<input aria-label={`${id} provider resource`} value={candidate.provider?.resource || ''} onChange={(event) => {
            const next = { ...candidate };
            const resource = event.target.value;
            if (resource || candidate.provider?.id) next.provider = { resource, id: candidate.provider?.id || '' };
            else delete next.provider;
            updateCandidate(id, next);
          }} /></label>
          <label>Provider id<input aria-label={`${id} provider id`} value={candidate.provider?.id || ''} onChange={(event) => {
            const next = { ...candidate };
            const providerId = event.target.value;
            if (providerId || candidate.provider?.resource) next.provider = { resource: candidate.provider?.resource || '', id: providerId };
            else delete next.provider;
            updateCandidate(id, next);
          }} /></label>
          </div>
          <JsonObjectEditor id={id} label="properties" value={candidate.properties} onChange={(properties) => updateCandidate(id, { ...candidate, properties: properties as ScalarMap })} />
        </div>
        <div className="form-subgroup qos-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Quality values</span><h5>QoS matrix</h5></div></div>
          {aliases.length === 0 && <EmptyFormState>Add a metric binding to expose QoS inputs.</EmptyFormState>}
          <div className="form-grid">{aliases.map((alias) => <div className="qos-field" key={alias}>
            <span className="qos-name">{alias}</span>
            <FeatureCell
              feature={alias}
              candidate={id}
              value={candidateFeatures(candidate)[alias]}
              onChange={(next) => {
                const features = candidateFeatures(candidate);
                if (next === null) delete features[alias];
                else features[alias] = next;
                updateCandidate(id, withCandidateFeatures(candidate, features));
              }}
              valueInput={({ value, onChange: change }) => (
                <input aria-label={`${id} QoS ${alias}`} type="number" step="any" value={value ?? ''} onChange={(event) => {
                  const typed = optionalNumber(event.target.value);
                  change(typed === undefined ? null : typed);
                }} />
              )}
            />
          </div>)}</div>
        </div>
      </FormCard>;
    })}</div>
    <div className="form-add-bar"><div><strong>Add implementation</strong><small>Create a candidate, then declare its capabilities and QoS values.</small></div><Action variant="secondary" onClick={() => {
      const id = nextIdentifier(candidates, 'candidate');
      updateSpec({ ...spec, candidates: { ...candidates, [id]: { provides: 'service/new', features: {} } } });
    }}>Add candidate</Action></div>
    </FormSection>
  </>;
}

function RoutingOverlayForm({ spec, updateSpec }: SpecProps) {
  const explicit = Array.isArray(spec.entries);
  const entries = spec.entries || [];
  const total = entries.reduce((sum, entry) => sum + (typeof entry.probability === 'number' ? entry.probability : 0), 0);
  const balanced = Math.abs(total - 1) < 1e-9;
  const updateEntry = (index: number, next: RoutingEntryDocument) => updateSpec({ ...spec, entries: entries.map((entry, itemIndex) => itemIndex === index ? next : entry) });
  const setMode = (mode: 'uniform' | 'explicit') => {
    const next = { ...spec };
    if (mode === 'uniform') {
      next.uniform = true;
      delete next.entries;
    } else {
      delete next.uniform;
      next.entries = entries.length ? entries : [
        { target: { resource: 'application', id: 'branch1' }, probability: 0.5 },
        { target: { resource: 'application', id: 'branch2' }, probability: 0.5 },
      ];
    }
    updateSpec(next);
  };

  return <>
    <FormSection eyebrow="Control-flow weights" title="Routing policy" description="Use uniform branch weights, or list the exact probability for each exclusive branch.">
      <div className="routing-mode-grid">
        <label className={`choice-card ${!explicit ? 'is-selected' : ''}`}><input type="radio" name="routing-mode" value="uniform" checked={!explicit} onChange={() => setMode('uniform')} /><span><strong>Uniform</strong><small>The compiler distributes probability equally inside every XOR.</small></span></label>
        <label className={`choice-card ${explicit ? 'is-selected' : ''}`}><input type="radio" name="routing-mode" value="explicit" checked={explicit} onChange={() => setMode('explicit')} /><span><strong>Explicit ledger</strong><small>Every routed branch receives a declared decimal probability.</small></span></label>
      </div>
    </FormSection>
    {explicit && <FormSection eyebrow="Probability ledger" title="Branch entries" description="Targets are exclusive branch ids (or BPMN sequenceFlow ids). Validate verifies every XOR independently." count={entries.length}>
      <div className={`routing-balance ${balanced ? 'is-balanced' : 'is-open'}`}>
        <div><span>Listed total</span><strong>Σ {total.toFixed(3)}</strong></div>
        <p>{balanced ? 'The listed entries form one complete probability distribution.' : 'This total is not one. That can be valid only when entries span multiple XOR groups; Validate checks each group.'}</p>
      </div>
      <div className="form-card-list form-card-list-compact">{entries.map((entry, index) => <FormCard
        key={index}
        eyebrow={`Route ${String(index + 1).padStart(2, '0')}`}
        title={<code>{entry.target?.id || 'branch'}</code>}
        summary={`${((entry.probability || 0) * 100).toFixed(1)}% of this branch group`}
        actions={<Action variant="ghost" size="sm" disabled={entries.length <= 1} onClick={() => updateSpec({ ...spec, entries: entries.filter((_, itemIndex) => itemIndex !== index) })}>Remove route</Action>}
      >
        <div className="form-grid">
          <label>Target resource<input aria-label={`Route ${index + 1} target resource`} value={entry.target?.resource || ''} onChange={(event) => updateEntry(index, { ...entry, target: { ...entry.target, resource: event.target.value } })} /></label>
          <label>Target branch<input aria-label={`Route ${index + 1} target id`} value={entry.target?.id || ''} onChange={(event) => updateEntry(index, { ...entry, target: { ...entry.target, id: event.target.value } })} /></label>
          <label>Probability<input aria-label={`Route ${index + 1} probability`} type="number" min="0" max="1" step="any" value={entry.probability ?? 0} onChange={(event) => {
            const probability = optionalNumber(event.target.value);
            if (probability !== undefined && probability >= 0 && probability <= 1) updateEntry(index, { ...entry, probability });
          }} /></label>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add routed branch</strong><small>Remember to keep every XOR group complete and normalized.</small></div><Action variant="secondary" onClick={() => updateSpec({ ...spec, entries: [...entries, { target: { resource: 'application', id: `branch${entries.length + 1}` }, probability: 0 }] })}>Add route</Action></div>
    </FormSection>}
  </>;
}

function PlacementForm({ spec, updateSpec }: SpecProps) {
  const pools = spec.pools || {};
  const groups = spec.groups || {};
  const demands = spec.demands || [];
  const network = spec.network || [];
  const events = spec.events || {};
  const transitions = spec.transitions || {};
  const capacityRules = spec.capacityRules || [];
  const firstPool = Object.keys(pools)[0] || 'pool1';
  const removeKey = <T,>(values: Record<string, T>, id: string) => Object.fromEntries(Object.entries(values).filter(([key]) => key !== id)) as Record<string, T>;

  return <>
    <FormSection eyebrow="Topology workbench" title="Placement overview" description="Infrastructure, resource demand and latency stay optional for the instance, but explicit and inspectable when present." className="placement-overview-section">
      <div className="placement-overview">
        <div><strong>{Object.keys(pools).length}</strong><span>Pools</span></div>
        <div><strong>{Object.keys(groups).length + demands.length}</strong><span>Demand rules</span></div>
        <div><strong>{network.length}</strong><span>Network links</span></div>
        <div><strong>{Object.keys(transitions).length}</strong><span>Transitions</span></div>
      </div>
      <NumberMapEditor id="placement defaults" label="Default candidate demand" value={spec.defaults} onChange={(defaults) => updateSpec({ ...spec, defaults })} emptyLabel="No default demand; candidates consume only explicitly declared resources." />
    </FormSection>

    <FormSection eyebrow="Infrastructure" title="Pools" description="Pools are placement destinations with finite capacity and optional descriptive properties." count={Object.keys(pools).length}>
      <div className="form-card-list topology-card-list">{Object.entries(pools).map(([id, pool], index) => <FormCard
        key={id}
        eyebrow={`Pool ${String(index + 1).padStart(2, '0')} · ${pool.kind || 'untyped'}`}
        title={<code>{id}</code>}
        summary={`${Object.keys(pool.capacity || {}).length} capacity dimension${Object.keys(pool.capacity || {}).length === 1 ? '' : 's'}`}
        actions={<Action variant="ghost" size="sm" disabled={Object.keys(pools).length <= 1} onClick={() => updateSpec({ ...spec, pools: removeKey(pools, id) })}>Remove pool</Action>}
      >
        <div className="form-grid">
          <label>Display name<input aria-label={`${id} pool name`} value={pool.name || ''} onChange={(event) => updateSpec({ ...spec, pools: { ...pools, [id]: { ...pool, name: event.target.value } } })} placeholder="Optional label" /></label>
          <label>Kind<input aria-label={`${id} pool kind`} value={pool.kind || ''} onChange={(event) => {
            const next = { ...pool };
            if (event.target.value) next.kind = event.target.value;
            else delete next.kind;
            updateSpec({ ...spec, pools: { ...pools, [id]: next } });
          }} placeholder="edge, fog, cloud…" /></label>
        </div>
        <NumberMapEditor id={`${id} pool`} label="Capacity" value={pool.capacity} onChange={(capacity) => updateSpec({ ...spec, pools: { ...pools, [id]: { ...pool, capacity } } })} emptyLabel="This pool has no finite resource dimensions." />
        <JsonObjectEditor id={`${id} pool`} label="Advanced pool properties" value={pool.properties} scalarOnly={false} onChange={(properties) => updateSpec({ ...spec, pools: { ...pools, [id]: { ...pool, properties } } })} />
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add destination pool</strong><small>Start with an empty capacity map, then add dimensions such as CPU or memory.</small></div><Action variant="secondary" onClick={() => {
        const id = nextIdentifier(pools, 'pool');
        updateSpec({ ...spec, pools: { ...pools, [id]: { capacity: {} } } });
      }}>Add pool</Action></div>
    </FormSection>

    <FormSection eyebrow="Demand templates" title="Candidate groups" description="Apply one resource demand to a capability family or to an explicit list of candidates." count={Object.keys(groups).length}>
      {Object.keys(groups).length === 0 && <EmptyFormState>No grouped demand templates. Individual candidate demands can still be declared below.</EmptyFormState>}
      <div className="form-card-list">{Object.entries(groups).map(([id, group], index) => {
        const usesCandidates = Array.isArray(group.candidates);
        return <FormCard
          key={id}
          eyebrow={`Group ${String(index + 1).padStart(2, '0')}`}
          title={<code>{id}</code>}
          summary={usesCandidates ? `${group.candidates?.length || 0} explicit candidate references` : `Capability · ${group.capability || 'not set'}`}
          actions={<Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, groups: removeKey(groups, id) })}>Remove group</Action>}
        >
          <ReferenceEditor id={`${id} group`} label="Target pool" value={group.pool} onChange={(pool) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, pool } } })} />
          <div className="form-grid form-grid-compact"><label>Selection rule<select aria-label={`${id} group selection`} value={usesCandidates ? 'candidates' : 'capability'} onChange={(event) => {
            const next = { ...group };
            if (event.target.value === 'candidates') {
              delete next.capability;
              next.candidates = group.candidates?.length ? group.candidates : [{ resource: 'catalog', id: 'candidate' }];
            } else {
              delete next.candidates;
              next.capability = group.capability || 'service/new';
            }
            updateSpec({ ...spec, groups: { ...groups, [id]: next } });
          }}><option value="capability">capability family</option><option value="candidates">explicit candidates</option></select></label>
          {!usesCandidates && <label>Capability<input aria-label={`${id} group capability`} value={group.capability || ''} onChange={(event) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, capability: event.target.value } } })} /></label>}</div>
          {usesCandidates && <ReferenceListEditor id={`${id} group candidates`} label="Candidates" value={group.candidates} onChange={(candidates) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, candidates } } })} />}
          <NumberMapEditor id={`${id} group`} label="Resources per selected candidate" value={group.resources} onChange={(resources) => updateSpec({ ...spec, groups: { ...groups, [id]: { ...group, resources } } })} />
        </FormCard>;
      })}</div>
      <div className="form-add-bar"><div><strong>Add grouped demand</strong><small>Useful when many candidates share the same pool and resource footprint.</small></div><Action variant="secondary" onClick={() => {
        const id = nextIdentifier(groups, 'group');
        updateSpec({ ...spec, groups: { ...groups, [id]: { pool: { resource: 'placement', id: firstPool }, capability: 'service/new', resources: {} } } });
      }}>Add candidate group</Action></div>
    </FormSection>

    <FormSection eyebrow="Demand matrix" title="Individual demands" description="Pin a candidate to a pool and override its default resource consumption." count={demands.length}>
      {demands.length === 0 && <EmptyFormState>No individual candidate-to-pool demands.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{demands.map((demand, index) => <FormCard
        key={index}
        eyebrow={`Demand ${String(index + 1).padStart(2, '0')}`}
        title={<code>{demand.candidate?.id || 'candidate'}</code>}
        summary={`Placed in ${demand.pool?.id || 'pool'}`}
        actions={<Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, demands: demands.filter((_, itemIndex) => itemIndex !== index) })}>Remove demand</Action>}
      >
        <div className="reference-pair">
          <ReferenceEditor id={`demand ${index + 1}`} label="Candidate" value={demand.candidate} onChange={(candidate) => updateSpec({ ...spec, demands: demands.map((item, itemIndex) => itemIndex === index ? { ...item, candidate } : item) })} />
          <ReferenceEditor id={`demand ${index + 1}`} label="Pool" value={demand.pool} onChange={(pool) => updateSpec({ ...spec, demands: demands.map((item, itemIndex) => itemIndex === index ? { ...item, pool } : item) })} />
        </div>
        <NumberMapEditor id={`demand ${index + 1}`} label="Resource override" value={demand.resources} onChange={(resources) => updateSpec({ ...spec, demands: demands.map((item, itemIndex) => itemIndex === index ? { ...item, resources } : item) })} />
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add individual demand</strong><small>Use an empty resource map to inherit defaults.</small></div><Action variant="secondary" onClick={() => updateSpec({ ...spec, demands: [...demands, { candidate: { resource: 'catalog', id: 'candidate' }, pool: { resource: 'placement', id: firstPool }, resources: {} }] })}>Add demand</Action></div>
    </FormSection>

    <FormSection eyebrow="Topology" title="Network latency" description="Edges connect pools. Symmetric mode mirrors every declared link; directed mode does not." count={network.length}>
      <div className="form-grid form-grid-compact"><label>Network mode<select aria-label="Network mode" value={spec.networkMode || 'directed'} onChange={(event) => updateSpec({ ...spec, networkMode: event.target.value as BimSpecDocument['networkMode'] })}><option value="directed">directed links</option><option value="symmetric">symmetric links</option></select></label></div>
      {network.length === 0 && <EmptyFormState>No inter-pool latency links.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{network.map((link, index) => <FormCard
        key={index}
        eyebrow={`Link ${String(index + 1).padStart(2, '0')}`}
        title={<><code>{link.from?.id || 'from'}</code><span className="topology-arrow">→</span><code>{link.to?.id || 'to'}</code></>}
        summary={`${link.latency ?? 0} latency units`}
        actions={<Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, network: network.filter((_, itemIndex) => itemIndex !== index) })}>Remove link</Action>}
      >
        <div className="reference-pair">
          <ReferenceEditor id={`network ${index + 1}`} label="From pool" value={link.from} onChange={(from) => updateSpec({ ...spec, network: network.map((item, itemIndex) => itemIndex === index ? { ...item, from } : item) })} />
          <ReferenceEditor id={`network ${index + 1}`} label="To pool" value={link.to} onChange={(to) => updateSpec({ ...spec, network: network.map((item, itemIndex) => itemIndex === index ? { ...item, to } : item) })} />
        </div>
        <div className="form-grid form-grid-compact"><label>Latency<input aria-label={`Network ${index + 1} latency`} type="number" min="0" step="any" value={link.latency ?? 0} onChange={(event) => {
          const latency = optionalNumber(event.target.value);
          if (latency !== undefined && latency >= 0) updateSpec({ ...spec, network: network.map((item, itemIndex) => itemIndex === index ? { ...item, latency } : item) });
        }} /></label></div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add network link</strong><small>Self-links can make zero-latency placement explicit.</small></div><Action variant="secondary" onClick={() => updateSpec({ ...spec, network: [...network, { from: { resource: 'placement', id: firstPool }, to: { resource: 'placement', id: firstPool }, latency: 0 }] })}>Add link</Action></div>
    </FormSection>

    <FormSection eyebrow="Ingress" title="External events" description="Event sources originate at one pool and may override latency to other pools." count={Object.keys(events).length}>
      {Object.keys(events).length === 0 && <EmptyFormState>No external ingress events.</EmptyFormState>}
      <div className="form-card-list">{Object.entries(events).map(([id, event], index) => <FormCard
        key={id}
        eyebrow={`Event ${String(index + 1).padStart(2, '0')}`}
        title={<code>{id}</code>}
        summary={`Origin · ${event.pool?.id || 'pool'} · ${event.latency?.length || 0} overrides`}
        actions={<Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, events: removeKey(events, id) })}>Remove event</Action>}
      >
        <ReferenceEditor id={`${id} event`} label="Origin pool" value={event.pool} onChange={(pool) => updateSpec({ ...spec, events: { ...events, [id]: { ...event, pool } } })} />
        <div className="form-subgroup">
          <div className="form-subgroup-heading"><div><span className="micro-label">Overrides</span><h5>Pool latency</h5></div><Action variant="secondary" size="sm" onClick={() => updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: [...(event.latency || []), { pool: { resource: 'placement', id: firstPool }, latency: 0 }] } } })}>Add latency</Action></div>
          {(event.latency || []).length === 0 && <EmptyFormState>No event-specific latency overrides.</EmptyFormState>}
          <div className="nested-card-list">{(event.latency || []).map((override, overrideIndex) => <div className="nested-card" key={overrideIndex}>
            <ReferenceEditor id={`${id} event latency ${overrideIndex + 1}`} label="Destination pool" value={override.pool} onChange={(pool) => updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: (event.latency || []).map((item, itemIndex) => itemIndex === overrideIndex ? { ...item, pool } : item) } } })} />
            <div className="form-grid form-grid-compact"><label>Latency<input aria-label={`${id} event latency ${overrideIndex + 1}`} type="number" min="0" step="any" value={override.latency ?? 0} onChange={(changeEvent) => {
              const latency = optionalNumber(changeEvent.target.value);
              if (latency !== undefined && latency >= 0) updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: (event.latency || []).map((item, itemIndex) => itemIndex === overrideIndex ? { ...item, latency } : item) } } });
            }} /></label></div>
            <Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, events: { ...events, [id]: { ...event, latency: (event.latency || []).filter((_, itemIndex) => itemIndex !== overrideIndex) } } })}>Remove latency</Action>
          </div>)}</div>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add ingress source</strong><small>Transitions can connect this event id to an application task.</small></div><Action variant="secondary" onClick={() => {
        const id = nextIdentifier(events, 'event');
        updateSpec({ ...spec, events: { ...events, [id]: { pool: { resource: 'placement', id: firstPool }, latency: [] } } });
      }}>Add event</Action></div>
    </FormSection>

    <FormSection eyebrow="Latency policy" title="Transitions" description="Bound end-to-end hops between events or tasks, with hard limits or weighted soft penalties." count={Object.keys(transitions).length}>
      {Object.keys(transitions).length === 0 && <EmptyFormState>No transition-specific latency bounds.</EmptyFormState>}
      <div className="form-card-list">{Object.entries(transitions).map(([id, transition], index) => <FormCard
        key={id}
        eyebrow={`Transition ${String(index + 1).padStart(2, '0')} · ${transition.enforcement || 'hard'}`}
        title={<code>{id}</code>}
        summary={`${transition.from?.id || 'source'} → ${transition.to?.id || 'target'} · max ${transition.maximum ?? 0}`}
        actions={<Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, transitions: removeKey(transitions, id) })}>Remove transition</Action>}
      >
        <div className="reference-pair">
          <ReferenceEditor id={`${id} transition`} label="From" value={transition.from} onChange={(from) => updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, from } } })} />
          <ReferenceEditor id={`${id} transition`} label="To" value={transition.to} onChange={(to) => updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, to } } })} />
        </div>
        <ReferenceEditor id={`${id} transition`} label="Latency metric" value={transition.metric} onChange={(metric) => updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, metric } } })} />
        <div className="form-grid">
          <label>Maximum<input aria-label={`${id} transition maximum`} type="number" min="0" step="any" value={transition.maximum ?? 0} onChange={(event) => {
            const maximum = optionalNumber(event.target.value);
            if (maximum !== undefined && maximum >= 0) updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, maximum } } });
          }} /></label>
          <label>Enforcement<select aria-label={`${id} transition enforcement`} value={transition.enforcement || 'hard'} onChange={(event) => {
            const next = { ...transition, enforcement: event.target.value as PlacementTransitionDocument['enforcement'] };
            if (event.target.value === 'soft') next.penalty = transition.penalty ?? 1;
            else delete next.penalty;
            updateSpec({ ...spec, transitions: { ...transitions, [id]: next } });
          }}><option value="hard">hard limit</option><option value="soft">soft limit</option></select></label>
          {(transition.enforcement === 'soft') && <label>Penalty<input aria-label={`${id} transition penalty`} type="number" min="0" step="any" value={transition.penalty ?? 1} onChange={(event) => {
            const penalty = optionalNumber(event.target.value);
            if (penalty !== undefined && penalty >= 0) updateSpec({ ...spec, transitions: { ...transitions, [id]: { ...transition, penalty } } });
          }} /></label>}
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add latency transition</strong><small>References may point to application tasks or placement events.</small></div><Action variant="secondary" onClick={() => {
        const id = nextIdentifier(transitions, 'transition');
        updateSpec({ ...spec, transitions: { ...transitions, [id]: { from: { resource: 'application', id: 'task1' }, to: { resource: 'application', id: 'task2' }, metric: { resource: 'application', id: 'latency' }, maximum: 0 } } });
      }}>Add transition</Action></div>
    </FormSection>

    <FormSection eyebrow="Capacity semantics" title="Capacity rules" description="Choose which demand dimensions accumulate per invocation or once per selected candidate." count={capacityRules.length}>
      {capacityRules.length === 0 && <EmptyFormState>No explicit capacity accounting rules.</EmptyFormState>}
      <div className="form-card-list form-card-list-compact">{capacityRules.map((rule, index) => <FormCard
        key={index}
        eyebrow={`Rule ${String(index + 1).padStart(2, '0')}`}
        title={rule.resources?.join(', ') || 'resources'}
        summary={rule.scope === 'invocation' ? 'Charged for every workflow invocation.' : 'Charged once for each selected candidate.'}
        actions={<Action variant="ghost" size="sm" onClick={() => updateSpec({ ...spec, capacityRules: capacityRules.filter((_, itemIndex) => itemIndex !== index) })}>Remove rule</Action>}
      >
        <div className="form-grid">
          <label>Resource dimensions<input aria-label={`Capacity rule ${index + 1} resources`} value={(rule.resources || []).join(', ')} onChange={(event) => updateSpec({ ...spec, capacityRules: capacityRules.map((item, itemIndex) => itemIndex === index ? { ...item, resources: Array.from(new Set(event.target.value.split(',').map((value) => value.trim()).filter(Boolean))) } : item) })} placeholder="memory, cpu" /></label>
          <label>Accounting scope<select aria-label={`Capacity rule ${index + 1} scope`} value={rule.scope || 'selectedCandidate'} onChange={(event) => updateSpec({ ...spec, capacityRules: capacityRules.map((item, itemIndex) => itemIndex === index ? { ...item, scope: event.target.value as PlacementCapacityRuleDocument['scope'] } : item) })}><option value="selectedCandidate">once per selected candidate</option><option value="invocation">per invocation</option></select></label>
        </div>
      </FormCard>)}</div>
      <div className="form-add-bar"><div><strong>Add accounting rule</strong><small>List one or more comma-separated resource dimensions.</small></div><Action variant="secondary" onClick={() => updateSpec({ ...spec, capacityRules: [...capacityRules, { resources: ['memory'], scope: 'selectedCandidate' }] })}>Add capacity rule</Action></div>
    </FormSection>

    <FormSection eyebrow="End-to-end model" title="Global latency" description="Optionally derive one workflow-level latency metric from execution time, routing and pool topology.">
      <label className="choice-card global-latency-toggle"><input type="checkbox" aria-label="Enable global latency" checked={Boolean(spec.globalLatency)} onChange={(event) => {
        const next = { ...spec };
        if (event.target.checked) next.globalLatency = { metric: { resource: 'application', id: 'latency' }, includeExecution: true, exclusive: 'routing', parallel: 'max' };
        else delete next.globalLatency;
        updateSpec(next);
      }} /><span><strong>Compute global latency</strong><small>Fold placement and workflow timing into the selected metric.</small></span></label>
      {spec.globalLatency && <div className="global-latency-panel">
        <ReferenceEditor id="global latency" label="Output metric" value={spec.globalLatency.metric} onChange={(metric) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, metric } })} />
        <div className="form-grid">
          <label className="check-field"><input aria-label="Global latency include execution" type="checkbox" checked={Boolean(spec.globalLatency.includeExecution)} onChange={(event) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, includeExecution: event.target.checked } })} /> Include candidate execution latency</label>
          <label>Exclusive branches<select aria-label="Global latency exclusive" value={spec.globalLatency.exclusive || 'routing'} onChange={(event) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, exclusive: event.target.value as PlacementGlobalLatencyDocument['exclusive'] } })}><option value="routing">probability-weighted routing</option><option value="condition">static conditions</option></select></label>
          <label>Parallel branches<select aria-label="Global latency parallel" value={spec.globalLatency.parallel || 'max'} onChange={(event) => updateSpec({ ...spec, globalLatency: { ...spec.globalLatency!, parallel: event.target.value as PlacementGlobalLatencyDocument['parallel'] } })}><option value="max">critical path maximum</option><option value="sum">sum all branches</option></select></label>
        </div>
      </div>}
    </FormSection>
  </>;
}

function SpecificResourceForm({ document, onChange, availablePaths }: CommonResourceFormProps) {
  const spec = document.spec || {};
  const updateSpec = (nextSpec: BimSpecDocument) => onChange({ ...document, spec: nextSpec });

  if (document.apiVersion === 'qos-binding/v1' && document.kind === 'Application') {
    return <ApplicationForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.apiVersion === 'qos-binding/v1' && document.kind === 'CandidateCatalog') {
    return <CandidateCatalogForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.apiVersion === 'qos-binding/v1' && document.kind === 'ConstraintSet') {
    return <ConstraintSetForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.apiVersion === 'qos-binding/v1' && document.kind === 'Optimization') {
    return <OptimizationForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.apiVersion === 'qos-binding/v1' && document.kind === 'RoutingOverlay') {
    return <RoutingOverlayForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.apiVersion === 'qos-binding-placement/v1' && document.kind === 'Placement') {
    return <PlacementForm spec={spec} updateSpec={updateSpec} />;
  }

  if (document.apiVersion === 'bim/v1' && document.kind === 'Instance') {
    return <InstanceForm spec={spec} updateSpec={updateSpec} availablePaths={availablePaths} />;
  }

  return <p className="workspace-hint">This dialect has no form yet, so it is edited in View source where its versioned contract stays explicit.</p>;
}
