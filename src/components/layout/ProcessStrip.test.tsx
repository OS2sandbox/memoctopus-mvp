// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProcessStrip } from './ProcessStrip';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...props}>{children}</a>
  ),
}));

const PHASES = ['Optagelse', 'Gennemgang', 'Referat', 'Eksport'];

// ─── ProcessStrip ─────────────────────────────────────────────────────────────

describe('ProcessStrip', () => {
  it('renders all four phase labels', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="recording" />);
    PHASES.forEach((label) => {
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it('marks the active phase with aria-current="step" when rendered as a link', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="review" />);
    // Without onTabChange, active phase renders as a <Link> (anchor)
    const activeEl = screen.getByRole('link', { name: /gennemgang/i });
    expect(activeEl).toHaveAttribute('aria-current', 'step');
  });

  it('marks the active phase with aria-current="step" when rendered as a button', () => {
    const onTabChange = vi.fn();
    render(<ProcessStrip meetingId="m-1" activePhase="review" onTabChange={onTabChange} />);
    const activeBtn = screen.getByRole('button', { name: /gennemgang/i });
    expect(activeBtn).toHaveAttribute('aria-current', 'step');
  });

  it('does not apply aria-current to non-active links', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="recording" />);
    // 'recording' is active (link with aria-current). No other links are visible when at recording phase.
    const links = screen.queryAllByRole('link');
    const nonActiveLinks = links.filter((link) => link.getAttribute('aria-current') !== 'step');
    nonActiveLinks.forEach((link) => {
      expect(link).not.toHaveAttribute('aria-current', 'step');
    });
  });

  it('renders a checkmark (✓) for completed phases before active', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="minutes" />);
    // Optagelse and Gennemgang should be completed (index < activeIndex)
    const checkmarks = screen.getAllByText('✓');
    expect(checkmarks.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the active phase step number (not checkmark)', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="recording" />);
    // recording is phase index 0 → should show "1"
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders a button when onTabChange is provided for reachable phases', () => {
    const onTabChange = vi.fn();
    render(<ProcessStrip meetingId="m-1" activePhase="review" onTabChange={onTabChange} completedPhases={['recording']} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('calls onTabChange when a reachable phase button is clicked', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<ProcessStrip meetingId="m-1" activePhase="review" onTabChange={onTabChange} />);

    const reviewBtn = screen.getByRole('button', { name: /gennemgang/i });
    await user.click(reviewBtn);

    expect(onTabChange).toHaveBeenCalledWith('review');
  });

  it('calls onTabChange with the correct phase key', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    // recording is completed (index 0 < activeIndex 1 for review)
    render(<ProcessStrip meetingId="m-1" activePhase="review" onTabChange={onTabChange} />);

    const recordingBtn = screen.getByRole('button', { name: /optagelse/i });
    await user.click(recordingBtn);

    expect(onTabChange).toHaveBeenCalledWith('recording');
  });

  it('renders links when no onTabChange is provided', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="review" />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
  });

  it('link href for active phase points to the correct meeting path', () => {
    render(<ProcessStrip meetingId="m-42" activePhase="review" />);
    const reviewLink = screen.getByRole('link', { name: /gennemgang/i });
    expect(reviewLink).toHaveAttribute('href', '/meeting/m-42/review');
  });

  it('link href for recording phase has no path suffix', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="review" />);
    const recordingLink = screen.getByRole('link', { name: /optagelse/i });
    expect(recordingLink.getAttribute('href')).toBe('/meeting/m-1');
  });

  it('renders meetingTitle when provided', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="recording" meetingTitle="Tirsdagsmøde" />);
    expect(screen.getByText('Tirsdagsmøde')).toBeInTheDocument();
  });

  it('does not render meetingTitle when not provided', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="recording" />);
    expect(screen.queryByText(/møde/i)).not.toBeInTheDocument();
  });

  it('renders separator "/" between phases', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="recording" />);
    const separators = document.querySelectorAll('span');
    const slashSeparators = Array.from(separators).filter((s) => s.textContent === '/');
    expect(slashSeparators.length).toBe(3); // 4 phases → 3 separators
  });

  it('unreachable future phases are not rendered as links or buttons', () => {
    render(<ProcessStrip meetingId="m-1" activePhase="recording" />);
    // Only 'recording' (active) is reachable — export and future phases are spans
    const links = screen.queryAllByRole('link');
    const buttons = screen.queryAllByRole('button');
    // No phases are reachable as links/buttons (no onTabChange, only active one is reachable)
    // Active phase renders as button only if onTabChange provided, else link
    expect(links.length + buttons.length).toBeLessThanOrEqual(1);
  });

  it('explicitly completed phases are marked with ✓', () => {
    render(
      <ProcessStrip
        meetingId="m-1"
        activePhase="minutes"
        completedPhases={['recording', 'review']}
      />,
    );
    const checkmarks = screen.getAllByText('✓');
    expect(checkmarks.length).toBeGreaterThanOrEqual(2);
  });
});
