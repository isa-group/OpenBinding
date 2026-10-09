import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  CircleDashed, Eye, FileArchive, FileText, Globe2, LockKeyhole, Plus, Trash2,
} from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import type { Publication, Report } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { EntityDrawer } from '../../components/Inspection/EntityDrawer';
import '../../components/Inspection/VisualEffects.css';
import './PlatformPages.css';

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="observatory-empty"><CircleDashed aria-hidden="true" /><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function PageHeading({ eyebrow, title, detail, action }: {
  eyebrow: string; title: string; detail: string; action?: ReactNode;
}) {
  return <header className="platform-page-heading"><div><span>{eyebrow}</span><h1>{title}</h1><p>{detail}</p></div>{action}</header>;
}

// The Home (app-home), the organization screens (org-*), the project screens (proj-*), the case screens (case-*, snap-detail), the
// files, resources and collections, the executions (job-*) and the studies (study-*) live in pages/AppHome, pages/Organization, pages/Project,
// pages/Cases, pages/Resources, pages/Jobs and pages/Studies. What stays here is the list of reports, until the task that rebuilds it replaces it.

/** What the pages of a project show when the workspace has no project to open: the way to the new-project screen. */
function NoProject() {
  const context = useOutletContext<PlatformOutletContext>();
  if (context.loading) return <div className="route-loading" role="status"><span className="status-dot" aria-hidden="true" /> Loading workspace…</div>;
  if (!context.organization) return <div className="platform-page"><Empty title="No organization yet" detail="Create an organization from the activity page first." /></div>;
  return <div className="platform-page"><PageHeading eyebrow={context.organization.name} title="Create a first project" detail="Projects isolate cases, studies, artifacts and permissions." action={<Link className="platform-primary-action" to={`/app/${context.organization.slug}/new-project`}><Plus aria-hidden="true" />New project</Link>} /></div>;
}

// The project files (`proj-files`) live in pages/Resources; this is the list of reports until the task that rebuilds it replaces it.
export function ProjectRecordsPage({ kind }: { kind: 'reports' }) {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [reports, setReports] = useState<Report[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [runOptions, setRunOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [inspectReport, setInspectReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!organization || !project) return;
    setLoading(true);
    try {
      const [nextReports, nextStudies, nextPublications] = await Promise.all([
        platformApi.reports(organization.slug, project.slug),
        platformApi.studies(organization.slug, project.slug, true),
        platformApi.publications(organization.slug, project.slug),
      ]);
      setReports(nextReports);
      setPublications(nextPublications);
      const nested = await Promise.all(
        nextStudies.map(async (study) =>
          (await platformApi.studyRuns(organization.slug, project.slug, study.slug)).map((run) => ({
            id: run.id,
            label: `${study.name} · run ${run.run_number} · ${run.state}`,
          }))
        )
      );
      setRunOptions(nested.flat());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `The ${kind} could not be loaded.`);
    } finally {
      setLoading(false);
    }
  }, [organization, project, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!organization || !project) return <NoProject />;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setBusy('create');
    try {
      const document = JSON.parse(String(form.get('document'))) as Record<string, unknown>;
      await platformApi.createReport(organization.slug, project.slug, {
        title: String(form.get('title')),
        slug: String(form.get('slug')),
        study_run_id: String(form.get('run') || '') || null,
        document,
      });
      event.currentTarget.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report creation failed.');
    } finally {
      setBusy(null);
    }
  };

  const freeze = async (report: Report) => {
    setBusy(report.id);
    setError(null);
    try {
      await platformApi.freezeReport(organization.slug, project.slug, report.slug);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report could not be frozen.');
    } finally {
      setBusy(null);
    }
  };

  const publish = async (report: Report) => {
    setBusy(report.id);
    setError(null);
    try {
      await platformApi.publishReport(organization.slug, project.slug, {
        report_id: report.id,
        slug: report.slug,
        citation: { title: report.title, digest: report.digest },
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report could not be published.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="platform-page">
      <PageHeading
        eyebrow="Reproducibility"
        title="Reports"
        detail="Freeze a human-readable analysis with exact BIM, engine, dataset and parameter provenance."
      />
      {error && <p className="platform-form-error" role="alert">{error}</p>}

      {loading && <p className="record-loading" role="status">Reading {kind}…</p>}

      <div className="record-ledger">
        {reports.map((item) => {
              const publication = publications.find((candidate) => candidate.report_id === item.id);
              return (
                <article
                  key={item.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setInspectReport(item)}
                  title="Click to inspect report document and provenance"
                >
                  <FileArchive />
                  <div>
                    <span className={`hash-badge ${item.state === 'frozen' ? 'glow-completed' : 'glow-running'}`}>
                      {publication ? 'published' : item.state}
                    </span>
                    <h2>
                      <Link
                        to={`/app/${organization.slug}/${project.slug}/reports/${item.slug}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                        onClick={(e) => e.stopPropagation()}
                        title="Open full dedicated report view"
                      >
                        {item.title}
                      </Link>
                    </h2>
                    <code>{item.digest ? `${item.digest.slice(0, 24)}…` : 'Unfrozen draft'}</code>
                  </div>
                  <small>{new Date(item.created_at).toLocaleDateString()}</small>
                  <div className="record-actions" onClick={(e) => e.stopPropagation()}>
                    <Link
                      to={`/app/${organization.slug}/${project.slug}/reports/${item.slug}`}
                      className="hash-badge"
                      style={{ textDecoration: 'none', padding: '4px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                      title="Open dedicated full page report view"
                    >
                      <FileText size={12} /> Full View
                    </Link>
                    <button
                      type="button"
                      onClick={() => setInspectReport(item)}
                      title="Inspect details and document"
                    >
                      <Eye size={13} aria-hidden="true" /> Inspect
                    </button>
                    {item.state === 'draft' && (
                      <button disabled={busy === item.id} onClick={() => void freeze(item)}>
                        <LockKeyhole size={13} aria-hidden="true" /> Freeze
                      </button>
                    )}
                    {item.state === 'frozen' && !publication && (
                      <button disabled={busy === item.id} onClick={() => void publish(item)}>
                        <Globe2 aria-hidden="true" /> Publish
                      </button>
                    )}
                    {publication && (
                      <span className="hash-badge" style={{ color: 'var(--color-accent)' }}>
                        <Globe2 aria-hidden="true" size={13} /> /{publication.slug}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
      </div>

      {!loading && !reports.length && (
        <Empty title="No reports yet" detail="Create a report from a study run, then freeze it before publication." />
      )}

      <details className="report-builder">
        <summary>
          <Plus aria-hidden="true" /> Draft report
        </summary>
        <form onSubmit={create}>
          <label>
            Title
            <input name="title" required />
          </label>
          <label>
            Slug
            <input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
          </label>
          <label>
            Study run
            <select name="run" defaultValue="">
              <option value="">No run pinned</option>
              {runOptions.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.label}
                </option>
              ))}
            </select>
          </label>
          <label className="report-document">
            Report document (JSON)
            <textarea
              name="document"
              rows={8}
              required
              spellCheck={false}
              defaultValue={'{\n  "summary": "",\n  "findings": [],\n  "provenance": {}\n}'}
            />
          </label>
          <button disabled={busy === 'create'}>
            {busy === 'create' ? 'Creating…' : 'Create draft'}
          </button>
        </form>
      </details>

      {/* Slide-over Drawer for Report */}
      {inspectReport && (() => {
        const pub = publications.find((c) => c.report_id === inspectReport.id);
        const isDraft = inspectReport.state === 'draft';
        const actionsList: Array<{
          label: string;
          icon?: ReactNode;
          onClick: () => Promise<void>;
          variant?: 'primary' | 'secondary' | 'danger';
          disabled?: boolean;
          title?: string;
        }> = [];

        if (isDraft) {
          actionsList.push({
            label: busy === inspectReport.id ? 'Freezing…' : 'Freeze Report',
            icon: <LockKeyhole size={13} />,
            variant: 'primary',
            disabled: busy === inspectReport.id,
            title: 'Freeze report with exact immutable provenance',
            onClick: async () => {
              await freeze(inspectReport);
              setInspectReport(null);
            },
          });
        } else if (!pub) {
          actionsList.push({
            label: busy === inspectReport.id ? 'Publishing…' : 'Publish Report',
            icon: <Globe2 size={13} />,
            variant: 'primary',
            disabled: busy === inspectReport.id,
            title: 'Publish frozen report to public ledger',
            onClick: async () => {
              await publish(inspectReport);
              setInspectReport(null);
            },
          });
        }

        if (pub) {
          actionsList.push({
            label: 'Delete Publication',
            icon: <Trash2 size={13} />,
            variant: 'danger',
            title: 'Remove public publication link for this report',
            onClick: async () => {
              if (window.confirm(`Permanently unpublish / delete publication "${pub.slug}"?`)) {
                await platformApi.deletePublication(organization.slug, project.slug, pub.slug);
                await load();
                setInspectReport(null);
              }
            },
          });
        }

        return (
          <EntityDrawer
            isOpen={Boolean(inspectReport)}
            onClose={() => setInspectReport(null)}
            title={inspectReport.title}
            subtitle={`Report Slug: ${inspectReport.slug}`}
            fullPageUrl={`/app/${organization.slug}/${project.slug}/reports/${inspectReport.slug}`}
            badge={{
              label: pub ? 'PUBLISHED' : inspectReport.state.toUpperCase(),
              variant: inspectReport.state === 'frozen' ? 'completed' : 'running',
            }}
            metadata={[
              { label: 'Slug', value: inspectReport.slug },
              { label: 'Title', value: inspectReport.title },
              { label: 'State', value: pub ? 'Published' : inspectReport.state },
              {
                label: 'Digest',
                value: inspectReport.digest ? (
                  <code className="hash-badge" title={inspectReport.digest}>
                    {inspectReport.digest.slice(0, 20)}…
                  </code>
                ) : (
                  'Draft (unfrozen)'
                ),
              },
              { label: 'Pinned Study Run', value: inspectReport.study_run_id || 'None pinned' },
              { label: 'Created At', value: new Date(inspectReport.created_at).toLocaleString() },
              ...(pub
                ? [
                    { label: 'Publication Slug', value: `/${pub.slug}` },
                    { label: 'Publication DOI', value: (pub.citation?.doi as string | undefined) || 'None' },
                  ]
                : []),
            ]}
            jsonDocument={inspectReport.document}
            editable={
              isDraft
                ? {
                    fields: [
                      { key: 'title', label: 'Report Title', initialValue: inspectReport.title },
                      {
                        key: 'document',
                        label: 'Report Document (JSON)',
                        type: 'textarea',
                        initialValue: JSON.stringify(inspectReport.document, null, 2),
                      },
                    ],
                    onSave: async (vals) => {
                      await platformApi.updateReport(organization.slug, project.slug, inspectReport.slug, {
                        title: vals.title,
                        document: JSON.parse(vals.document) as Record<string, unknown>,
                      });
                      await load();
                    },
                  }
                : undefined
            }
            deletable={{
              confirmMessage: `Permanently delete report "${inspectReport.title}"?`,
              onDelete: async () => {
                await platformApi.deleteReport(organization.slug, project.slug, inspectReport.slug);
                await load();
              },
            }}
            actions={actionsList}
          />
        );
      })()}
    </div>
  );
}
