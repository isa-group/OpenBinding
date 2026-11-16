import { describe, expect, it, vi } from 'vitest';
import { changedMessage, isChangedError, offerReloadIfChanged } from './offer-reload';
import { subscribeDialogs, type DialogRequest } from './dialog-queue';

describe('offerReloadIfChanged', () => {
  it('recognises a 412 and the precondition_failed refusal, nothing else', () => {
    expect(isChangedError({ status: 412 })).toBe(true);
    expect(isChangedError({ code: 'precondition_failed', status: 412 })).toBe(true);
    expect(isChangedError({ status: 409 })).toBe(false);
    expect(isChangedError(null)).toBe(false);
  });

  it('leaves other errors to the caller', () => {
    expect(offerReloadIfChanged(new Error('boom'))).toBe(false);
  });

  it('asks to reload, naming the resource, and reloads when accepted', async () => {
    const requests: DialogRequest[] = [];
    const stop = subscribeDialogs(request => requests.push(request));
    const reload = vi.fn();
    expect(offerReloadIfChanged({ status: 412 }, { resource: 'this composition', reload })).toBe(
      true
    );
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.message).toBe(changedMessage('this composition'));
    expect(request.kind === 'confirm' && request.options.confirmLabel).toBe('Reload');
    request.settle(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    stop();
  });

  it('does nothing more when the reload is declined', async () => {
    const requests: DialogRequest[] = [];
    const stop = subscribeDialogs(request => requests.push(request));
    const reload = vi.fn();
    offerReloadIfChanged({ code: 'precondition_failed' }, { reload });
    requests[0].settle(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reload).not.toHaveBeenCalled();
    stop();
  });
});
