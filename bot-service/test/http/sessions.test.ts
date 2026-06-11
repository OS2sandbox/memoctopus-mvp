import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createBotService, BotLike, BotFactory } from '../../src/server';
import type { BotStatus } from '../../src/teams-bot';

/**
 * HTTP integration tests for the bot service's session lifecycle.
 *
 * Uses a stub BotLike so we can drive status transitions deterministically
 * without launching Chromium. Covers: auth, validation, concurrency cap,
 * eviction window, 404s, drain.
 */

const SECRET = 'test-secret';
const NEXT_APP_URL = 'http://example.test';

interface StubBot extends BotLike {
  startCalls: number;
  pauseCalls: number;
  resumeCalls: number;
  stopCalls: number;
  abortCalls: number;
}

function makeStubFactory(seed: Partial<BotLike> = {}): { factory: BotFactory; instances: StubBot[] } {
  const instances: StubBot[] = [];
  const factory: BotFactory = () => {
    const bot: StubBot = {
      status: (seed.status ?? 'joining') as BotStatus,
      participants: seed.participants ?? [],
      elapsed: seed.elapsed ?? 0,
      error: seed.error ?? null,
      startCalls: 0,
      pauseCalls: 0,
      resumeCalls: 0,
      stopCalls: 0,
      abortCalls: 0,
      async start() { this.startCalls++; },
      pause() { this.pauseCalls++; },
      resume() { this.resumeCalls++; },
      async stop() { this.stopCalls++; this.status = 'ended'; },
      async abort() { this.abortCalls++; this.status = 'ended'; },
    };
    instances.push(bot);
    return bot;
  };
  return { factory, instances };
}

function makeService(opts: Partial<Parameters<typeof createBotService>[0]> = {}) {
  const { factory, instances } = makeStubFactory();
  const service = createBotService({
    internalSecret: SECRET,
    nextAppUrl: NEXT_APP_URL,
    maxConcurrentSessions: 5,
    botFactory: opts.botFactory ?? factory,
    now: opts.now,
    ...opts,
  });
  return { service, instances, factory };
}

const auth = `Bearer ${SECRET}`;
const validJoin = {
  meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
  meetingId: 'meet-1',
  userId: 'user-1',
};

describe('POST /sessions', () => {
  let service: ReturnType<typeof makeService>['service'];
  let instances: StubBot[];

  beforeEach(() => {
    ({ service, instances } = makeService());
  });

  it('rejects without Authorization header', async () => {
    const res = await request(service.app).post('/sessions').send(validJoin);
    expect(res.status).toBe(401);
  });

  it('rejects with wrong Authorization header', async () => {
    const res = await request(service.app)
      .post('/sessions')
      .set('Authorization', 'Bearer wrong')
      .send(validJoin);
    expect(res.status).toBe(401);
  });

  it('rejects missing required fields', async () => {
    const res = await request(service.app)
      .post('/sessions')
      .set('Authorization', auth)
      .send({ meetingUrl: validJoin.meetingUrl });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing/);
  });

  it('rejects non-Teams URL with the expected message', async () => {
    const res = await request(service.app)
      .post('/sessions')
      .set('Authorization', auth)
      .send({ ...validJoin, meetingUrl: 'https://zoom.us/j/123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Microsoft Teams meeting link/);
  });

  it('rejects malformed URL', async () => {
    const res = await request(service.app)
      .post('/sessions')
      .set('Authorization', auth)
      .send({ ...validJoin, meetingUrl: 'not a url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid meeting URL/);
  });

  it('starts a bot and returns sessionId', async () => {
    const res = await request(service.app)
      .post('/sessions')
      .set('Authorization', auth)
      .send(validJoin);
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeTypeOf('string');
    expect(service.sessions.size).toBe(1);
    // start() is fired but not awaited; allow microtasks to flush.
    await new Promise((r) => setImmediate(r));
    expect(instances[0].startCalls).toBe(1);
  });

  it('enforces the concurrency cap based on active (non-terminal) sessions', async () => {
    const small = makeService({ maxConcurrentSessions: 2 });
    for (let i = 0; i < 2; i++) {
      await request(small.service.app).post('/sessions').set('Authorization', auth)
        .send({ ...validJoin, meetingId: `m-${i}` });
    }
    const blocked = await request(small.service.app).post('/sessions').set('Authorization', auth)
      .send({ ...validJoin, meetingId: 'm-3' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.max).toBe(2);
  });

  it('evicts terminal sessions older than 1 hour before checking the cap', async () => {
    let fakeNow = Date.now();
    const tick = makeService({
      maxConcurrentSessions: 1,
      now: () => fakeNow,
    });
    // First session — succeeds.
    await request(tick.service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    // Mark it ended.
    tick.instances[0].status = 'ended';
    // Advance >1 hour.
    fakeNow += 61 * 60 * 1000;
    // Second session — eviction makes room.
    const res = await request(tick.service.app).post('/sessions').set('Authorization', auth)
      .send({ ...validJoin, meetingId: 'meet-2' });
    expect(res.status).toBe(201);
    expect(tick.service.sessions.size).toBe(1);
  });

  it('does NOT evict terminal sessions younger than 1 hour', async () => {
    let fakeNow = Date.now();
    const tick = makeService({
      maxConcurrentSessions: 1,
      now: () => fakeNow,
    });
    await request(tick.service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    tick.instances[0].status = 'ended';
    fakeNow += 30 * 60 * 1000; // 30 min
    const res = await request(tick.service.app).post('/sessions').set('Authorization', auth)
      .send({ ...validJoin, meetingId: 'meet-2' });
    // No active sessions (the one is ended), so the cap allows it — but the
    // ended session is still in the map.
    expect(res.status).toBe(201);
    expect(tick.service.sessions.size).toBe(2);
  });
});

describe('GET /sessions/:id', () => {
  it('returns the bot status snapshot', async () => {
    const { service, instances } = makeService();
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    instances[0].status = 'recording';
    instances[0].participants = ['Alice'];
    instances[0].elapsed = 42;
    const id = [...service.sessions.keys()][0];
    const res = await request(service.app).get(`/sessions/${id}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'recording',
      participants: ['Alice'],
      elapsed: 42,
      error: null,
    });
  });

  it('returns 404 for unknown id', async () => {
    const { service } = makeService();
    const res = await request(service.app).get('/sessions/nope').set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /sessions/:id/{pause,resume,stop}', () => {
  it('pause and resume forward to bot.pause/bot.resume', async () => {
    const { service, instances } = makeService();
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    const id = [...service.sessions.keys()][0];
    await request(service.app).post(`/sessions/${id}/pause`).set('Authorization', auth);
    await request(service.app).post(`/sessions/${id}/resume`).set('Authorization', auth);
    expect(instances[0].pauseCalls).toBe(1);
    expect(instances[0].resumeCalls).toBe(1);
  });

  it('stop fires bot.stop() asynchronously and returns 200 immediately', async () => {
    const { service, instances } = makeService();
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    const id = [...service.sessions.keys()][0];
    const res = await request(service.app).post(`/sessions/${id}/stop`).set('Authorization', auth);
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(instances[0].stopCalls).toBe(1);
  });

  it('returns 404 when the session is missing', async () => {
    const { service } = makeService();
    for (const action of ['pause', 'resume', 'stop']) {
      const res = await request(service.app).post(`/sessions/missing/${action}`).set('Authorization', auth);
      expect(res.status).toBe(404);
    }
  });
});

describe('DELETE /sessions/:id', () => {
  it('aborts the bot and removes the session from the map', async () => {
    const { service, instances } = makeService();
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    const id = [...service.sessions.keys()][0];
    const res = await request(service.app).delete(`/sessions/${id}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(instances[0].abortCalls).toBe(1);
    expect(service.sessions.has(id)).toBe(false);
  });

  it('returns 404 when missing', async () => {
    const { service } = makeService();
    const res = await request(service.app).delete('/sessions/nope').set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});

describe('GET /health', () => {
  it('healthy when no sessions', async () => {
    const { service } = makeService();
    const res = await request(service.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessions).toBe(0);
  });

  it('503 when a session has been joining for >5 minutes', async () => {
    let fakeNow = Date.now();
    const { service, instances } = makeService({ now: () => fakeNow });
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    instances[0].status = 'joining';
    fakeNow += 6 * 60 * 1000;
    const res = await request(service.app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.stuckJoining).not.toBeNull();
  });

  it('503 when a session has been active for >6 hours (leaked)', async () => {
    let fakeNow = Date.now();
    const { service, instances } = makeService({ now: () => fakeNow });
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    instances[0].status = 'recording';
    fakeNow += 7 * 60 * 60 * 1000;
    const res = await request(service.app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.leakedSession).not.toBeNull();
  });
});

describe('drain()', () => {
  it('calls stop() on recording sessions and abort() on joining sessions', async () => {
    const { service, instances } = makeService();
    // Two sessions, different states.
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    await request(service.app).post('/sessions').set('Authorization', auth)
      .send({ ...validJoin, meetingId: 'meet-2' });
    instances[0].status = 'recording';
    instances[1].status = 'joining';
    await service.drain();
    expect(instances[0].stopCalls).toBe(1);
    expect(instances[1].abortCalls).toBe(1);
  });

  it('does not call stop/abort on terminal sessions', async () => {
    const { service, instances } = makeService();
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    instances[0].status = 'ended';
    await service.drain();
    expect(instances[0].stopCalls).toBe(0);
    expect(instances[0].abortCalls).toBe(0);
  });

  it('swallows per-session errors so one bad session does not block the rest', async () => {
    const { service, instances } = makeService();
    await request(service.app).post('/sessions').set('Authorization', auth).send(validJoin);
    await request(service.app).post('/sessions').set('Authorization', auth)
      .send({ ...validJoin, meetingId: 'meet-2' });
    instances[0].status = 'recording';
    instances[1].status = 'recording';
    instances[0].stop = async () => { throw new Error('boom'); };
    await expect(service.drain()).resolves.toBeUndefined();
    expect(instances[1].stopCalls).toBe(1);
  });
});
