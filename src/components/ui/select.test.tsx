// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from './select';

describe('Select', () => {
  it('associates the label with the select', () => {
    render(
      <Select label="Rolle">
        <option value="a">A</option>
      </Select>,
    );
    expect(screen.getByLabelText('Rolle').tagName).toBe('SELECT');
    expect(screen.getByRole('combobox', { name: 'Rolle' })).toBeInTheDocument();
  });

  it('respects an explicit id', () => {
    render(
      <Select label="Rolle" id="role-select">
        <option value="a">A</option>
      </Select>,
    );
    expect(screen.getByLabelText('Rolle')).toHaveAttribute('id', 'role-select');
  });

  it('shows the error, marks the select invalid and links the message', () => {
    render(
      <Select label="Rolle" error="Vælg en rolle" hint="ignoreres">
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByLabelText('Rolle');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    const msgId = select.getAttribute('aria-describedby');
    expect(msgId).toBeTruthy();
    expect(document.getElementById(msgId!)).toHaveTextContent('Vælg en rolle');
    expect(screen.queryByText('ignoreres')).not.toBeInTheDocument();
  });

  it('shows the hint when there is no error', () => {
    render(
      <Select label="Rolle" hint="Vælg den højeste rolle">
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByLabelText('Rolle');
    expect(select).not.toHaveAttribute('aria-invalid');
    expect(document.getElementById(select.getAttribute('aria-describedby')!)).toHaveTextContent(
      'Vælg den højeste rolle',
    );
  });

  it('has no aria-describedby without error or hint', () => {
    render(
      <Select label="Rolle">
        <option value="a">A</option>
      </Select>,
    );
    expect(screen.getByLabelText('Rolle')).not.toHaveAttribute('aria-describedby');
  });

  it('can be disabled', async () => {
    const onChange = vi.fn();
    render(
      <Select label="Rolle" disabled onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const select = screen.getByLabelText('Rolle');
    expect(select).toBeDisabled();
    await userEvent.selectOptions(select, 'b').catch(() => {});
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange when the user selects an option', async () => {
    const onChange = vi.fn();
    render(
      <Select label="Rolle" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    await userEvent.selectOptions(screen.getByLabelText('Rolle'), 'b');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Rolle')).toHaveValue('b');
  });

  it('renders without a label', () => {
    render(
      <Select aria-label="Skjult">
        <option value="a">A</option>
      </Select>,
    );
    expect(screen.getByRole('combobox', { name: 'Skjult' })).toBeInTheDocument();
  });
});
