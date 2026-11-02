import { describe, it, expect } from 'vitest';
import { lookAtBody, probeReport, runSendProbe, withTimeout, type ProbeResult } from './send-probe';
import type { AsyncResult } from './office';

const INVITE = '<div><a id="meet_invite_block.action.join_link" href="https://teams.microsoft.com/meet/376860952372406?p=s5vL7jGrR2tPM32ZFk">Join</a></div>';

describe('lookAtBody', () => {
  it('sees a Teams invitation block', () => {
    expect(lookAtBody(INVITE)).toMatchObject({ link: 'found', mentionsTeams: true });
  });
  it('sees an empty body', () => {
    expect(lookAtBody('<p></p>')).toEqual({ link: 'none', mentionsTeams: false, length: 7 });
  });
});

describe('probeReport', () => {
  const base: ProbeResult = {
    host: 'OutlookWebApp 20261027',
    first: { link: 'none', mentionsTeams: false, length: 120 },
    second: { link: 'found', mentionsTeams: true, length: 4100 },
    token: { ok: false, code: 'AADSTS700046' },
    elapsedMs: 2150,
  };

  it('answers the three questions in one dialog', () => {
    const { text, markdown } = probeReport(base);
    expect(text).toContain('send-hændelsen kørte');
    expect(text).toContain('Teams-link ved Send: nej');
    expect(text).toContain('Efter 1.5 sek.: JA');
    expect(text).toContain('Login uden pop-up: fejlede (AADSTS700046)');
    expect(text).toContain('Send alligevel');
    expect(markdown.split('\n\n')).toHaveLength(6);
  });

  it('stays within the 500 characters Outlook allows', () => {
    const long = probeReport({ ...base, host: 'x'.repeat(800) });
    expect(long.text.length).toBeLessThanOrEqual(500);
    expect(long.markdown.length).toBeLessThanOrEqual(500);
  });
});

describe('withTimeout', () => {
  it('gives the answer when it comes in time, the fallback when it does not', async () => {
    await expect(withTimeout(Promise.resolve('svar'), 50, 'for sent')).resolves.toBe('svar');
    await expect(withTimeout(new Promise<string>(() => {}), 10, 'for sent')).resolves.toBe('for sent');
    await expect(withTimeout(Promise.reject(new Error('x')), 50, 'fejl')).resolves.toBe('fejl');
  });
});

describe('runSendProbe', () => {
  it('still answers Outlook when the body read never calls back', async () => {
    const office = {
      CoercionType: { Html: 'html' },
      AsyncResultStatus: { Succeeded: 'succeeded' },
      context: {
        mailbox: { item: { body: { getAsync: () => {} } } },
        requirements: { isSetSupported: () => false },
      },
    };
    let text = '';
    await runSendProbe(office, { completed: (o) => { text = o.errorMessage ?? ''; } });
    expect(text).toContain('intet svar inden 1 sek.');
  }, 10_000);

  function fakeOffice(bodies: string[]) {
    let reads = 0;
    return {
      CoercionType: { Html: 'html' },
      AsyncResultStatus: { Succeeded: 'succeeded' },
      context: {
        mailbox: {
          item: {
            body: {
              getAsync: (_c: string, cb: (r: AsyncResult<string>) => void) =>
                cb({ status: 'succeeded', value: bodies[Math.min(reads++, bodies.length - 1)] }),
            },
          },
          diagnostics: { hostName: 'OutlookWebApp', hostVersion: '1' },
        },
        requirements: { isSetSupported: () => false },
      },
    };
  }

  it('reads once when the link is there, and always reports through the dialog', async () => {
    let completed: { allowEvent: boolean; errorMessage?: string } | null = null;
    await runSendProbe(fakeOffice([INVITE]), { completed: (o) => { completed = o; } });
    expect(completed).toMatchObject({ allowEvent: false });
    expect(completed!.errorMessage).toContain('Teams-link ved Send: JA');
    expect(completed!.errorMessage).not.toContain('Efter');
  });
});
