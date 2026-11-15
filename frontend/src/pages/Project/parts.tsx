import type { Visibility } from '../../api/platform';
import { Chip } from '../../components/ui/Chip';
import { visibilityLabel } from './projectModel';
import './Project.css';

export function VisibilityChip({ visibility }: { visibility: Visibility }) {
  return <Chip tone={visibility === 'public' ? 'success' : 'plain'}>{visibilityLabel(visibility)}</Chip>;
}
