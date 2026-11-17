import { MdAccessTime } from 'react-icons/md';
import { EmptyState } from '../../../core/components/empty-state';

/** What an about page shows while none of its entries has been reviewed into the repository. */
export default function PendingReview({ what }: { what: string }) {
  return (
    <EmptyState icon={<MdAccessTime />} title="Pending editorial review" dashed>
      Entries for {what} appear once they’re reviewed.
    </EmptyState>
  );
}
