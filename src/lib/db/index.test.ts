import { describe, it, expect, vi } from 'vitest';

vi.spyOn(console, 'error').mockImplementation(() => {});

import { createDbClient, pool } from './index';

describe('long-held connections', () => {
  it('a standalone client survives an error event instead of crashing the process', () => {
    // pg rethrows an unhandled 'error' as an uncaught exception.
    const client = createDbClient();
    expect(client.listenerCount('error')).toBeGreaterThan(0);
    expect(() => client.emit('error', new Error('terminated'))).not.toThrow();
  });

  it('the pool survives an idle client error', () => {
    expect(() => pool.emit('error', new Error('terminated'), {} as never)).not.toThrow();
  });
});
