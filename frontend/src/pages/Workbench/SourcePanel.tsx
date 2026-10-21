import { lazy, Suspense } from 'react';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { pretty } from './bimDocuments';
import type { SourceView, Workbench } from './useWorkbench';

const CodeEditor = lazy(() => import('../../components/CodeEditor/CodeEditor').then((module) => ({ default: module.CodeEditor })));

function EditorLoading() {
  return <div className="wb-loading" role="status"><span className="wb-spinner" aria-hidden="true" />Loading editing surface…</div>;
}

/**
 * The raw side of the package, behind “View source”: the exact JSON of a file, a YAML reading of it, the workflow, the BPMN XML,
 * the compiled form and what changed against the baseline. Everything above this works without opening it.
 */
export function SourcePanel({ wb }: { wb: Workbench }) {
  const views: Array<{ id: SourceView; label: string }> = [
    { id: 'json', label: 'JSON source' },
    ...(wb.selectedDocument ? [{ id: 'yaml' as const, label: 'YAML view' }] : []),
    { id: 'workflow', label: 'Workflow JSON' },
    ...(wb.bpmnPath ? [{ id: 'bpmnXml' as const, label: 'BPMN XML' }] : []),
    { id: 'ir', label: 'Compiled IR' },
    { id: 'diff', label: 'Source diff' },
  ];
  const view = views.some((item) => item.id === wb.sourceView) ? wb.sourceView : 'json';
  const path = wb.selectedPath;

  return (
    <section id="wb-view-source" className="wb-source" aria-label="Source">
      <TabBar items={views} value={view} onChange={(id) => wb.setSourceView(id as SourceView)} ariaLabel="Source views" prefix="wb-source-view" />
      <TabPanel prefix="wb-source-view" active={view}>
        {view === 'json' && (
          <div className="wb-source-pane">
            <div className="wb-pane-head"><div><span className="wb-eyebrow">Exact package source</span><h3>{path}</h3></div><Chip>{wb.selectedDocument?.kind || (path.endsWith('.bpmn') ? 'BPMN' : 'text')}</Chip></div>
            <Suspense fallback={<EditorLoading />}>
              <CodeEditor
                key={path}
                ariaLabel={`${path} source`}
                language={path.endsWith('.json') ? 'json' : path.endsWith('.bpmn') ? 'xml' : 'text'}
                value={wb.files[path] || ''}
                selection={wb.editorSelection}
                onChange={(value) => wb.updateSource(path, value)}
                minHeight="420px"
                maxHeight="70vh"
              />
            </Suspense>
          </div>
        )}
        {view === 'yaml' && wb.selectedYaml && (
          <div className="wb-source-pane">
            <div className="wb-pane-head"><div><span className="wb-eyebrow">YAML 1.2 projection</span><h3>{path}</h3></div></div>
            <p className="wb-muted">The package itself stays JSON; this reading is safe to copy into YAML tooling.</p>
            <Suspense fallback={<EditorLoading />}>
              <CodeEditor ariaLabel={`${path} YAML view`} language="text" value={wb.selectedYaml} onChange={() => undefined} readOnly minHeight="420px" maxHeight="70vh" />
            </Suspense>
          </div>
        )}
        {view === 'workflow' && (
          <div className="wb-source-pane">
            <div className="wb-pane-head"><div><span className="wb-eyebrow">qos-binding/v1 source</span><h3>Native workflow</h3></div></div>
            <Suspense fallback={<EditorLoading />}>
              <CodeEditor ariaLabel="Native workflow JSON" value={wb.workflowText} onChange={wb.updateWorkflow} minHeight="420px" maxHeight="70vh" />
            </Suspense>
          </div>
        )}
        {view === 'bpmnXml' && (
          <div className="wb-source-pane">
            <div className="wb-pane-head"><div><span className="wb-eyebrow">omg/bpmn/2.0.2 source</span><h3>{wb.bpmnPath || 'workflow.bpmn'}</h3></div></div>
            <p className="wb-muted">Only valid XML replaces the last valid diagram.</p>
            <Suspense fallback={<EditorLoading />}>
              <CodeEditor ariaLabel={`${wb.bpmnPath || 'workflow.bpmn'} XML source`} language="xml" value={wb.bpmnDraft} onChange={wb.updateBpmnDraft} minHeight="420px" maxHeight="70vh" />
            </Suspense>
          </div>
        )}
        {view === 'ir' && (
          <div className="wb-source-pane">
            <div className="wb-pane-head">
              <div><span className="wb-eyebrow">Authoritative compiler output</span><h3>Binding problem IR</h3></div>
              <Action variant="secondary" size="sm" busy={wb.irLoading} onClick={() => void wb.compile()}>{wb.compiledIr ? 'Recompile IR' : 'Compile IR'}</Action>
            </div>
            <div aria-live="polite">
              {wb.irError && <Notice tone="error">{wb.irError}</Notice>}
              {wb.compiledIr ? (
                <>
                  <dl className="wb-ir-facts">
                    <div><dt>Snapshot</dt><dd><code>{wb.compiledIr.snapshot}</code></dd></div>
                    <div><dt>IR digest</dt><dd><code>{wb.compiledIr.digest}</code></dd></div>
                    {wb.analysisData?.bindingSpace && <div><dt>Binding space</dt><dd><BindingSpaceBadge cardinality={wb.analysisData.bindingSpace} /></dd></div>}
                  </dl>
                  <Suspense fallback={<EditorLoading />}>
                    <CodeEditor ariaLabel="Compiled binding problem IR" value={pretty(wb.compiledIr.document)} onChange={() => undefined} readOnly minHeight="360px" maxHeight="65vh" />
                  </Suspense>
                </>
              ) : !wb.irLoading && !wb.irError ? (
                <Notice tone="info">Compile the current package to inspect the exact normalized IR sent to a compatible engine. This saves a private snapshot of it.</Notice>
              ) : null}
            </div>
          </div>
        )}
        {view === 'diff' && (
          <div className="wb-source-pane">
            <div className="wb-pane-head"><div><span className="wb-eyebrow">Current source against the loaded baseline</span><h3>{path}</h3></div><Chip tone={wb.selectedChanged ? 'accent' : 'success'}>{wb.selectedChanged ? 'Modified' : 'Unchanged'}</Chip></div>
            {wb.selectedChanged ? (
              <pre className="wb-diff" aria-label={`Changes to ${path}`}>
                <code>
                  {wb.selectedDiff.map((line, index) => (
                    <span className={`diff-${line.kind}`} key={`${line.kind}-${index}`}>
                      <b aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</b>{line.value || ' '}
                    </span>
                  ))}
                </code>
              </pre>
            ) : <Notice tone="info">This file matches the baseline loaded into the workbench.</Notice>}
          </div>
        )}
      </TabPanel>
    </section>
  );
}
