import { useRef, useState, type DragEvent } from 'react';
import { CheckCircle2, TriangleAlert, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import { platformApi, type Organization, type Project, type StoredBlob } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { shortDigest } from '../../utils/digest';
import { formatByteSize, formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { RoleChip } from '../Organization/parts';
import { saveBytes } from '../Project/download';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { ProjectAccess } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { ConfirmDialog, ZipPeekDialog } from './dialogs';
import { Meter, ResourceFrame } from './parts';
import { classifyAuthError, deleteFileRefusal, downloadRefusal, filesListRefusal, oversizeRefusal, uploadRefusal, type Refusal } from './resourceErrors';
import { allowanceOf, downloadName, fileTitle, isZipFile, totalBytes, typeLabel, uploadCeiling, type SessionNames } from './resourceModel';
import { useSponsorUsage, type SponsorUsage } from './useSponsorUsage';

function FileRow({ file, names, canDelete, copied, copyFailed, downloaded, downloading, onCopy, onDownload, onPeek, onDelete }: {
  file: StoredBlob; names: SessionNames; canDelete: boolean; copied: boolean; copyFailed: boolean; downloaded: boolean; downloading: boolean;
  onCopy: () => void; onDownload: () => void; onPeek: () => void; onDelete: () => void;
}) {
  const title = fileTitle(file, names);
  const added = formatDate(file.created_at);
  return (
    <tr>
      <th scope="row" className="res-file-cell">
        <span className="res-file-name">
          <strong>{title}</strong>
          <small>
            {names[file.digest] ? 'Uploaded in this visit' : added ? `Added ${added}` : 'Stored'} · {file.public ? 'Public by fingerprint' : 'Private to members'}
          </small>
        </span>
      </th>
      <td title={file.media_type}>{typeLabel(file.media_type)}</td>
      <td title={`${file.size_bytes.toLocaleString('en-US')} bytes`}>{formatByteSize(file.size_bytes)}</td>
      <td>
        <button type="button" className="res-fingerprint" title={file.digest} onClick={onCopy} aria-label={`Copy fingerprint of ${title}`}>
          {copied ? 'copied' : copyFailed ? 'copy failed' : shortDigest(file.digest)}
        </button>
      </td>
      <td>
        <span className="res-row-actions">
          {isZipFile(file) && <Action variant="secondary" size="sm" onClick={onPeek} aria-label={`Look inside ${title}`}>Look inside</Action>}
          <Action variant="secondary" size="sm" busy={downloading} onClick={onDownload} aria-label={`Download ${title}`}>{downloaded ? 'Downloaded' : 'Download'}</Action>
          {canDelete && <Action variant="danger-outline" size="sm" onClick={onDelete} aria-label={`Delete ${title}`}>Delete</Action>}
        </span>
      </td>
    </tr>
  );
}

function Storage({ sponsor, files }: { sponsor: SponsorUsage; files: readonly StoredBlob[] }) {
  const { isSponsor, usage, loading } = sponsor;
  const allowance = allowanceOf(usage, 'storageBytes', isSponsor);
  const here = totalBytes(files);
  const limit = allowance.limit;
  const used = allowance.used ?? here;
  const percent = limit ? (used / limit) * 100 : 0;
  const full = limit !== null && used >= limit;
  const renewal = 'Doesn’t renew; frees up when files are deleted.';
  let text: string;
  if (loading) text = 'Reading the allowance…';
  else if (!allowance.known) text = `${formatByteSize(here)} in this project. The sponsor’s allowance isn’t shown to you. ${renewal}`;
  else if (limit === null) text = `${formatByteSize(here)} in this project. Your plan sets no storage limit.`;
  else if (allowance.used !== null) text = `${formatByteSize(used)} of ${formatByteSize(limit)} used across your organizations. ${renewal}`;
  else text = `${formatByteSize(here)} in this project; your allowance is ${formatByteSize(limit)} across all your organizations. ${renewal}`;
  return (
    <section className="res-allowance" aria-labelledby="files-storage">
      <div className="res-allowance-main">
        <strong id="files-storage">Storage · sponsored by {isSponsor ? 'you' : 'another account'}</strong>
        {allowance.known && limit !== null && (
          <Meter label="Storage used" percent={percent} full={full} valueText={`${formatByteSize(used)} of ${formatByteSize(limit)}`} />
        )}
        <span className="res-allowance-note">{text}</span>
      </div>
    </section>
  );
}

function FilesBody({ organization, project, access }: { organization: Organization; project: Project; access: ProjectAccess }) {
  const slug = organization.slug;
  const root = `/app/${slug}/${project.slug}`;
  const picker = useRef<HTMLInputElement>(null);
  const { copy, status } = useCopy();
  const sponsor = useSponsorUsage(organization);
  const { usage, plan } = sponsor;
  const ceiling = uploadCeiling(usage, null, plan);
  const [names, setNames] = useState<SessionNames>({});
  const [toast, setToast] = useState('');
  const [problem, setProblem] = useState<Refusal | null>(null);
  const [uploading, setUploading] = useState('');
  const [dragging, setDragging] = useState(false);
  const [makePublic, setMakePublic] = useState(false);
  const [removing, setRemoving] = useState<StoredBlob | null>(null);
  const [peeking, setPeeking] = useState<StoredBlob | null>(null);
  const [downloading, setDownloading] = useState('');
  const [downloaded, setDownloaded] = useState('');
  const files = useResource(`files:${slug}/${project.slug}`, () => platformApi.artifacts(slug, project.slug));
  const list = files.data ?? [];
  const failure = files.status === 'error' ? classifyAuthError(files.error) : null;
  const keyCannotWrite = problem?.kind === 'key';
  const canUpload = access.canCreate && !keyCannotWrite;
  const planName = usage?.plan ?? plan;

  const upload = async (chosen: File[]) => {
    if (!chosen.length || uploading || !canUpload) return;
    setProblem(null);
    setToast('');
    let stored = 0;
    let lastName = '';
    for (const file of chosen) {
      if (ceiling.plan !== null && file.size > ceiling.effective) {
        setProblem(oversizeRefusal(file.name, file.size, ceiling.effective, planName));
        break;
      }
      setUploading(file.name);
      try {
        const saved = await platformApi.uploadArtifact(slug, project.slug, file, makePublic);
        setNames((current) => ({ ...current, [saved.digest]: file.name }));
        stored += 1;
        lastName = file.name;
      } catch (caught) {
        setProblem(uploadRefusal(caught, { ceiling: ceiling.effective, plan: planName }));
        break;
      }
    }
    setUploading('');
    if (stored > 0) {
      setToast(stored === 1 ? `Uploaded “${lastName}”. Copy its fingerprint to reference it.` : `Uploaded ${stored} files. Copy a fingerprint to reference one.`);
      files.reload();
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void upload(Array.from(event.dataTransfer.files));
  };

  const download = async (file: StoredBlob) => {
    if (downloading) return;
    setDownloading(file.digest);
    setProblem(null);
    setToast('');
    setDownloaded('');
    try {
      saveBytes(await platformApi.downloadArtifact(slug, project.slug, file.digest), downloadName(file, names), file.media_type);
      setDownloaded(file.digest);
    } catch (caught) {
      setProblem(downloadRefusal(caught, fileTitle(file, names)));
    } finally {
      setDownloading('');
    }
  };

  return (
    <ResourceFrame organization={organization} project={project} section="files" trail={[{ label: 'Files' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Files</h1>
          <p>Plain files stored by their fingerprint. Uploading the same file twice keeps one copy. Files aren’t library items.</p>
        </div>
      </header>

      {!access.publicRead && <Storage sponsor={sponsor} files={list} />}

      {keyCannotWrite && problem && <Notice tone="warning">{problem.text}</Notice>}
      {!access.canCreate && <ReadOnlyNote role={access.role}>You can download files; uploading needs MEMBER and deleting needs ADMIN.</ReadOnlyNote>}
      {canUpload && (
        <div
          className={`proj-drop res-drop${dragging ? ' is-over' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Upload aria-hidden="true" />
          <strong>Drop files to upload</strong>
          <span>
            {ceiling.plan !== null ? `Up to ${formatByteSize(ceiling.effective)} each${planName ? ` on the ${planName} plan` : ''}` : `Up to ${formatByteSize(ceiling.effective)} each, the gateway’s own limit`}
          </span>
          <div className="res-drop-row">
            <input
              ref={picker}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-label="Files to upload"
              onChange={(event) => { const chosen = Array.from(event.target.files ?? []); event.target.value = ''; void upload(chosen); }}
            />
            <Action variant="secondary" onClick={() => picker.current?.click()} busy={Boolean(uploading)}>Choose files</Action>
            <label className="res-public">
              <input type="checkbox" checked={makePublic} onChange={(event) => setMakePublic(event.target.checked)} />
              Readable by anyone with the fingerprint
            </label>
          </div>
        </div>
      )}
      {uploading && <div className="res-uploading" role="status"><span className="org-spinner" aria-hidden="true" />Uploading and fingerprinting {uploading}…</div>}
      {problem && !keyCannotWrite && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" /><span>{problem.text}</span>{problem.kind === 'quota' && <Link to="/app/account/usage">See your plan</Link>}</div>}
      {toast && <div className="org-toast" role="status"><CheckCircle2 aria-hidden="true" /><span>{toast}</span></div>}

      {files.status === 'loading' && <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading files…</span><Skeleton variant="panel" /></div>}
      {failure && (
        <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={failure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={files.reload}>Retry</Action>}>
          {filesListRefusal(failure).text}
        </Notice>
      )}
      {files.status === 'ready' && list.length === 0 && (
        <section className="lib-dashed lib-nothing" aria-labelledby="files-empty">
          <strong id="files-empty">No files yet</strong>
          <span>Upload a result or a dataset. Each file is kept by its fingerprint, so anyone can check it is the one you cite.</span>
        </section>
      )}
      {list.length > 0 && (
        <DataTable label="Files" minWidth={720}>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Type</th>
              <th scope="col">Size</th>
              <th scope="col">Fingerprint</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                names={names}
                canDelete={access.canAdminister}
                copied={status(file.digest) === 'copied'}
                copyFailed={status(file.digest) === 'failed'}
                downloaded={downloaded === file.digest}
                downloading={downloading === file.digest}
                onCopy={() => void copy(file.digest, file.digest)}
                onDownload={() => void download(file)}
                onPeek={() => setPeeking(file)}
                onDelete={() => { setProblem(null); setRemoving(file); }}
              />
            ))}
          </tbody>
        </DataTable>
      )}
      {access.publicRead ? (
        <p className="org-muted">Only the files this project has made public are listed. Anyone can download them.</p>
      ) : (
        <p className="org-muted">
          {access.role && <>Your role here: <RoleChip role={access.role} />. </>}
          Project packages carry the files they refer to. <Link to={`${root}/package`}>Export or import a package</Link>.
        </p>
      )}
      {list.some((file) => file.public) && <p className="lib-footnote"><Chip tone="accent">Public by fingerprint</Chip> files can be read by anyone who knows their fingerprint.</p>}

      {removing && (
        <ConfirmDialog
          title={`Delete ${fileTitle(removing, names)}?`}
          confirmLabel="Delete file"
          onClose={() => setRemoving(null)}
          run={() => platformApi.deleteArtifact(slug, project.slug, removing.digest)}
          refusal={(caught) => deleteFileRefusal(caught, fileTitle(removing, names)).text}
          onDone={() => {
            setToast(`“${fileTitle(removing, names)}” deleted.`);
            setRemoving(null);
            files.reload();
          }}
        >
          <p>The file leaves {project.name}. This can’t be undone; upload the same bytes again to get the same fingerprint back.</p>
        </ConfirmDialog>
      )}
      {peeking && <ZipPeekDialog title={fileTitle(peeking, names)} load={() => platformApi.downloadArtifact(slug, project.slug, peeking.digest)} onClose={() => setPeeking(null)} />}
    </ResourceFrame>
  );
}

/** Project files (`proj-files`, `/app/:org/:project/files`): the files the project stores by fingerprint, to list, upload, download and delete. */
export function ProjFiles() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <FilesBody organization={organization} project={project} access={access} />;
}
