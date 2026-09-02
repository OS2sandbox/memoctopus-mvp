// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppError from './error';

describe('(app) error boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the error on mount (traceability)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('render blew up'), { digest: 'abc123' });
    render(<AppError error={error} reset={() => {}} />);
    expect(spy).toHaveBeenCalledWith('[app-error-boundary]', error);
  });

  it('shows a Danish message and recovery actions', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<AppError error={new Error('x')} reset={() => {}} />);
    expect(screen.getByText('Noget gik galt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Til forsiden' })).toHaveAttribute('href', '/dashboard');
  });

  it('calls reset() when "Prøv igen" is clicked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reset = vi.fn();
    render(<AppError error={new Error('x')} reset={reset} />);
    await userEvent.click(screen.getByRole('button', { name: 'Prøv igen' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error digest when present', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<AppError error={Object.assign(new Error('x'), { digest: 'dig-42' })} reset={() => {}} />);
    expect(screen.getByText(/dig-42/)).toBeInTheDocument();
  });
});
