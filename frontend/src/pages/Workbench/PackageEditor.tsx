import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Code2 } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { RESOURCE_ROLE_LABELS, registeredResourceLabel } from './bimDocuments';
import { CommonResourceForm } from './resourceForms';
import { SourcePanel } from './SourcePanel';
import type { EditorTab, Workbench } from './useWorkbench';

const BpmnModeler = lazy(() => import('./BpmnModeler').then((module) => ({ default: module.BpmnModeler })));

/** Edit the package without leaving the page: the resources as forms, the workflow as a diagram, the raw files behind “View source”. */
export function PackageEditor({ wb }: { wb: Workbench }) {
  const tabs: Array<{ id: EditorTab; label: string }> = [
    { id: 'resources', label: 'Resources' },
    { id: 'form', label: 'Form' },
    ...(wb.bpmnPath ? [{ id: 'bpmn' as const, label: 'BPMN modeler' }] : []),
  ];
  const tab = tabs.some((item) => item.id === wb.editorTab) ? wb.editorTab : 'resources';
  const groups = [...new Set(wb.resources.map((resource) => resource.role))].map((role) => ({
    role,
    resources: wb.resources.filter((resource) => resource.role === role),
  }));
  const paths = Object.keys(wb.files).filter((path) => path !== 'instance.json' && /\.(?:json|bpmn|xml)$/i.test(path));

  return (
    <section className="wb-card wb-editor" id="wb-editor" aria-labelledby="wb-editor-title">
      <div className="wb-card-head">
        <div>
          <h2 id="wb-editor-title">Package editor</h2>
          <p className="wb-muted">Edit the resources as forms or draw the workflow. Nothing leaves your browser until you validate, snapshot or save.</p>
        </div>
        <Action variant="secondary" size="sm" aria-expanded={wb.sourceOpen} aria-controls="wb-view-source" onClick={() => wb.setSourceOpen(!wb.sourceOpen)}>
          <Code2 aria-hidden="true" />View source
        </Action>
      </div>
      <div className="wb-editor-grid">
        <nav className="wb-index" aria-label="BIM resources">
          <header><span>Package index</span><strong>{wb.resources.length + 1} documents</strong></header>
          <button type="button" className={wb.selectedPath === 'instance.json' ? 'is-selected' : ''} aria-current={wb.selectedPath === 'instance.json' ? 'true' : undefined} onClick={() => wb.selectResource('instance.json')}>
            <span>Instance root</span><code>instance.json</code>
          </button>
          {groups.map(({ role, resources }) => (
            <section className="wb-index-group" key={role}>
              <h3>{RESOURCE_ROLE_LABELS[role] || role}<small>{resources.length}</small></h3>
              {resources.map((resource) => (resource.path
                ? (
                  <button type="button" key={resource.id} className={wb.selectedPath === resource.path ? 'is-selected' : ''} aria-current={wb.selectedPath === resource.path ? 'true' : undefined} onClick={() => wb.selectResource(resource.path!, resource.kind)}>
                    <span>{resource.kind}</span><strong>{resource.id}</strong><code>{resource.path}</code>
                  </button>
                )
                : (
                  <div className="wb-index-registered" key={resource.id}>
                    <span>{resource.kind}</span><strong>{resource.id}</strong><code>{resource.registered ? registeredResourceLabel(resource.registered) : 'invalid target'}</code>
                  </div>
                )))}
            </section>
          ))}
          <Link className="wb-index-link" to="/examples" viewTransition>Browse guided examples <ArrowRight aria-hidden="true" /></Link>
        </nav>

        <div className="wb-editor-main">
          <div className="wb-selected">
            <Chip tone="accent">{wb.selectedKind}</Chip>
            <code>{wb.selectedPath}</code>
            <span className="wb-muted">
              Profile {wb.root?.spec?.profile || 'unresolved'} · {wb.selectedResource?.role || 'container'} · {wb.selectedPath.endsWith('.bpmn') ? 'XML dialect' : 'JSON'}
            </span>
          </div>
          <TabBar items={tabs} value={tab} onChange={(id) => wb.setEditorTab(id as EditorTab)} ariaLabel="Resource views" prefix="wb-editor" />
          <TabPanel prefix="wb-editor" active={tab}>
            {tab === 'resources' && (
              <div className="wb-pane">
                <div className="wb-pane-head">
                  <div>
                    <span className="wb-eyebrow">Instance → Profile roles → resources</span>
                    <h3>Composable resources</h3>
                  </div>
                </div>
                <p className="wb-muted">Application, candidate catalogs, constraint sets and optimization are independent documents. RoutingOverlay, BPMN and Placement are typed resources in the application role.</p>
                <ul className="wb-resource-rows" aria-label="Resources of the package">
                  {wb.resources.map((resource) => (
                    <li key={`${resource.role}/${resource.id}`}>
                      <strong>{resource.role}</strong><span>{resource.kind}</span><code>{resource.id}</code>
                      <code>{resource.path || (resource.registered ? registeredResourceLabel(resource.registered) : 'invalid target')}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {tab === 'form' && (
              <div className="wb-pane">
                {wb.selectedDocument
                  ? <CommonResourceForm document={wb.selectedDocument} onChange={wb.updateSelectedDocument} availablePaths={paths} />
                  : <Notice tone="error">{wb.selectedPath} is not a JSON document, so it has no form. Open View source to repair or read it.</Notice>}
              </div>
            )}
            {tab === 'bpmn' && (
              <div className="wb-pane wb-pane-flush">
                {wb.bpmnPath ? (
                  <Suspense fallback={<div className="wb-loading" role="status"><span className="wb-spinner" aria-hidden="true" />Loading editing surface…</div>}>
                    <BpmnModeler candidateXml={wb.bpmnDraft} fallbackXml={wb.files[wb.bpmnPath]} focusElement={wb.focusedBpmnElement} onValidXml={wb.acceptBpmn} onError={wb.bpmnFailed} />
                  </Suspense>
                ) : <Notice tone="info">This package does not declare a BPMN resource.</Notice>}
              </div>
            )}
          </TabPanel>
        </div>
      </div>
      {wb.sourceOpen && <SourcePanel wb={wb} />}
    </section>
  );
}
