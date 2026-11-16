import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { useCopy } from '../../components/ui/useCopy';
import { Gate, type Crumb } from '../../features/workspace/parts';
import '../Organization/Organization.css';
import { OrgFrame } from '../../features/workspace/OrgFrame';
import '../../features/workspace/kit.css';
import './Problems.css';

interface CaseFrameProps {
  organization: Organization;
  /** The crumbs below the organization: `Problems`, the problem, the screen. The last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of every screen of the problems of an organization: breadcrumb and one live content column. */
export function CaseFrame({ organization, trail, width = 'wide', children }: CaseFrameProps) {
  return (
    <OrgFrame organization={organization} trail={trail} width={width}>
      {children}
    </OrgFrame>
  );
}

/** The case, or the revision, isn't there: one card with the way out. */
export function CaseMissing({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Gate title={title} action={actions}>
      {children ?? ''}
    </Gate>
  );
}

/** A role that can look and not change: stated once, near the top. */
export function ReadOnlyNote({ role, children }: { role: string | null; children: ReactNode }) {
  return (
    <div className="proj-note is-info" role="note">
      <Lock aria-hidden="true" className="org-inline-icon" />
      <span>
        {role ? (
          <>
            You’re {role === 'VIEWER' ? 'a ' : 'an '}
            <strong>{role}</strong>.{' '}
          </>
        ) : null}
        {children}
      </span>
    </div>
  );
}

/** A fingerprint named in words, with a button that copies the whole of it. */
export function DigestLine({
  digest,
  label,
  copyKey,
}: {
  digest: string;
  label: string;
  copyKey: string;
}) {
  const { copy, status } = useCopy();
  return (
    <span className="case-digest">
      <span>Recorded</span>
      <button
        type="button"
        className="case-link-button"
        onClick={() => void copy(digest, copyKey)}
        aria-label={`Copy ${label} fingerprint`}
      >
        {status(copyKey) === 'copied'
          ? 'Copied'
          : status(copyKey) === 'failed'
            ? 'Copy failed'
            : 'Copy digest'}
      </button>
    </span>
  );
}
