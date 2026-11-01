import { platformApi } from '../../api/platform';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { personInitials } from '../../utils/initials';
import { useResource } from '../../utils/useResource';
import { RoleChip } from '../Organization/parts';
import { ProjectSettingsLayout } from './ProjectSettingsLayout';
import './Project.css';

/**
 * The section Members of the project settings: the people of the project’s organization, who are the people with access to the
 * project, and the way to the organization’s member settings, where they are managed.
 */
// [impl->req~frontend-nav-project-tabs~1]
export function ProjectMembers({ organization, project }: { organization: Organization; project: Project }) {
  const slug = organization.slug;
  const people = useResource(`project-members:${slug}`, () => platformApi.members(slug));

  return (
    <ProjectSettingsLayout organization={organization} project={project} section="members">
      <section className="org-section" aria-labelledby="pm-members">
        <div>
          <h2 id="pm-members">Members</h2>
          <p className="org-muted">
            The members of {organization.name} have access to {project.name}. Their roles are set for the whole organization.
          </p>
        </div>
        <div className="org-card org-stack">
          {people.status === 'loading' && <Skeleton variant="tile" />}
          {people.status === 'error' && (
            <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={people.reload}>Retry</Action>}>
              The members couldn’t be loaded.
            </Notice>
          )}
          {people.status === 'ready' && (people.data && people.data.length > 0 ? (
            <ul className="proj-members" aria-label={`Members of ${organization.name}`}>
              {people.data.map((member) => {
                const name = member.username ?? member.email ?? member.user_id;
                return (
                  <li key={member.id}>
                    <span className="proj-member-initials" aria-hidden="true">{personInitials(name)}</span>
                    <span className="proj-member-name"><strong>{name}</strong>{member.email && member.email !== name && <small>{member.email}</small>}</span>
                    <RoleChip role={member.role} />
                  </li>
                );
              })}
            </ul>
          ) : <span className="org-muted">Nobody has a role in {organization.name} yet.</span>)}
          <div className="proj-buttons">
            <Action to={`/app/${slug}/settings/members`} variant="secondary">Manage members</Action>
          </div>
        </div>
      </section>
    </ProjectSettingsLayout>
  );
}
