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

  // A real conversation is mostly runs of one speaker. Printing the name on
  // every line buried the words; Teams prints it once per run and so do we.
  describe('a row that continues the same speaker', () => {
    it('does not repeat the speaker name', () => {
      setup({ continuesSpeaker: true });
      expect(screen.queryByRole('button', { name: 'Taler 2' })).not.toBeInTheDocument();
    });

    it('keeps the timestamp, so every line can still be played', () => {
      const onSeek = vi.fn();
      setup({ continuesSpeaker: true, onSeek });
      expect(screen.getByTitle('Lyt til dette segment')).toBeInTheDocument();
    });

    it('still shows the text, and it is still editable', async () => {
      const user = userEvent.setup();
      const onUpdate = vi.fn();
      setup({ continuesSpeaker: true, onUpdate });
      const box = screen.getByDisplayValue('Hej med jer');
      await user.type(box, '!');
      expect(onUpdate).toHaveBeenCalled();
    });

    it('sits tighter than a row that starts a run', () => {
      const { container } = render(
        <SpeakerRow
          segment={seg}
          index={0}
          onUpdate={vi.fn()}
          onAssign={vi.fn()}
          speakerSegmentCount={3}
          participants={[]}
          continuesSpeaker
        />,
      );
      expect(container.firstElementChild?.className).toContain('pt-0.5');
      expect(container.firstElementChild?.className).not.toContain('pt-5');
    });

    it('names the speaker when it starts a run', () => {
      setup({ continuesSpeaker: false });
      expect(screen.getByRole('button', { name: 'Taler 2' })).toBeInTheDocument();
    });
  });

  // It used to sit in the 96 px left rail *under* the timestamp, so it read as a
  // caption on the line above it — and got truncated to "Nikolaj Bac…".
  it('puts the speaker name above the run, not beside or under its first line', () => {
    setup({ onSeek: vi.fn() });
    const name = screen.getByRole('button', { name: 'Taler 2' });
    const text = screen.getByDisplayValue('Hej med jer');
    const time = screen.getByTitle('Lyt til dette segment');

    expect(name.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gives the name the full width rather than the rail', () => {
    setup();
    const name = screen.getByRole('button', { name: 'Taler 2' });
    expect(name.className).not.toContain('truncate');
    expect(name.closest('.w-24')).toBeNull();
  });

  // The old `rows={Math.max(2, len/80)}` gave "Ja." the height of two lines.
  it('does not reserve two lines for a one-word utterance', () => {
    render(
      <SpeakerRow
        segment={{ speaker: 'Taler 1', start: 0, end: 1, text: 'Ja.' }}
        index={0}
        onUpdate={vi.fn()}
        onAssign={vi.fn()}
        speakerSegmentCount={1}
        participants={[]}
      />,
    );
    expect(screen.getByDisplayValue('Ja.')).toHaveAttribute('rows', '1');
  });
});
