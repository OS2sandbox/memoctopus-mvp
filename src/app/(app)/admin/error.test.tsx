// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth-client', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));

import AdminError from './error';

afterEach(() => vi.restoreAllMocks());

describe('(app)/admin error boundary', () => {
  it('is a client component (Next requires error.tsx to be one)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(`${process.cwd()}/src/app/(app)/admin/error.tsx`, 'utf8');
    expect(src.trimStart().startsWith("'use client'")).toBe(true);
  });

  it('renders the fail-closed retry screen and logs only the digest, never the message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<AdminError error={Object.assign(new Error('postgres://user:secret@db'), { digest: 'abc123' })} />);
    expect(screen.getByRole('heading')).toHaveTextContent('Adgangskontrol er midlertidigt utilgængelig');
    expect(screen.getByRole('button', { name: 'Prøv igen' })).toBeInTheDocument();
    expect(JSON.stringify(log.mock.calls)).toContain('abc123');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});
