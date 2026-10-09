import { useEffect, useState, type FormEvent } from 'react';
import { analysisApi, type ArchiveQuery } from '../../analysis/archive';
import { HttpError } from '../../api/client';
import { platformApi, type Organization, type Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { SelectField } from '../Organization/parts';
import { analysisProblem } from './analysisErrors';

interface SaveReportProps {
  query: ArchiveQuery;
  /** The address the report starts with; the opener makes it unique. */
  defaultSlug: string;
  /** Where the dialog starts: the workspace's current organization and project. */
  organization?: string;
  project?: string;
  close: () => void;
  saved: (path: string) => void;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Save the decision, with the exact receipt (priorities, rule, sources), as a draft report of a project the person can write to. */
export function SaveReport({ query, defaultSlug, organization: startOrg = '', project: startProject = '', close, saved }: SaveReportProps) {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [org, setOrg] = useState(startOrg);
  const [project, setProject] = useState(startProject);
  const [title, setTitle] = useState('Binding decision');
  const [slug, setSlug] = useState(defaultSlug);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    platformApi.organizations().then(
      (list) => { if (active) setOrganizations(list.filter((item) => item.effective_role && item.effective_role !== 'VIEWER')); },
      () => { if (active) { setOrganizations([]); setError('Your organizations couldn’t be loaded.'); } },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!org) return;
    let active = true;
    platformApi.projects(org).then(
      (list) => { if (active) setProjects(list); },
      () => { if (active) { setProjects([]); setError('The projects of this organization couldn’t be loaded.'); } },
    );
    return () => { active = false; };
  }, [org]);

  const slugOk = SLUG.test(slug);
  const ready = Boolean(org && project && title.trim() && slugOk);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const report = await analysisApi.save(query, org, project, title.trim(), slug);
      saved(`/app/${org}/${project}/reports/${report.slug}`);
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 409) setError('That report address is already used in this project. Change it.');
      else if (caught instanceof HttpError && caught.status === 403) setError('Saving a report needs MEMBER in the organization, and for a key the reports:write permission.');
      else setError(analysisProblem(caught, 'save the decision').text);
    } finally {
      setBusy(false);
    }
  };

  const visibleProjects = (projects ?? []).filter((item) => organizations?.find((candidate) => candidate.slug === org)?.id === item.organization_id);

  return (
    <Modal title="Save as report" onClose={() => !busy && close()} size="lg">
      <form className="an-save" onSubmit={(event) => void submit(event)}>
        <p>This creates a draft report with this exact receipt: priorities, rule and sources. It is visible to members of the project and does not freeze or publish anything.</p>
        <SelectField label="Organization" value={org} onChange={(value) => { setOrg(value); setProject(''); setProjects(null); }}>
          <option value="">Choose organization</option>
          {(organizations ?? []).map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
        </SelectField>
        <SelectField label="Project" value={project} onChange={setProject} disabled={!org}>
          <option value="">Choose project</option>
          {visibleProjects.map((item) => <option key={item.id} value={item.slug}>{item.name} · {item.visibility}</option>)}
        </SelectField>
        <FormField label="Title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <FormField
          label="Report address"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          mono
          required
          error={slugOk ? undefined : 'Lowercase letters, digits and single hyphens.'}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={close} disabled={busy}>Cancel</Action>
          <Action variant="primary" type="submit" busy={busy} disabled={!ready}>Save draft</Action>
        </div>
      </form>
    </Modal>
  );
}
