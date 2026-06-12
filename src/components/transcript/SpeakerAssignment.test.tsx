// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpeakerAssignment, type ParticipantRow, type VoiceBite } from './SpeakerAssignment';

const VOICES: VoiceBite[] = [
  { speaker: 'Taler 1', start: 0, end: 5 },
  { speaker: 'Taler 3', start: 30, end: 42 },
];

function setup(overrides: Partial<React.ComponentProps<typeof SpeakerAssignment>> = {}) {
  const handlers = {
    onLink: vi.fn(),
    onMarkSilent: vi.fn(),
    onUnlink: vi.fn(),
    onRemove: vi.fn(),
    onRename: vi.fn(),
    onAdd: vi.fn(),
    onPlaySegment: vi.fn(),
  };
  const rows: ParticipantRow[] = overrides.rows ?? [
    { name: 'Mette', kind: 'recognized', start: 10, end: 22 },
    { name: 'Lars', kind: 'pending' },
    { name: 'Pia', kind: 'silent' },
  ];
  const utils = render(
    <SpeakerAssignment
      rows={rows}
      voices={overrides.voices ?? VOICES}
      voicelessParticipants={overrides.voicelessParticipants ?? ['Lars', 'Pia']}
      recognizedCount={overrides.recognizedCount ?? 1}
      totalVoices={overrides.totalVoices ?? 3}
      {...handlers}
      {...overrides}
    />,
  );
  return { ...handlers, ...utils };
}

describe('SpeakerAssignment panel', () => {
  it('shows the recognized / total voice counter', () => {
    setup();
    expect(screen.getByText('1 / 3 stemmer genkendt')).toBeInTheDocument();
  });

  it('renders one row per participant', () => {
    setup();
    expect(screen.getByText('Mette')).toBeInTheDocument();
    expect(screen.getByText('Lars')).toBeInTheDocument();
    expect(screen.getByText('Pia')).toBeInTheDocument();
  });

  it('opens a pending row dropdown listing unmatched voices and links on pick', async () => {
    const user = userEvent.setup();
    const { onLink } = setup();
    await user.click(screen.getByText(/tildel stemme/));
    // Two voice options appear
    expect(screen.getByText('Taler 1')).toBeInTheDocument();
    await user.click(screen.getByText('Taler 3'));
    expect(onLink).toHaveBeenCalledWith('Taler 3', 'Lars');
  });

  it('marks a pending person silent via the "talte ikke" option', async () => {
    const user = userEvent.setup();
    const { onMarkSilent } = setup();
    await user.click(screen.getByText(/tildel stemme/));
    await user.click(screen.getByRole('button', { name: 'talte ikke' }));
    expect(onMarkSilent).toHaveBeenCalledWith('Lars');
  });

  it('previews a voice without selecting it', async () => {
    const user = userEvent.setup();
    const { onPlaySegment, onLink } = setup();
    await user.click(screen.getByText(/tildel stemme/));
    await user.click(screen.getByLabelText('Afspil Taler 1'));
    expect(onPlaySegment).toHaveBeenCalledWith(0, 5);
    expect(onLink).not.toHaveBeenCalled();
  });

  it('frakobler (unlinks) a recognized person, keeping them in the roster', async () => {
    const user = userEvent.setup();
    const { onUnlink } = setup();
    const row = screen.getByText('Mette').closest('.sa-row') as HTMLElement;
    await user.click(within(row).getByText('frakobl'));
    expect(onUnlink).toHaveBeenCalledWith('Mette');
  });

  it('removes a recognized person via ×', async () => {
    const user = userEvent.setup();
    const { onRemove } = setup();
    const row = screen.getByText('Mette').closest('.sa-row') as HTMLElement;
    await user.click(within(row).getByTitle('Fjern deltager'));
    expect(onRemove).toHaveBeenCalledWith('Mette');
  });

  it('removes a pending person via ×', async () => {
    const user = userEvent.setup();
    const { onRemove } = setup();
    const row = screen.getByText('Lars').closest('.sa-row') as HTMLElement;
    await user.click(within(row).getByTitle('Fjern deltager'));
    expect(onRemove).toHaveBeenCalledWith('Lars');
  });

  it('removes a silent person via ×', async () => {
    const user = userEvent.setup();
    const { onRemove } = setup();
    const row = screen.getByText('Pia').closest('.sa-row') as HTMLElement;
    await user.click(within(row).getByTitle('Fjern deltager'));
    expect(onRemove).toHaveBeenCalledWith('Pia');
  });

  it('renames a participant on blur', () => {
    const { onRename } = setup();
    const name = screen.getByText('Lars');
    name.textContent = 'Lars Hansen';
    fireEvent.blur(name);
    expect(onRename).toHaveBeenCalledWith('Lars', 'Lars Hansen');
  });

  it('does not rename when the name is unchanged or blanked', () => {
    const { onRename } = setup();
    const name = screen.getByText('Lars');
    fireEvent.blur(name);
    name.textContent = '   ';
    fireEvent.blur(name);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('plays a recognized person\'s soundbite', async () => {
    const user = userEvent.setup();
    const { onPlaySegment } = setup();
    await user.click(screen.getByTitle('Afspil Mettes stemme'));
    expect(onPlaySegment).toHaveBeenCalledWith(10, 22);
  });

  it('shows a pause control on the soundbite currently playing', () => {
    setup({ playingSegment: { start: 10, end: 22 } });
    const row = screen.getByText('Mette').closest('.sa-row') as HTMLElement;
    expect(within(row).getByTitle('Pause')).toBeInTheDocument();
    expect(within(row).queryByTitle('Afspil Mettes stemme')).not.toBeInTheDocument();
  });

  it('hides leftover voices while any participant is still pending', () => {
    setup();
    expect(screen.queryByText(/ukendte stemmer/)).not.toBeInTheDocument();
  });

  it('keeps leftover unknown voices collapsed by default, expandable on click', async () => {
    const user = userEvent.setup();
    setup({
      rows: [{ name: 'Mette', kind: 'recognized', start: 10, end: 22 }],
      voices: [{ speaker: 'Taler 3', start: 30, end: 42 }],
      recognizedCount: 1,
      totalVoices: 2,
    });
    const toggle = screen.getByRole('button', { name: /ukendte stemmer · 1/ });
    expect(toggle).toBeInTheDocument();
    // Collapsed: the naming action isn't visible yet.
    expect(screen.queryByText('navngiv →')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByText('navngiv →')).toBeInTheDocument();
  });

  it('shows the completion status when no voices remain unmatched', () => {
    setup({
      rows: [{ name: 'Mette', kind: 'recognized', start: 10, end: 22 }],
      voices: [],
      recognizedCount: 1,
      totalVoices: 1,
    });
    expect(screen.getByText('alle stemmer er genkendt')).toBeInTheDocument();
  });

  it('adds a participant via the footer input', async () => {
    const user = userEvent.setup();
    const { onAdd } = setup();
    await user.type(screen.getByPlaceholderText('tilføj deltager…'), 'Sofie');
    await user.click(screen.getByText('+ tilføj'));
    expect(onAdd).toHaveBeenCalledWith('Sofie');
  });

  describe('while diarization is running', () => {
    it('shows a recognising state and no voice triggers', () => {
      setup({ diarizing: true });
      expect(screen.getByText('genkender stemmer…')).toBeInTheDocument();
      expect(screen.queryByText(/tildel stemme/)).not.toBeInTheDocument();
      expect(screen.queryByText(/stemmer genkendt/)).not.toBeInTheDocument();
    });

    it('still lists participants and lets you add one', async () => {
      const user = userEvent.setup();
      const { onAdd } = setup({ diarizing: true });
      expect(screen.getByText('Mette')).toBeInTheDocument();
      expect(screen.getByText('Lars')).toBeInTheDocument();
      await user.type(screen.getByPlaceholderText('tilføj deltager…'), 'Sofie');
      await user.click(screen.getByText('+ tilføj'));
      expect(onAdd).toHaveBeenCalledWith('Sofie');
    });

    it('lets you remove a participant while waiting', async () => {
      const user = userEvent.setup();
      const { onRemove } = setup({ diarizing: true });
      const row = screen.getByText('Lars').closest('.sa-row') as HTMLElement;
      await user.click(within(row).getByTitle('Fjern deltager'));
      expect(onRemove).toHaveBeenCalledWith('Lars');
    });
  });
});
