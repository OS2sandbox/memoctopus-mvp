// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpeakerRow } from './SpeakerRow';
import type { TranscriptSegment } from '@/types';

const seg: TranscriptSegment = { speaker: 'Taler 2', start: 12, end: 18, text: 'Hej med jer' };

function setup(overrides: Partial<React.ComponentProps<typeof SpeakerRow>> = {}) {
  const onAssign = vi.fn();
  render(
    <SpeakerRow
      segment={seg}
      index={0}
      onUpdate={vi.fn()}
      onAssign={onAssign}
      speakerSegmentCount={3}
      participants={['Mette Hansen']}
      {...overrides}
    />,
  );
  return { onAssign };
}

describe('SpeakerRow', () => {
  it('opens the picker when the speaker label is clicked and assigns', async () => {
    const user = userEvent.setup();
    const { onAssign } = setup();
    await user.click(screen.getByRole('button', { name: 'Taler 2' }));
    await user.click(screen.getByText('Mette Hansen'));
    expect(onAssign).toHaveBeenCalledWith('Taler 2', 'Mette Hansen');
  });

  it('shows the uncertainty placeholder and no clickable label while diarizing', () => {
    setup({ diarizing: true });
    expect(screen.getByLabelText('Genkender taler')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Taler 2' })).not.toBeInTheDocument();
  });
});
