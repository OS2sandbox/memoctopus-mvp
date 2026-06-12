// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpeakerCombobox } from './SpeakerCombobox';

function setup(overrides: Partial<React.ComponentProps<typeof SpeakerCombobox>> = {}) {
  const onAssign = vi.fn();
  const onClose = vi.fn();
  render(
    <SpeakerCombobox
      currentSpeaker="Taler 1"
      participants={['Mette Hansen', 'Anders Olsen']}
      onAssign={onAssign}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onAssign, onClose };
}

describe('SpeakerCombobox', () => {
  it('filters participants by the typed query', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('textbox'), 'and');
    expect(screen.getByText('Anders Olsen')).toBeInTheDocument();
    expect(screen.queryByText('Mette Hansen')).not.toBeInTheDocument();
  });

  it('assigns the speaker to a clicked participant', async () => {
    const user = userEvent.setup();
    const { onAssign, onClose } = setup();
    await user.click(screen.getByText('Mette Hansen'));
    expect(onAssign).toHaveBeenCalledWith('Mette Hansen');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers to add a name that is not an existing participant', async () => {
    const user = userEvent.setup();
    const { onAssign } = setup();
    await user.type(screen.getByRole('textbox'), 'Sofie');
    const addRow = screen.getByText(/Tilføj .*Sofie.* som deltager/);
    await user.click(addRow);
    expect(onAssign).toHaveBeenCalledWith('Sofie');
  });

  it('does not offer "add new" when the name already exists', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('textbox'), 'Mette Hansen');
    expect(screen.queryByText(/som deltager/)).not.toBeInTheDocument();
  });

  it('assigns via Enter on the highlighted option', async () => {
    const user = userEvent.setup();
    const { onAssign } = setup();
    await user.type(screen.getByRole('textbox'), 'mette{Enter}');
    expect(onAssign).toHaveBeenCalledWith('Mette Hansen');
  });
});
