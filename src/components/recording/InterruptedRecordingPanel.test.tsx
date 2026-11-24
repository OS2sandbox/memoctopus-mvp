// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InterruptedRecordingPanel } from './InterruptedRecordingPanel';

describe('InterruptedRecordingPanel', () => {
  it('says the recording was interrupted and how much of it is saved', () => {
    render(<InterruptedRecordingPanel savedSeconds={65} onResume={() => {}} onFinish={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/optagelsen blev afbrudt/i)).toBeInTheDocument();
    expect(screen.getByText('01:05')).toBeInTheDocument();
  });

  it.each([
    ['fortsæt optagelse', 'onResume'],
    ['afslut og gå til gennemgang →', 'onFinish'],
    ['slet', 'onDelete'],
  ] as const)('"%s" calls %s', (label, handler) => {
    const handlers = { onResume: vi.fn(), onFinish: vi.fn(), onDelete: vi.fn() };
    render(<InterruptedRecordingPanel savedSeconds={65} {...handlers} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(handlers[handler]).toHaveBeenCalledTimes(1);
    expect(Object.values(handlers).filter((h) => h.mock.calls.length > 0)).toHaveLength(1);
  });
});
