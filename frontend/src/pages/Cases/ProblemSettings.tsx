import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { casesApi } from '../../api/cases';
import type { BindingCase, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { updateRefusal } from './caseErrors';
import { DESCRIPTION_MAX, NAME_MAX } from './casesModel';
import { DeleteCaseDialog } from './dialogs';

/** The Settings tab of the problem page: the name and the description, and deleting the problem. */
// [impl->req~frontend-nav-problem-page~1]
export function ProblemSettings({ organization, project, item, sealed, canEdit, canAdminister, onSaved, onDeleted }: {
  organization: Organization; project: Project; item: BindingCase; sealed: number;
  /** MEMBER or above: the name and the description change; the page already says what a role below it can do. */
  canEdit: boolean; canAdminister: boolean; onSaved: () => void; onDeleted: (name: string) => void;
}) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const unchanged = name.trim() === item.name && description.trim() === item.description;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await casesApi.updateCase(organization.slug, project.slug, item.slug, { name: name.trim(), description: description.trim() });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(updateRefusal(caught).text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="org-section" aria-labelledby="ps-details">
        <h2 id="ps-details">Name and description</h2>
        <form className="case-description-form" onSubmit={(event) => void save(event)} noValidate>
          <FormField label="Name" value={name} maxLength={NAME_MAX} disabled={!canEdit} onChange={(event) => { setName(event.target.value); setSaved(false); }} error={name.trim() ? undefined : 'A problem needs a name.'} />
          <div className="ui-field">
            <label htmlFor="case-description">Description</label>
            <textarea id="case-description" className="proj-textarea" rows={3} maxLength={DESCRIPTION_MAX} disabled={!canEdit} value={description} onChange={(event) => { setDescription(event.target.value); setSaved(false); }} />
          </div>
          {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
          {saved && <span className="org-muted" role="status">Saved.</span>}
          {canEdit && (
            <span className="proj-buttons">
              <Action type="submit" variant="primary" size="sm" busy={busy} disabled={unchanged || !name.trim()}>Save</Action>
            </span>
          )}
        </form>
      </section>

      {canAdminister && (
        <section className="org-section" aria-labelledby="ps-delete">
          <h2 id="ps-delete">Delete</h2>
          <p className="org-muted">A problem with sealed revisions can’t be deleted, because revisions are history.</p>
          <div className="proj-actions"><Action variant="danger-outline" onClick={() => setDeleting(true)}>Delete case</Action></div>
        </section>
      )}

      {deleting && (
        <DeleteCaseDialog organization={organization} project={project} item={item} sealed={sealed} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
      )}
    </>
  );
}
