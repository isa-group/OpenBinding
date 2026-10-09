import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Action } from './Action';
import { FormField } from './FormField';
import { Modal } from './Modal';
import { Switch } from './Switch';

function Harness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal title="Sure?" onClose={() => setOpen(false)} dismissible={dismissible} tone="danger">
          <input aria-label="Name" />
          <button type="button">Ok</button>
        </Modal>
      )}
    </>
  );
}

function openDialog() {
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('Modal', () => {
  it('is a named modal dialog that takes focus on its first field', () => {
    render(<Harness />);
    openDialog();

    const dialog = screen.getByRole('dialog', { name: 'Sure?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('keeps Tab inside, wrapping from the last control to the first and back', () => {
    render(<Harness />);
    openDialog();
    const close = screen.getByRole('button', { name: 'Close' });
    const ok = screen.getByRole('button', { name: 'Ok' });

    ok.focus();
    fireEvent.keyDown(ok, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(ok).toHaveFocus();
  });

  it('closes on Escape and gives focus back to what opened it', () => {
    render(<Harness />);
    const opener = openDialog();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes from the × button', () => {
    render(<Harness />);
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cannot be dismissed by accident when it is not dismissible', () => {
    render(<Harness dismissible={false} />);
    openDialog();

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('FormField', () => {
  it('ties its label, hint and error to the input', () => {
    const { rerender } = render(<FormField label="Email address" hint="Used to log in." defaultValue="a@b.test" />);
    const input = screen.getByLabelText('Email address');
    expect(input).toHaveAccessibleDescription('Used to log in.');
    expect(input).not.toHaveAttribute('aria-invalid');

    rerender(<FormField label="Email address" hint="Used to log in." defaultValue="a@b.test" error="Enter a valid email address." />);
    expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email address')).toHaveAccessibleDescription('Enter a valid email address.');
  });
});

describe('Switch', () => {
  it('reports its state as a switch and asks for the opposite when pressed', () => {
    const onChange = vi.fn();
    render(<Switch label="Email me about contract changes" checked onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Email me about contract changes' });
    expect(control).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('Action', () => {
  it('renders a router link that looks like a button', () => {
    render(<MemoryRouter><Action to="/app/account/keys/new" variant="primary">New key</Action></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'New key' })).toHaveAttribute('href', '/app/account/keys/new');
  });

  it('refuses clicks while busy and says so', () => {
    const onClick = vi.fn();
    render(<Action busy onClick={onClick}>Save</Action>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
