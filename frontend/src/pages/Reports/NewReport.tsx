import { useState, type FormEvent } from 'react';
import { platformApi, type Organization, type Project, type Report } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../Organization/parts';
import type { StudyContent } from '../Project/projectModel';
import { RefusalNotice } from '../Jobs/parts';
import { reportRefusal, type Refusal } from './reportErrors';
import { SLUG_PATTERN, slugOf } from './reportsModel';

interface NewReportProps {
  organization: Organization;
  project: Project;
  studies: readonly StudyContent[];
  close: () => void;
  created: (report: Report) => void;
}

/** A draft report: a title, an address, and optionally the study run it is about, whose identity then starts its provenance. */
export function NewReport({ organization, project, studies, close, created }: NewReportProps) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [edited, setEdited] = useState(false);
  const [run, setRun] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const address = edited ? slug : slugOf(title);
  const addressOk = SLUG_PATTERN.test(address);
  const runs = studies.flatMap(({ study, runs: list }) => list.map((item) => ({ run: item, label: `${study.name} · run #${item.run_number} · ${item.state}` })));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !addressOk) return;
    const pinned = runs.find((item) => item.run.id === run)?.run;
    setBusy(true);
    setRefusal(null);
    try {
      const report = await platformApi.createReport(organization.slug, project.slug, {
        slug: address,
        title: title.trim(),
        study_run_id: pinned?.id ?? null,
        document: {
          blocks: [{ type: 'heading', text: title.trim() }],
          provenance: pinned ? { study: { runId: pinned.id, matrixDigest: pinned.matrix_digest } } : {},
        },
      });
      created(report);
    } catch (caught) {
      setRefusal(reportRefusal(caught, 'create'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New report" onClose={() => !busy && close()} size="lg">
      <form className="rp-form" onSubmit={(event) => void submit(event)}>
        <p>Start a draft. Freezing it later makes an edition that never changes; publishing makes that edition public and citable.</p>
        <FormField label="Title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <FormField
          label="Address"
          value={address}
          onChange={(event) => { setSlug(event.target.value); setEdited(true); }}
          mono
          required
          error={address === '' || addressOk ? undefined : 'Lowercase letters, digits and single hyphens.'}
          hint="It names the report in links."
        />
        <SelectField label="Study run" value={run} onChange={setRun} hint="Optional. A pinned run is cited as the evidence of the report.">
          <option value="">No run pinned</option>
          {runs.map((item) => <option key={item.run.id} value={item.run.id}>{item.label}</option>)}
        </SelectField>
        {refusal && <RefusalNotice refusal={refusal} />}
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={close} disabled={busy}>Cancel</Action>
          <Action variant="primary" type="submit" busy={busy} disabled={!title.trim() || !addressOk}>Create draft</Action>
        </div>
      </form>
    </Modal>
  );
}
