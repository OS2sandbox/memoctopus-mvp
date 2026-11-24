// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const mockListNotes = vi.fn();
vi.mock('@/lib/storage', () => ({
  listNotes: (...args: unknown[]) => mockListNotes(...args),
}));

import { NoteList } from './NoteList';

function note(id: string, title: string) {
  return {
    id,
    title,
    kind: 'note',
    participants: [],
    status: 'done',
    source: 'local',
    meetingUrl: null,
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-20T09:00:00.000Z',
    audioDurationSeconds: null,
    audioSizeBytes: 0,
    audioDeleted: true,
  };
}

beforeEach(() => {
  mockListNotes.mockReset();
});

describe('NoteList', () => {
  it('lists every note, each linking to its own screen', async () => {
    mockListNotes.mockResolvedValue([note('n1', 'Note · 20. november'), note('n2', 'Indkøb')]);

    render(<NoteList />);

    expect(await screen.findByRole('link', { name: /Note · 20\. november/ })).toHaveAttribute('href', '/note/n1');
    expect(screen.getByRole('link', { name: /Indkøb/ })).toHaveAttribute('href', '/note/n2');
    expect(screen.getAllByText('20. november 2026')).toHaveLength(2);
  });

  it('says there are no notes yet and points to the front page', async () => {
    mockListNotes.mockResolvedValue([]);

    render(<NoteList />);

    expect(await screen.findByText('Du har ingen noter endnu.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Indtal din første note →' })).toHaveAttribute('href', '/dashboard');
  });

  it('says so when the notes cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockListNotes.mockRejectedValue(new Error('blocked'));

    render(<NoteList />);

    expect(await screen.findByText('Dine noter kunne ikke indlæses. Genindlæs siden, og prøv igen.')).toBeInTheDocument();
  });
});
