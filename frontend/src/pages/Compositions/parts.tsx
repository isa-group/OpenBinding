import type { ReactNode } from 'react';
import type { Organization } from '../../api/platform';
import { OrgFrame } from '../../features/workspace/OrgFrame';
import type { Crumb } from '../../features/workspace/parts';
import '../Organization/Organization.css';
import '../../features/workspace/kit.css';
import './Compositions.css';

/** The frame of every screen of the compositions of an organization: breadcrumb and one live content column. */
export function CompositionFrame({
  organization,
  trail,
  children,
}: {
  organization: Organization;
  trail: Crumb[];
  children: ReactNode;
}) {
  return (
    <OrgFrame organization={organization} trail={trail} width="wide">
      {children}
    </OrgFrame>
  );
}
