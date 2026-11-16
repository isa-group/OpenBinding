import { Action } from '../../modules/core/components/action-button';
import { Gate } from '../../features/workspace/parts';
import { compositionsPath } from '../../routes/paths/compositions';

/**
 * The one answer for a composition that is not there and for one the account may not read: the gateway answers both the same
 * way (404), so the page does too, and never says that a composition is private.
 */
export function CompositionMissing({ org }: { org: string }) {
  return (
    <Gate
      title="No composition here, or you cannot see it"
      action={
        <Action to={compositionsPath(org)} variant="primary">
          All compositions
        </Action>
      }
    >
      The address may be mistyped, the composition may have been deleted, or it is not shared with
      you. We answer the same way in every one of these.
    </Gate>
  );
}
