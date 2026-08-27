import { describe, it, expect, afterEach } from 'vitest';
import { getBotServiceConfig } from './bot-service';

describe('getBotServiceConfig', () => {
  afterEach(() => {
    delete process.env.BOT_SERVICE_URL;
    delete process.env.BOT_INTERNAL_SECRET;
  });

  it('returns null when BOT_SERVICE_URL is not set', () => {
    expect(getBotServiceConfig()).toBeNull();
  });

  it('returns url and authHeader when both vars are set', () => {
    process.env.BOT_SERVICE_URL = 'http://bot:3001';
    process.env.BOT_INTERNAL_SECRET = 'my-secret';
    expect(getBotServiceConfig()).toEqual({
      url: 'http://bot:3001',
      authHeader: 'Bearer my-secret',
    });
  });

  it('falls back to empty string when BOT_INTERNAL_SECRET is unset', () => {
    process.env.BOT_SERVICE_URL = 'http://bot:3001';
    expect(getBotServiceConfig()!.authHeader).toBe('Bearer ');
  });

  it('preserves full URL with path and port', () => {
    process.env.BOT_SERVICE_URL = 'https://bot.example.com:8080/svc';
    process.env.BOT_INTERNAL_SECRET = 'sec';
    expect(getBotServiceConfig()!.url).toBe('https://bot.example.com:8080/svc');
  });
});
