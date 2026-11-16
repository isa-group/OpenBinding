import { useAuth } from '../../contexts/auth';
import { ProblemEditor } from '../../features/bim-editor/ProblemEditor';
import { OrgFrame, OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { problemsPath } from '../../routes/paths/problems';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { problemAccess } from './useRouteProblem';
import './Problems.css';

/**
 * The problem editor of an organization (`problem-editor`, `/app/:org/problem-editor`): write or change a BIM package, checked as
 * you go, and save it as a new problem or a new version of one. A VIEWER edits and checks, and does not save.
 */
export function ProblemEditorPage() {
  const { user } = useAuth();
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  const org = organization.slug;
  return (
    <OrgFrame organization={organization} trail={[{ label: 'Problems', to: problemsPath(org) }, { label: 'Problem editor' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Problem editor</h1>
          <p>Write a BIM package or change one: the gateway checks it as you type, and a valid package saves as a new problem or a new version of one. A saved version runs from its problem page.</p>
        </div>
      </header>
      <ProblemEditor organization={organization} canSave={problemAccess(organization).canCreate} userId={user?.id} />
    </OrgFrame>
  );
}
