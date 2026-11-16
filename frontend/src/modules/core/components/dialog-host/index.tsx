import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import AlertModal, { type SeverityOption } from '../alert-modal';
import ConfirmModal from '../confirm-modal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { subscribeDialogs, type DialogRequest } from '../../utils/dialog-queue';

/**
 * Where `customConfirm` and `customAlert` (utils/custom-confirm, utils/custom-alert) open. SPHERE renders them into a
 * detached React root with no focus trap and no Escape; OpenBinding keeps SPHERE's call and its markup, and mounts the
 * dialog here, inside the application's providers, one at a time, with OpenBinding's focus trap: focus moves into the
 * dialog, stays there, Escape cancels, and focus returns to what opened it. Mount it once, near the root.
 */
export default function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);

  useEffect(() => subscribeDialogs(request => setQueue(previous => [...previous, request])), []);

  const current = queue[0];
  const settle = (request: DialogRequest, confirmed: boolean) => {
    setQueue(previous => previous.filter(entry => entry !== request));
    request.settle(confirmed);
  };

  return createPortal(
    <AnimatePresence>
      {current && <Trapped key={current.id} request={current} settle={settle} />}
    </AnimatePresence>,
    document.body
  );
}

function Trapped({
  request,
  settle,
}: {
  request: DialogRequest;
  settle: (request: DialogRequest, confirmed: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onKeyDown = useFocusTrap(panel, { onEscape: () => settle(request, false) });

  return (
    <div ref={panel} onKeyDown={onKeyDown}>
      {request.kind === 'confirm' ? (
        <ConfirmModal
          message={request.message}
          danger={request.options.danger}
          confirmLabel={request.options.confirmLabel}
          cancelLabel={request.options.cancelLabel}
          onConfirm={() => settle(request, true)}
          onCancel={() => settle(request, false)}
        />
      ) : (
        <AlertModal
          message={request.message}
          severity={request.severity as SeverityOption}
          onClose={() => settle(request, true)}
        />
      )}
    </div>
  );
}
