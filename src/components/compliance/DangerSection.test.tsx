// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DangerSection } from './DangerSection';

const baseProps = {
  title: 'Slet møde',
  description: 'Dette sletter mødet permanent.',
  actionLabel: 'Slet',
  onAction: vi.fn(),
};

describe('DangerSection', () => {
  describe('initial render', () => {
    it('renders the title', () => {
      render(<DangerSection {...baseProps} />);
      expect(screen.getByText('Slet møde')).toBeInTheDocument();
    });

    it('renders the description', () => {
      render(<DangerSection {...baseProps} />);
      expect(screen.getByText('Dette sletter mødet permanent.')).toBeInTheDocument();
    });

    it('shows the action button with the given label', () => {
      render(<DangerSection {...baseProps} />);
      expect(screen.getByRole('button', { name: 'Slet' })).toBeInTheDocument();
    });

    it('does NOT show the confirm or cancel buttons initially', () => {
      render(<DangerSection {...baseProps} />);
      expect(screen.queryByRole('button', { name: 'Ja, slet' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Fortryd' })).toBeNull();
    });

    it('does NOT show the confirmation warning text initially', () => {
      render(<DangerSection {...baseProps} />);
      expect(screen.queryByText('Er du sikker? Dette kan ikke fortrydes.')).toBeNull();
    });

    it('does not render retentionNote when not provided', () => {
      render(<DangerSection {...baseProps} />);
      expect(screen.queryByText(/retention/i)).toBeNull();
    });

    it('renders retentionNote when provided', () => {
      render(<DangerSection {...baseProps} retentionNote="Data beholdes i 30 dage" />);
      expect(screen.getByText('Data beholdes i 30 dage')).toBeInTheDocument();
    });
  });

  describe('entering confirming state', () => {
    it('clicking the action button shows confirm and cancel buttons', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      expect(screen.getByRole('button', { name: 'Ja, slet' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Fortryd' })).toBeInTheDocument();
    });

    it('clicking the action button hides the original action button', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      expect(screen.queryByRole('button', { name: 'Slet' })).toBeNull();
    });

    it('clicking the action button shows the confirmation warning text', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      expect(screen.getByText('Er du sikker? Dette kan ikke fortrydes.')).toBeInTheDocument();
    });
  });

  describe('confirm flow', () => {
    it('clicking Ja, slet calls onAction once', async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      render(<DangerSection {...baseProps} onAction={onAction} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Ja, slet' }));
      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it('clicking Ja, slet exits confirming state (hides confirm/cancel)', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} onAction={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Ja, slet' }));
      expect(screen.queryByRole('button', { name: 'Ja, slet' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Fortryd' })).toBeNull();
    });

    it('clicking Ja, slet restores the original action button', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} onAction={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Ja, slet' }));
      expect(screen.getByRole('button', { name: 'Slet' })).toBeInTheDocument();
    });
  });

  describe('cancel flow', () => {
    it('clicking Fortryd does NOT call onAction', async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      render(<DangerSection {...baseProps} onAction={onAction} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Fortryd' }));
      expect(onAction).not.toHaveBeenCalled();
    });

    it('clicking Fortryd exits confirming state (hides confirm/cancel)', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} onAction={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Fortryd' }));
      expect(screen.queryByRole('button', { name: 'Ja, slet' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Fortryd' })).toBeNull();
    });

    it('clicking Fortryd restores the original action button', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} onAction={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Fortryd' }));
      expect(screen.getByRole('button', { name: 'Slet' })).toBeInTheDocument();
    });

    it('clicking Fortryd hides the warning text', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} onAction={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Fortryd' }));
      expect(screen.queryByText('Er du sikker? Dette kan ikke fortrydes.')).toBeNull();
    });
  });

  describe('disabled prop', () => {
    it('action button is disabled when disabled=true', () => {
      render(<DangerSection {...baseProps} disabled />);
      expect(screen.getByRole('button', { name: 'Slet' })).toBeDisabled();
    });

    it('clicking the disabled button does not enter confirming state', async () => {
      const user = userEvent.setup();
      render(<DangerSection {...baseProps} disabled />);
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      expect(screen.queryByRole('button', { name: 'Ja, slet' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Fortryd' })).toBeNull();
    });

    it('action button is enabled when disabled is not provided', () => {
      render(<DangerSection {...baseProps} />);
      expect(screen.getByRole('button', { name: 'Slet' })).not.toBeDisabled();
    });

    it('renders retentionNote alongside the disabled action button', () => {
      render(
        <DangerSection {...baseProps} disabled retentionNote="Opbevares i 90 dage" />
      );
      expect(screen.getByText('Opbevares i 90 dage')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Slet' })).toBeDisabled();
    });
  });

  describe('multiple interaction cycles', () => {
    it('can complete a cancel-then-confirm cycle', async () => {
      const user = userEvent.setup();
      const onAction = vi.fn();
      render(<DangerSection {...baseProps} onAction={onAction} />);

      // Enter confirming, then cancel
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Fortryd' }));

      // Enter confirming again and confirm
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      await user.click(screen.getByRole('button', { name: 'Ja, slet' }));

      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it('retentionNote is still visible during confirming state', async () => {
      const user = userEvent.setup();
      render(
        <DangerSection
          {...baseProps}
          retentionNote="Beholdes i 30 dage"
          onAction={vi.fn()}
        />
      );
      await user.click(screen.getByRole('button', { name: 'Slet' }));
      expect(screen.getByText('Beholdes i 30 dage')).toBeInTheDocument();
    });
  });
});
