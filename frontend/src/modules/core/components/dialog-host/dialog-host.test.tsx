import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DialogHost from '.';
import customAlert from '../../utils/custom-alert';
import customConfirm from '../../utils/custom-confirm';

function mountHost() {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  const opener = document.createElement('button');
  opener.textContent = 'Open';
  root.appendChild(opener);
  opener.focus();
  const host = document.createElement('div');
  root.appendChild(host);
  const view = render(<DialogHost />, { container: host });
  return { root, opener, ...view };
}

afterEach(() => {
  cleanup();
  document.getElementById('root')?.remove();
});

describe('DialogHost', () => {
  it('shows customAlert in the tree, labelled OK, and resolves when it is dismissed', async () => {
    mountHost();
    let done = false;
    act(() => {
      void customAlert('Saved', 'success').then(() => {
        done = true;
      });
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Saved');
    expect(screen.queryByText('Aceptar')).not.toBeInTheDocument();
    const ok = screen.getByRole('button', { name: 'OK' });
    expect(ok).toHaveFocus();
    fireEvent.click(ok);
    await waitFor(() => expect(done).toBe(true));
  });

  it('keeps focus inside, makes the app inert, cancels on Escape and gives focus back', async () => {
    const { root, opener } = mountHost();
    let outcome = '';
    act(() => {
      customConfirm('Delete it?', { danger: true }).then(
        () => (outcome = 'confirmed'),
        () => (outcome = 'cancelled')
      );
    });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    expect(root).toHaveAttribute('inert');

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(cancel, { key: 'Escape' });
    await waitFor(() => expect(outcome).toBe('cancelled'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(root).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
  });

  it('resolves customConfirm when confirmed, and shows queued dialogs one at a time', async () => {
    mountHost();
    const results: string[] = [];
    act(() => {
      void customConfirm('First?').then(() => results.push('first'));
      void customConfirm('Second?').then(() => results.push('second'));
    });
    expect(await screen.findByText('First?')).toBeInTheDocument();
    expect(screen.queryByText('Second?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Second?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(results).toEqual(['first', 'second']));
  });
});
