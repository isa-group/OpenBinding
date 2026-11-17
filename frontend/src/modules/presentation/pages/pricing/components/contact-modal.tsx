import { Action } from '../../../../core/components/action-button';
import { Modal } from '../../../../core/components/modal';

/**
 * Paid plans are arranged by agreement and there is no channel for it in this interface: the dialog says what to bring and
 * sends nothing. (There is no contact address in the deployment's configuration to point at.)
 */
export default function ContactModal({ plan, onClose }: { plan: string; onClose: () => void }) {
  return (
    <Modal title={`Ask about ${plan}`} onClose={onClose}>
      <p>
        {plan} is arranged as an institutional agreement. An administrator updates your contract;
        nothing is charged here.
      </p>
      <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-tp-charcoal">
        <li>Who it’s for: your organization or group</li>
        <li>What you need: concurrent runs, studies, storage</li>
        <li>Add-ons you’d need</li>
      </ul>
      <p className="mt-3 rounded-xl border border-dashed border-tp-hairline-strong px-3 py-2.5 text-[13px] text-tp-slate">
        This page doesn’t send anything. Take these details to the people who run this OpenBinding
        deployment, or to your institution’s administrator.
      </p>
      <div className="mt-5 flex justify-end">
        <Action variant="primary" onClick={onClose} data-autofocus>
          Got it
        </Action>
      </div>
    </Modal>
  );
}
