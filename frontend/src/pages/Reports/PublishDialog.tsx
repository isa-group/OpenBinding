import { useState, type FormEvent } from 'react';
import { platformApi, type Organization, type Project, type Publication, type Report } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { RefusalNotice } from '../Jobs/parts';
import { reportRefusal, type Refusal } from './reportErrors';
import { SLUG_PATTERN } from './reportsModel';

interface PublishDialogProps {
  organization: Organization;
  project: Project;
  report: Report;
  /** Who the citation names when nothing else is typed. */
  author: string;
  close: () => void;
  published: (publication: Publication) => void;
}

/** Publish a frozen edition: its citation, and the public address it will have. The gateway then checks that everything the edition cites is public. */
export function PublishDialog({ organization, project, report, author, close, published }: PublishDialogProps) {
  const [title, setTitle] = useState(report.title);
  const [authors, setAuthors] = useState(author);
  const [doi, setDoi] = useState('');
  const [venue, setVenue] = useState('');
  const [slug, setSlug] = useState(report.slug);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const names = authors.split(',').map((name) => name.trim()).filter(Boolean);
  const ready = title.trim() !== '' && names.length > 0 && SLUG_PATTERN.test(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setRefusal(null);
    try {
      const publication = await platformApi.publishReport(organization.slug, project.slug, {
        report_id: report.id,
        version_id: report.version_id ?? undefined,
        slug,
        citation: {
          title: title.trim(),
          authors: names,
          year: new Date().getFullYear(),
          ...(venue.trim() ? { venue: venue.trim() } : {}),
          ...(doi.trim() ? { doi: doi.trim() } : {}),
        },
      });
      published(publication);
    } catch (caught) {
      setRefusal(reportRefusal(caught, 'publish'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Publish this edition" onClose={() => !busy && close()} size="lg">
      <form className="rp-form" onSubmit={(event) => void submit(event)}>
        <ul className="rp-checks" aria-label="What the server checks">
          <li>The edition is frozen</li>
          <li>Everything it cites is in public projects</li>
          <li>The engines it used are public</li>
        </ul>
        <FormField label="Citation title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <FormField label="Authors" value={authors} onChange={(event) => setAuthors(event.target.value)} hint="Separate several with commas." required />
        <FormField label="Venue (optional)" value={venue} onChange={(event) => setVenue(event.target.value)} />
        <FormField label="DOI or link (optional)" value={doi} onChange={(event) => setDoi(event.target.value)} mono />
        <FormField
          label="Public address"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          mono
          required
          error={SLUG_PATTERN.test(slug) || slug === '' ? undefined : 'Lowercase letters, digits and single hyphens.'}
          hint="It names the publication in Explore."
        />
        {refusal && <RefusalNotice refusal={refusal} />}
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={close} disabled={busy}>Cancel</Action>
          <Action variant="primary" type="submit" busy={busy} disabled={!ready}>Publish</Action>
        </div>
      </form>
    </Modal>
  );
}
