import { useState, type FormEvent } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { apiClient, type ConvertLegacyParams, type EngineCalibratedResponse } from '../../api/client';
import { generatorApi } from '../../api/generator';
import { platformApi } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useAuth } from '../../contexts/auth';
import { saveDraft } from '../../utils/workspaceDraft';
import { useResource } from '../../utils/useResource';
import { Breadcrumb } from '../Organization/parts';
import { workbenchDraftScope } from '../Workbench/workbenchModel';
import { InstanceFields } from './InstanceFields';
import { KeepIt, Preview, type KeepState } from './LabAside';
import { CalibratePane, ConvertPane, type LegacyState } from './ToolPanes';
import {
  DEFAULT_SETTINGS, checkSettings, instanceParams, labRefusal, readObservations, seedOf, workspaceFilesOf,
  type FieldErrors, type FieldKey, type LabSettings, type LabTool, type Output, type ProjectChoice,
} from './generatorModel';
import '../Project/Project.css';
import './Generator.css';

const TOOLS = [
  { id: 'instance', label: 'One instance' },
  { id: 'corpus', label: 'Batch' },
  { id: 'convert', label: 'Convert old format' },
  { id: 'calibrate', label: 'Calibrate engines' },
] as const;

const MEMBER_ROLES = new Set(['MEMBER', 'ADMIN', 'OWNER']);

/**
 * The generator lab (`gen-lab`, `/app/generator`): make synthetic problems for testing engines, one at a time or as a batch, turn an
 * old-format instance into a package, and (platform administrators only) refit the model that predicts how an engine behaves.
 */
export function GeneratorLab() {
  const { user, isAdmin } = useAuth();
  const context = useOutletContext<PlatformOutletContext | null>();
  const navigate = useNavigate();

  const [tool, setTool] = useState<LabTool>('instance');
  const [settings, setSettings] = useState<LabSettings>(DEFAULT_SETTINGS);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [output, setOutput] = useState<Output | null>(null);
  const [keep, setKeep] = useState<KeepState | null>(null);
  const [saving, setSaving] = useState(false);
  const [project, setProject] = useState('');
  const [legacy, setLegacy] = useState<LegacyState>({ text: '', fileName: '', name: 'converted_legacy', repair: true, guarantee: true, tension: '0.7' });
  const [convertError, setConvertError] = useState<string | null>(null);
  const [calibration, setCalibration] = useState({ engine: '', mode: 'default', observationsText: '', fileName: '' });
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [calibrated, setCalibrated] = useState<EngineCalibratedResponse | null>(null);

  // The projects the person can add to: those of the organizations where they are at least a MEMBER.
  const organizations = (context?.organizations ?? []).filter((item) => item.effective_role && MEMBER_ROLES.has(item.effective_role));
  const projects = useResource<ProjectChoice[]>(
    `lab-projects:${user?.id ?? 'visitor'}:${organizations.map((item) => item.slug).join(',')}`,
    async () => {
      if (!user) return [];
      const lists = await Promise.all(organizations.map(async (organization) => (await platformApi.projects(organization.slug)).map((item): ProjectChoice => ({
        id: item.id, org: organization.slug, project: item.slug, label: organizations.length > 1 ? `${item.name} · ${organization.name}` : item.name,
      }))));
      return lists.flat();
    },
  );
  const engines = useResource<string[]>(`lab-engines:${isAdmin ? 'admin' : 'member'}`, async () => (isAdmin ? [...new Set((await apiClient.getEngines()).map((engine) => engine.name))] : []));
  const choices = projects.data ?? [];
  const chosen = choices.find((item) => item.id === project) ?? choices[0];

  const reset = () => {
    setOutput(null);
    setKeep(null);
    setFormError(null);
    setConvertError(null);
  };

  const changeSettings = (patch: Partial<LabSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as FieldKey];
      return next;
    });
    reset();
  };

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    if (generating) return;
    const problems = checkSettings(settings, tool === 'corpus' ? 'corpus' : 'instance');
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      setFormError('Check the highlighted fields (422): the numbers have to be inside what the generator accepts, and “to” has to be above “from”.');
      return;
    }
    setGenerating(true);
    reset();
    setErrors({});
    const params = instanceParams(settings, seedOf(settings));
    try {
      if (tool === 'corpus') {
        const count = Number(settings.count);
        const name = settings.name.trim() || 'corpus';
        const response = await generatorApi.corpus({ count, base_config: params, name, persist: false });
        setOutput({ kind: 'corpus', response, params, count, name });
      } else {
        const response = await generatorApi.instance(params);
        setOutput({ kind: 'instance', response, params });
      }
    } catch (caught: unknown) {
      const refusal = labRefusal(caught, 'nothing was generated');
      if (refusal.kind === 'config') setErrors(refusal.fields);
      setFormError(refusal.text);
    } finally {
      setGenerating(false);
    }
  };

  const convert = async (event: FormEvent) => {
    event.preventDefault();
    if (generating || !legacy.text.trim()) return;
    setGenerating(true);
    reset();
    const request: ConvertLegacyParams = {
      raw_text: legacy.text,
      name: legacy.name.trim() || 'converted_legacy',
      repair_empty_branches: legacy.repair,
      guarantee_feasibility: legacy.guarantee,
      tension: Number(legacy.tension),
    };
    try {
      const response = await generatorApi.convertLegacy(request);
      setOutput({ kind: 'convert', response, request });
    } catch (caught: unknown) {
      setConvertError(labRefusal(caught, 'nothing was converted', 'text').text);
    } finally {
      setGenerating(false);
    }
  };

  const calibrate = async (event: FormEvent) => {
    event.preventDefault();
    if (!isAdmin || calibrating || !calibration.engine.trim()) return;
    let observations: ReturnType<typeof readObservations> | null = null;
    if (calibration.observationsText.trim()) {
      observations = readObservations(calibration.observationsText);
      if ('error' in observations) {
        setCalibrationError(observations.error);
        return;
      }
    }
    setCalibrating(true);
    setCalibrationError(null);
    setCalibrated(null);
    try {
      setCalibrated(await generatorApi.calibrate({
        engine: calibration.engine.trim(),
        mode: calibration.mode.trim() || 'default',
        ...(observations && 'observations' in observations ? { observations: observations.observations } : {}),
      }));
    } catch (caught: unknown) {
      setCalibrationError(labRefusal(caught, 'nothing was calibrated', 'runs').text);
    } finally {
      setCalibrating(false);
    }
  };

  const save = async () => {
    if (!output || !chosen || saving) return;
    setSaving(true);
    setKeep(null);
    try {
      if (output.kind === 'instance') {
        await generatorApi.instance({ ...output.params, persist: true, project_id: chosen.id, case_name: output.params.name });
      } else if (output.kind === 'corpus') {
        await generatorApi.corpus({ count: output.count, base_config: output.params, name: output.name, persist: true, project_id: chosen.id, collection_name: output.name });
      } else {
        await generatorApi.convertLegacy({ ...output.request, persist: true, project_id: chosen.id, case_name: output.request.name });
      }
      setKeep({
        tone: 'success',
        text: `Saved to ${chosen.label} as ${output.kind === 'corpus' ? 'a collection of synthetic instances' : 'a synthetic instance'}.`,
        href: `/app/${chosen.org}/${chosen.project}/${output.kind === 'corpus' ? 'collections' : 'cases'}`,
      });
    } catch (caught: unknown) {
      setKeep({ tone: 'error', text: labRefusal(caught, 'nothing was saved', 'keep').text });
    } finally {
      setSaving(false);
    }
  };

  /** Hand the generated package to the workbench of the chosen project, which opens it as its draft. */
  const openInWorkbench = async () => {
    if (!output || output.kind === 'corpus' || !chosen || !user) return;
    const path = `/app/${chosen.org}/${chosen.project}/workbench`;
    try {
      await saveDraft(workspaceFilesOf(output.response.files), workbenchDraftScope(user.id, path, null, null));
      void navigate(path, { viewTransition: true });
    } catch (caught: unknown) {
      setKeep({ tone: 'error', text: caught instanceof Error ? caught.message : 'The package could not be handed to the workbench.' });
    }
  };

  const showAside = tool !== 'calibrate';

  return (
    <div className="proj-frame gl">
      <div className="proj-band">
        <div className="proj-band-inner"><Breadcrumb items={[{ label: 'Home', to: '/app' }, { label: 'Generator lab' }]} /></div>
      </div>
      <div className="proj-body is-wide">
        <header className="proj-title-row">
          <div className="proj-title">
            <h1>Generator lab</h1>
            <p>Make synthetic problems for testing engines: one instance, a whole batch, or a conversion of an old-format instance. A research tool; results are labelled synthetic.</p>
          </div>
        </header>

        <TabBar items={TOOLS} value={tool} onChange={(id) => { setTool(id as LabTool); reset(); }} ariaLabel="Tool" prefix="gl-tool" />

        <div className="gl-layout">
          <div className="gl-main">
            <TabPanel prefix="gl-tool" active={tool}>
              {(tool === 'instance' || tool === 'corpus') && (
                <form className="gl-card gl-form" onSubmit={(event) => void generate(event)} noValidate>
                  {tool === 'corpus' && <p className="gl-lede">Same settings as a single instance, repeated as many times as you ask for.</p>}
                  <InstanceFields settings={settings} errors={errors} onChange={changeSettings} tool={tool} />
                  {tool === 'corpus' && !user && <span className="gl-note is-warning">Keeping a corpus needs an account; without one you only see the preview.</span>}
                  {formError && <div className="gl-alert" role="alert">{formError}</div>}
                  <Action type="submit" variant="primary" busy={generating}>{tool === 'corpus' ? 'Generate batch' : 'Generate instance'}</Action>
                </form>
              )}
              {tool === 'convert' && (
                <ConvertPane legacy={legacy} onChange={(patch) => { setLegacy((current) => ({ ...current, ...patch })); reset(); }} busy={generating} error={convertError} onSubmit={(event) => void convert(event)} />
              )}
              {tool === 'calibrate' && (
                <CalibratePane
                  isAdmin={isAdmin}
                  engines={engines.data ?? []}
                  engine={calibration.engine}
                  mode={calibration.mode}
                  observationsText={calibration.observationsText}
                  fileName={calibration.fileName}
                  busy={calibrating}
                  error={calibrationError}
                  result={calibrated}
                  onChange={(patch) => { setCalibration((current) => ({ ...current, ...patch })); setCalibrationError(null); }}
                  onSubmit={(event) => void calibrate(event)}
                />
              )}
            </TabPanel>
          </div>
          {showAside && (
            <aside className="gl-aside" aria-label="Result">
              <Preview generating={generating} output={output} />
              <KeepIt
                signedIn={Boolean(user)}
                projects={choices}
                projectsLoading={projects.status === 'loading'}
                selected={chosen?.id ?? ''}
                onSelect={setProject}
                hasOutput={Boolean(output)}
                hasFiles={Boolean(output) && output?.kind !== 'corpus'}
                saving={saving}
                keep={keep}
                onSave={() => void save()}
                onOpen={() => void openInWorkbench()}
              />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
