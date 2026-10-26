import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities, extractJoinLinkFromBody, MAX_BODY_LENGTH } from './join-link-from-body';
import { extractJoinContext } from '@/lib/teams/url';

// All ids below are fake: tenant 11111111-…, organizer 22222222-…, thread ids are
// base64("FAKE_MEETING_000n"). See the comment at the top of each fixture.
const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const FAKE_TID = '11111111-1111-1111-1111-111111111111';
const FAKE_OID = '22222222-2222-2222-2222-222222222222';

const MEETUP_JOIN =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_RkFLRV9NRUVUSU5HXzAwMDE%40thread.v2/0' +
  `?context=%7b%22Tid%22%3a%22${FAKE_TID}%22%2c%22Oid%22%3a%22${FAKE_OID}%22%7d`;
const OTHER_MEETUP_JOIN =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_RkFLRV9NRUVUSU5HXzAwMDM%40thread.v2/0' +
  `?context=%7b%22Tid%22%3a%22${FAKE_TID}%22%2c%22Oid%22%3a%22${FAKE_OID}%22%7d`;
const SHORT = 'https://teams.microsoft.com/meet/399000000000001?p=FaKeFaKeFaKe0001';
const OTHER_SHORT = 'https://teams.microsoft.com/meet/399000000000002?p=FaKeFaKeFaKe0002';

const safeLink = (url: string) =>
  `https://eur02.safelinks.protection.outlook.com/?url=${encodeURIComponent(url)}` +
  '&data=05%7C02%7Cx%40example.invalid%7C0%7C0&sdata=RkFLRQ%3D%3D&reserved=0';

/** An invitation block the way Teams writes it, around any href. */
const inviteBlock = (href: string) =>
  `<div class="me-email-text"><a id="meet_invite_block.action.join_link" class="me-email-headline" ` +
  `href="${href.replace(/&/g, '&amp;')}">Deltag i mødet nu</a></div>`;

describe('extractJoinLinkFromBody — realistic invitation bodies', () => {
  it('finds the /l/meetup-join/ link in the older invitation layout', () => {
    const result = extractJoinLinkFromBody(fixture('teams-invite-meetup-join.html'));
    expect(result).toEqual({ ok: true, url: MEETUP_JOIN, source: 'invite-block' });
  });

  it('returns a URL whose join context still names the meeting (what S2 looks up)', () => {
    const result = extractJoinLinkFromBody(fixture('teams-invite-meetup-join.html'));
    if (!result.ok) throw new Error('expected a link');
    expect(extractJoinContext(result.url)).toEqual({
      threadId: '19:meeting_RkFLRV9NRUVUSU5HXzAwMDE@thread.v2',
      tenantId: FAKE_TID,
      organizerOid: FAKE_OID,
    });
  });

  it('finds the /meet/ short link in the current layout and ignores Mødeindstillinger', () => {
    const result = extractJoinLinkFromBody(fixture('teams-invite-meet-short.html'));
    expect(result).toEqual({ ok: true, url: SHORT, source: 'invite-block' });
  });

  it('unwraps a Safe Links href to the byte-identical original link', () => {
    const result = extractJoinLinkFromBody(fixture('teams-invite-safelinks.html'));
    expect(result).toEqual({ ok: true, url: MEETUP_JOIN, source: 'invite-block' });
  });

  it('reads a plain-text body, where Outlook writes links as text<url>', () => {
    const result = extractJoinLinkFromBody(fixture('teams-invite-plain.txt'));
    expect(result).toEqual({ ok: true, url: SHORT, source: 'text' });
  });

  it.each([
    'teams-invite-meetup-join.html',
    'teams-invite-meet-short.html',
    'teams-invite-safelinks.html',
    'teams-invite-plain.txt',
  ])(
    '%s holds a Mødeindstillinger (meetingOptions) link, which never wins and never makes it multiple_distinct',
    (name) => {
      const body = fixture(name);
      // Present literally, or Safe Links-encoded.
      expect(body).toMatch(/teams\.microsoft\.com(?:\/|%2F)meetingOptions/);
      const result = extractJoinLinkFromBody(body);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.url).toMatch(/^https:\/\/teams\.microsoft\.com\/(?:l\/meetup-join|meet)\//);
    },
  );

  it('ignores other Teams paths next to a join link (meetingOptions, help, chats)', () => {
    const body =
      `<a href="https://teams.microsoft.com/meetingOptions/?organizerId=${FAKE_OID}&amp;tenantId=${FAKE_TID}` +
      '&amp;threadId=19_meeting_RkFLRV9NRUVUSU5HXzAwMDE@thread.v2&amp;messageId=0">Mødeindstillinger</a> ' +
      '<a href="https://teams.microsoft.com/l/chat/0/0?users=x@example.invalid">Chat</a> ' +
      '<a href="https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F">Launcher</a> ' +
      `<a href="${SHORT}">Deltag</a>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'href' });
  });

  it('the fixtures carry only fake ids', () => {
    for (const name of [
      'teams-invite-meetup-join.html',
      'teams-invite-meet-short.html',
      'teams-invite-safelinks.html',
      'teams-invite-plain.txt',
    ]) {
      const body = fixture(name);
      expect(body).toMatch(/SYNTHETIC/);
      const guids = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
      for (const guid of guids) expect([FAKE_TID, FAKE_OID]).toContain(guid);
    }
  });
});

describe('extractJoinLinkFromBody — encodings and placements', () => {
  it('decodes &amp; in a Safe Links href outside the invitation block', () => {
    const body = `<p><a href="${safeLink(SHORT).replace(/&/g, '&amp;')}">mødet</a></p>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'href' });
  });

  it('finds a link that is only in visible text, dropping trailing punctuation', () => {
    const body = `<p>Linket er ${SHORT}.</p>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'text' });
  });

  it('decodes numeric entities in visible text', () => {
    const body = '<p>https&#58;&#x2F;&#47;teams.microsoft.com/meet/399000000000001?p=FaKeFaKeFaKe0001</p>';
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'text' });
  });

  it('accepts single-quoted and unquoted href attributes', () => {
    expect(extractJoinLinkFromBody(`<a href='${SHORT}'>x</a>`)).toMatchObject({ ok: true, url: SHORT });
    expect(extractJoinLinkFromBody(`<a href=${SHORT}>x</a>`)).toMatchObject({ ok: true, url: SHORT });
  });

  it('accepts teams.live.com short links', () => {
    const url = 'https://teams.live.com/meet/9300000000001?p=FaKe';
    expect(extractJoinLinkFromBody(`<a href="${url}">x</a>`)).toEqual({ ok: true, url, source: 'href' });
  });

  it('treats the same meeting written twice (wrapped, unwrapped, %3A vs %3a) as one', () => {
    const upper = MEETUP_JOIN.replace('%3ameeting', '%3Ameeting');
    const body = `<a href="${safeLink(MEETUP_JOIN).replace(/&/g, '&amp;')}">a</a> ${MEETUP_JOIN} ${upper}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: MEETUP_JOIN, source: 'href' });
  });
});

describe('extractJoinLinkFromBody — nothing usable', () => {
  it('returns none for an empty body', () => {
    expect(extractJoinLinkFromBody('')).toEqual({ ok: false, reason: 'none' });
  });

  it('returns none for an unsent invitation without a Teams block', () => {
    const body = '<html><body><p>Dagsorden følger.</p><p><br></p></body></html>';
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'none' });
  });

  it('returns none for non-Teams links, including Microsoft help pages', () => {
    const body =
      '<a href="https://zoom.us/j/123456789">Zoom</a> ' +
      '<a href="https://aka.ms/JoinTeamsMeeting?omkt=da-DK">Hjælp</a> ' +
      '<a href="https://www.microsoft.com/microsoft-teams/join-a-meeting">Deltag på internettet</a> ' +
      'https://meet.google.com/abc-defg-hij';
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'none' });
  });

  it('returns none for a Teams URL that is not a meeting (Mødeindstillinger alone)', () => {
    const body =
      `<a href="https://teams.microsoft.com/meetingOptions/?organizerId=${FAKE_OID}&amp;tenantId=${FAKE_TID}` +
      '&amp;threadId=19_meeting_RkFLRV9NRUVUSU5HXzAwMDE@thread.v2&amp;messageId=0">Mødeindstillinger</a>';
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'none' });
  });
});

describe('extractJoinLinkFromBody — spoofs', () => {
  it.each([
    ['path spoof', 'https://evil.example/teams.microsoft.com/meet/399000000000001?p=FaKe'],
    ['http downgrade', 'http://teams.microsoft.com/meet/399000000000001?p=FaKe'],
  ])('returns invalid for a %s, even inside the invitation block', (_label, url) => {
    expect(extractJoinLinkFromBody(inviteBlock(url))).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['suffix spoof', 'https://teams.microsoft.com.evil.example/l/meetup-join/19%3ameeting_X%40thread.v2/0', 'teams.microsoft.com.evil.example'],
    ['subdomain spoof', 'https://evil.teams.microsoft.com/meet/399000000000001?p=FaKe', 'evil.teams.microsoft.com'],
    ['Microsoft host we do not know yet', 'https://teams.cloud.microsoft/meet/399000000000001?p=FaKe0001', 'teams.cloud.microsoft'],
  ])('returns unknown_teams_host for a %s, naming the host', (_label, url, host) => {
    expect(extractJoinLinkFromBody(inviteBlock(url))).toEqual({ ok: false, reason: 'unknown_teams_host', hosts: [host] });
  });

  it('returns unknown_teams_host for a spoofed host hidden inside a Safe Links wrapper', () => {
    const body = `<a href="${safeLink('https://teams.microsoft.com.evil.example/meet/1?p=x').replace(/&/g, '&amp;')}">x</a>`;
    expect(extractJoinLinkFromBody(body)).toEqual({
      ok: false,
      reason: 'unknown_teams_host',
      hosts: ['teams.microsoft.com.evil.example'],
    });
  });

  it.each([
    ['userinfo before a Teams host', 'https://evil.example@teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0'],
    ['userinfo hiding another host', 'https://teams.microsoft.com@evil.example/l/meetup-join/19%3ameeting_X%40thread.v2/0'],
    ['a non-default port', 'https://teams.microsoft.com:8443/meet/1?p=x'],
    ['a backslash trick', 'https://evil.example\\@teams.microsoft.com/meet/1?p=x'],
    ['javascript:', 'javascript:alert(1)//teams.microsoft.com/meet/1/'],
  ])('returns invalid for %s in the invitation block (red team 06c–06i)', (_label, url) => {
    expect(extractJoinLinkFromBody(inviteBlock(url))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses when the invitation block holds an unusable link, instead of taking a link from the text', () => {
    const body = `<p><a href="${SHORT}">forrige møde</a></p>` + inviteBlock('https://teams.cloud.microsoft/meet/1?p=x');
    expect(extractJoinLinkFromBody(body)).toEqual({
      ok: false,
      reason: 'unknown_teams_host',
      hosts: ['teams.cloud.microsoft'],
    });
    const broken = `<p><a href="${SHORT}">forrige møde</a></p>` + inviteBlock('http://teams.microsoft.com/meet/1?p=x');
    expect(extractJoinLinkFromBody(broken)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('returns invalid, not none, for a Safe Links nest deeper than validateTeamsUrl unwraps (red team 03c)', () => {
    const body = `<a href="${safeLink(safeLink(safeLink(safeLink(MEETUP_JOIN)))).replace(/&/g, '&amp;')}">x</a>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('still unwraps a nest of three (red team 03b)', () => {
    const body = `<a href="${safeLink(safeLink(safeLink(MEETUP_JOIN))).replace(/&/g, '&amp;')}">x</a>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: MEETUP_JOIN, source: 'href' });
  });

  it('returns invalid for a lookalike Safe Links host', () => {
    const body = `<a href="https://safelinks.protection.outlook.com.evil.example/?url=${encodeURIComponent(SHORT)}">x</a>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('ignores a spoof when the body also holds the real link', () => {
    const body = `<p>https://teams.microsoft.com.evil.example/meet/1?p=x</p>${inviteBlock(SHORT)}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'invite-block' });
  });
});

describe('extractJoinLinkFromBody — several meetings', () => {
  it('returns multiple_distinct for two different meetings outside any invitation block', () => {
    const body = `<p>Mandag: <a href="${SHORT}">her</a></p><p>Tirsdag: ${OTHER_MEETUP_JOIN}</p>`;
    expect(extractJoinLinkFromBody(body)).toEqual({
      ok: false,
      reason: 'multiple_distinct',
      urls: [SHORT, OTHER_MEETUP_JOIN],
    });
  });

  it('returns multiple_distinct for two different meetings in plain text', () => {
    const body = `Deltag<${SHORT}>\nEller<${OTHER_SHORT}>`;
    expect(extractJoinLinkFromBody(body)).toMatchObject({ ok: false, reason: 'multiple_distinct' });
  });

  it("prefers Microsoft's invitation block over a link the organizer typed above it", () => {
    const body =
      `<p>Forrige møde var her: <a href="${OTHER_MEETUP_JOIN.replace(/&/g, '&amp;')}">link</a></p>` +
      fixture('teams-invite-meet-short.html');
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'invite-block' });
  });

  it('returns multiple_distinct when two invitation blocks point at different meetings', () => {
    const body = inviteBlock(SHORT) + inviteBlock(OTHER_SHORT);
    expect(extractJoinLinkFromBody(body)).toEqual({
      ok: false,
      reason: 'multiple_distinct',
      urls: [SHORT, OTHER_SHORT],
    });
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named and numeric entities in a single pass', () => {
    expect(decodeHtmlEntities('a&amp;b &lt;x&gt; &#58;&#x2f; &amp;lt;')).toBe('a&b <x> :/ &lt;');
  });

  it('keeps unknown and out-of-range entities as they are', () => {
    expect(decodeHtmlEntities('&bogus; &#0; &#x110000;')).toBe('&bogus; &#0; &#x110000;');
  });
});

// Red-team cases (2026-10-20 review of the spike skeleton). A and B are two
// different meetings; the numbers refer to the red team's case list.
const MJ = (thread: string) =>
  `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${thread}%40thread.v2/0` +
  `?context=%7b%22Tid%22%3a%22${FAKE_TID}%22%2c%22Oid%22%3a%22${FAKE_OID}%22%7d`;
const A = MJ('AAAA');
const B = MJ('BBBB');
const amp = (s: string) => s.replace(/&/g, '&amp;');
/** A whole Teams block, as an organizer would copy it from another invitation. */
const wholeBlock = (href: string) =>
  `<div><a id="meet_invite_block.action.join_link" class="me-email-headline" href="${amp(href)}">Deltag i mødet nu</a></div>` +
  `<div><a id="meet_invite_block.action.organizer_meet_options" href="https://teams.microsoft.com/meetingOptions/?organizerId=${FAKE_OID}&amp;tenantId=${FAKE_TID}">Mødeindstillinger</a></div>`;

describe('extractJoinLinkFromBody — content the organizer cannot see', () => {
  it("ignores another meeting's invitation block inside a comment (04)", () => {
    const body = `<!-- ${wholeBlock(B)} --><p><a href="${amp(A)}">Deltag</a></p>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'href' });
  });

  it('ignores a commented-out link next to the real block (04b)', () => {
    const body = `<!-- <a href="${amp(B)}">gammelt</a> -->${wholeBlock(A)}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'invite-block' });
  });

  it('ignores Outlook conditional comments', () => {
    const body = `<!--[if mso]>${wholeBlock(B)}<![endif]-->${wholeBlock(A)}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'invite-block' });
  });

  it('treats an unterminated comment as running to the end of the body', () => {
    expect(extractJoinLinkFromBody(`<p>x</p><!-- ${wholeBlock(B)}`)).toEqual({ ok: false, reason: 'none' });
  });

  it.each([
    ['<style>', `<style>.x{background:url(${B})}</style>`],
    ['<script>', `<script>var u = "${B}";</script>`],
    ['<head>', `<head><title>${B}</title><meta name="x" content="${amp(B)}"></head><body>`],
    ['<head> without </head>', `<head><title>${B}</title><body>`],
  ])('ignores a link inside %s (04c)', (_label, prefix) => {
    const body = `${prefix}<p><a href="${amp(A)}">x</a></p>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'href' });
  });

  it.each([
    ['display:none', '<div style="display:none">'],
    ['display: none !important, after another rule', '<div style="color:red; DISPLAY : none !important">'],
    ['visibility:hidden', '<div style="visibility:hidden">'],
    ['the hidden attribute', '<div hidden>'],
    ['an entity-encoded style', '<div style="display&#58;none">'],
  ])("ignores another meeting's invitation block hidden by %s (04d)", (_label, open) => {
    const body = `${open}${wholeBlock(B)}</div><p><a href="${amp(A)}">x</a></p>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'href' });
  });

  it('ignores a hidden link, and hidden visible-text copies of it, next to the real block (04e)', () => {
    const body = `<div style="display:none"><a href="${amp(B)}">x</a> ${B}</div>${wholeBlock(A)}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'invite-block' });
  });

  it('ignores a hidden anchor even when the anchor itself carries the hiding style', () => {
    const body =
      `<a id="meet_invite_block.action.join_link" style="display:none" href="${amp(B)}">x</a>` +
      `<p><a href="${amp(A)}">x</a></p>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'href' });
  });

  it('keeps the hidden region to its element: nested tags and a sloppy unclosed <p> inside', () => {
    const body =
      `<div style="display:none"><div><p>${wholeBlock(B)}<p>mere</div></div>` +
      `<div><span>synligt</span>${wholeBlock(A)}</div>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'invite-block' });
  });

  it('does not end a hidden region at a stray end tag of another name', () => {
    const body = `<div style="display:none"></span></p>${wholeBlock(B)}</div>${wholeBlock(A)}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'invite-block' });
  });

  it('a hidden element left open hides the rest of the body', () => {
    const body = `<p><a href="${amp(A)}">x</a></p><div style="display:none">${wholeBlock(B)}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'href' });
  });

  it('a hidden void element hides only itself', () => {
    const body = `<img hidden src="${amp(B)}">${wholeBlock(A)}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'invite-block' });
  });

  it('does not read plain-text <url> or <name@example> as tags that could hide anything', () => {
    const body = `Fra: Peter <peter@example.invalid>\nDeltag<${SHORT}&hidden=1>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: `${SHORT}&hidden=1`, source: 'text' });
  });

  // 07c cannot be solved here: with the organizer's own block deleted and another
  // meeting's whole block pasted in, the body is indistinguishable from a genuine
  // invitation for B. The add-in therefore sends the item's start and end, and the
  // server MUST refuse when they differ from Graph's for the resolved meeting
  // (packages 3 and 6). This test pins the limitation so nobody mistakes it for a fix.
  it("cannot tell a pasted foreign block from the meeting's own (07c): the server's start/end check must", () => {
    expect(extractJoinLinkFromBody(`<p>Dagsorden</p>${wholeBlock(B)}`)).toEqual({
      ok: true,
      url: B,
      source: 'invite-block',
    });
  });

  it('still refuses when a foreign block is pasted next to the own block (07b)', () => {
    expect(extractJoinLinkFromBody(`${wholeBlock(B)}<p>---</p>${wholeBlock(A)}`)).toEqual({
      ok: false,
      reason: 'multiple_distinct',
      urls: [B, A],
    });
  });
});

describe('extractJoinLinkFromBody — channel meetings', () => {
  const channel = (message: string) =>
    `https://teams.microsoft.com/l/meetup-join/19%3aRkFLRV9DSEFOTkVM%40thread.tacv2/${message}` +
    `?context=%7b%22Tid%22%3a%22${FAKE_TID}%22%2c%22Oid%22%3a%22${FAKE_OID}%22%7d`;

  it('tells two meetings in one channel apart by their message id (13)', () => {
    const one = channel('1700000000001');
    const two = channel('1700000000002');
    const body = `<a href="${amp(one)}">x</a> <a href="${amp(two)}">y</a>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'multiple_distinct', urls: [one, two] });
  });

  it('still treats one channel meeting written twice as one', () => {
    const one = channel('1700000000001');
    const body = `<a href="${amp(one)}">x</a> ${one.replace('%3a', '%3A')}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: one, source: 'href' });
  });

  it('keys an already-decoded thread segment like its encoded twin (05c)', () => {
    const decoded = 'https://teams.microsoft.com/l/meetup-join/19:meeting_AAAA@thread.v2/0';
    expect(extractJoinLinkFromBody(`<a href="${amp(A)}">x</a> ${decoded}`)).toEqual({
      ok: true,
      url: A,
      source: 'href',
    });
  });
});

describe('extractJoinLinkFromBody — truncated and wrapped plain-text links', () => {
  it('joins a <url> that Outlook wrapped over two lines (09)', () => {
    const body = `Deltag i mødet nu<${A.slice(0, 60)}\n${A.slice(60)}>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'text' });
  });

  it('joins a <url> wrapped inside the meetup-join thread id, with CRLF and indentation (09b)', () => {
    const body = `Deltag<${A.slice(0, 59)}\r\n   ${A.slice(59)}>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'text' });
  });

  it('joins a /meet/ <url> wrapped before ?p= (09c)', () => {
    const body = `Deltag<https://teams.microsoft.com/meet/399000000000001\n?p=FaKeFaKeFaKe0001>`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'text' });
  });

  it('never returns a bare link cut off inside a % escape (09, no brackets)', () => {
    const body = `Deltag i mødet nu ${A.slice(0, 60)}\n${A.slice(60)}`;
    expect(A.slice(0, 60)).toMatch(/%$/);
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never returns a bare link cut off after one hex digit of an escape', () => {
    const body = `Deltag ${A.slice(0, 61)}\n${A.slice(61)}`;
    expect(A.slice(0, 61)).toMatch(/%[0-9a-f]$/i);
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never returns a bare meetup-join link cut off before @thread (09b, no brackets)', () => {
    const body = 'Deltag https://teams.microsoft.com/l/meetup-join/19%3ameeting_AAAA\n%40thread.v2/0?context=x';
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('requires the message segment after the thread id', () => {
    const body = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_AAAA%40thread.v2';
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not join across a blank line or a closing bracket', () => {
    const body = `Deltag<${SHORT}>\nhttps://teams.microsoft.com/meet/399000000000002?p=FaKeFaKeFaKe0002`;
    expect(extractJoinLinkFromBody(body)).toMatchObject({ ok: false, reason: 'multiple_distinct' });
  });
});

describe('extractJoinLinkFromBody — documented safe refusals', () => {
  // 5b: a double-percent-encoded copy (`%253a…%2540thread`). validateTeamsUrl accepts
  // it as a URL, but one decode yields no `@thread`, so it is not a usable meetup-join
  // link, and we never decode a second layer to make it one: that would accept links
  // Graph's exact-match `JoinWebUrl eq` cannot find. On its own it is refused. The
  // red team saw `multiple_distinct` next to a valid link; since a cut-off or broken
  // join link now counts as `invalid`, it is outvoted by the valid link instead, by
  // the same rule as a spoof next to the real link. Either way it is never returned.
  it('refuses a double-percent-encoded link on its own as invalid (05b)', () => {
    expect(extractJoinLinkFromBody(`<p>${A.replace(/%/g, '%25')}</p>`)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never returns the double-encoded copy next to the valid link (05b)', () => {
    const body = `<a href="${amp(A)}">x</a> ${A.replace(/%/g, '%25')}`;
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: A, source: 'href' });
  });
});

describe('extractJoinLinkFromBody — size and time', () => {
  it('refuses a body above MAX_BODY_LENGTH as too_large, unread', () => {
    const body = inviteBlock(SHORT) + ' '.repeat(MAX_BODY_LENGTH);
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reads a body of exactly MAX_BODY_LENGTH', () => {
    const block = inviteBlock(SHORT);
    const body = block + ' '.repeat(MAX_BODY_LENGTH - block.length);
    expect(extractJoinLinkFromBody(body)).toEqual({ ok: true, url: SHORT, source: 'invite-block' });
  });

  const KB400 = 400_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(KB400 / unit.length)).slice(0, KB400);

  it.each([
    ['unclosed <a  (quadratic with [^>]*)', fill('<a ')],
    ['unclosed <a href=x ', fill('<a href=x ')],
    ['one long attribute name with no =', `<a ${'a'.repeat(KB400)}>`],
    ['open tags with no end tags', fill('<div style="display:none">')],
    ['end tags with no open tags', fill('</div>')],
    ['alternating open p and end div', fill('<p></div>')],
    ['unterminated comments', fill('<!--')],
    ['unterminated <style', fill('<style>')],
    ['angle URL with no closing bracket', fill('<https://teams.microsoft.com/meet/1\n')],
    ['https:// repeated', fill('https://')],
    ['entity starts', fill('&a')],
    ['a URL ending in many closing brackets', `https://teams.microsoft.com/meet/1?p=x${')'.repeat(KB400)}`],
    ['nested %25', `https://eur02.safelinks.protection.outlook.com/?url=${'%25'.repeat(KB400 / 3)}teams.microsoft.com/meet/1/`],
  ])('finishes a 400 KB pathological body (%s) in under 200 ms', (_label, body) => {
    extractJoinLinkFromBody(body.slice(0, 1000)); // warm the JIT
    const started = performance.now();
    extractJoinLinkFromBody(body);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
