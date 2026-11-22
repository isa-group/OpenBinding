// Mark an upstream event reviewed (F6): the one write a person makes on an event, once, with an optional note of at most
// 1000 characters that is never edited afterwards. Drawn as the adopt dialog is (OpenBinding's modal on SPHERE's fork-modal
// recipe, pattern only): the note, then Cancel and the primary action. The review names the event's revision as
// `If-Match` (read with the detail): a 412 says the event changed and offers to read it again, a 409 says it was already
// reviewed (or resolved meanwhile) and reads it again. There is no "resolve": an event is resolved only by sealing a
// version that pins the new pricing.

import { useState, type FormEvent } from 'react';
import { readApiError } from '../../../core/api/errors';
import type { UpstreamEventDetail } from '../../../core/api/types';
import { Modal } from '../../../core/components/modal';
import { TextAreaField } from '../../../core/components/select-field';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import { eventHeadline } from '../../../core/utils/composition/upstreamEvents';
import { useUpstreamEventsApi } from '../../api/upstreamEventsApi';

/** The longest note the gateway keeps. */
const NOTE_LIMIT = 1000;

interface Props {
  org: string;
  composition: string;
  event: UpstreamEventDetail;
  /** The event's `ETag`, as its detail read it. */
  etag: string | null;
  onClose: () => void;
  /** Reviewed, or found changed: the detail reads the event again. */
  onChanged: () => void;
}

export default function ReviewEventDialog({
  org,
  composition,
  event,
  etag,
  onClose,
  onChanged,
}: Props) {
  const api = useUpstreamEventsApi();
  const { addToast } = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ text: string; reload: boolean } | null>(null);

  const submit = async (submitted: FormEvent) => {
    submitted.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await api.review(org, composition, event.id, note.trim(), etag);
      addToast({ kind: SYSTEM_TOAST, title: `${eventHeadline(event)} marked reviewed.` });
      onChanged();
    } catch (caught) {
      setBusy(false);
      const error = readApiError(caught);
      if (error.status === 412)
        setRefusal({ text: 'This event changed; read it again.', reload: true });
      else if (error.status === 409) {
        addToast({ kind: SYSTEM_TOAST, title: 'Already reviewed.' });
        onChanged();
      } else
        setRefusal({
          text: error.message || 'The event couldn’t be marked reviewed.',
          reload: false,
        });
    }
  };

  return (
    <Modal title="Mark reviewed" onClose={() => !busy && onClose()} dismissible={!busy}>
      <form onSubmit={event => void submit(event)} noValidate className="flex flex-col gap-4">
        <p className="m-0 text-sm text-tp-slate">
          {`${eventHeadline(event)}. Reviewing says a person has seen it; nothing else changes, and the note can’t be edited later.`}
        </p>
        <TextAreaField
          label="Note"
          value={note}
          onChange={change => setNote(change.target.value)}
          maxLength={NOTE_LIMIT}
          rows={3}
          placeholder="What you decided, for whoever reads this event next"
          hint={`${note.length} of ${NOTE_LIMIT} characters`}
          disabled={busy}
        />
        <div aria-live="assertive">
          {refusal && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-700">
              <span>{refusal.text}</span>
              {refusal.reload && (
                <button
                  type="button"
                  onClick={onChanged}
                  className="cursor-pointer rounded-md border border-red-300 px-2 py-1 font-medium"
                >
                  Read it again
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-xs font-medium text-tp-ink hover:bg-tp-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="cursor-pointer rounded-lg bg-tp-primary px-4 py-2 text-xs font-semibold text-white hover:bg-tp-primary/90 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? 'Marking…' : 'Mark reviewed'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
