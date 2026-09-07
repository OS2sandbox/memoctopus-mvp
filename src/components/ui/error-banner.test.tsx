// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBanner } from './error-banner';

describe('ErrorBanner', () => {
  it('renders nothing when there is no message', () => {
    const { container } = render(<ErrorBanner message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty string', () => {
    const { container } = render(<ErrorBanner message="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the message with an alert role', () => {
    render(<ErrorBanner message="Kunne ikke gemme" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Kunne ikke gemme');
  });

  it('does not render a retry button without onRetry', () => {
    render(<ErrorBanner message="Fejl" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a retry button and calls onRetry when clicked', async () => {
    const onRetry = vi.fn();
    render(<ErrorBanner message="Fejl" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Prøv igen' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('honours a custom retry label', () => {
    render(<ErrorBanner message="Fejl" onRetry={() => {}} retryLabel="Genindlæs" />);
    expect(screen.getByRole('button', { name: 'Genindlæs' })).toBeInTheDocument();
  });
});
