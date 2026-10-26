/**
 * Finds the Teams join link in an Outlook meeting body.
 *
 * The Outlook add-in has nothing else to go on: AppointmentCompose exposes no
 * online-meeting or join-URL property, so the invitation body Teams writes into
 * the meeting is the only source (plan §3 F1). The same function is meant to run
 * in the add-in's task pane and, later, on the server (package 6), so it is plain
 * string work with no DOM.
 *
 * What it accepts:
 *   - an HTML body (`body.getAsync(Html)`) or a plain-text one (`Text`), or a
 *     pasted fragment of either, up to `MAX_BODY_LENGTH` characters;
 *   - classic `teams.microsoft.com/l/meetup-join/<thread>/<message>` links and the
 *     newer `/meet/<id>?p=…` short links (also on teams.live.com);
 *   - links in `href` attributes and links in visible text, including a plain-text
 *     `text<url>` link that Outlook wrapped over several lines;
 *   - HTML entities (`&amp;`, `&#58;`, …) and Safe Links-wrapped hrefs.
 *
 * What it ignores: comments, `<style>`, `<script>`, `<head>`, and any element with
 * an inline `display:none`, `visibility:hidden` or a `hidden` attribute. None of
 * that is shown to the organizer, so a link there must not decide which meeting the
 * add-in arms. This is best effort — CSS has more ways to hide text than a string
 * scan can know (classes, `font-size:0`, off-screen positioning) — and it cannot
 * catch the remaining case at all: the organizer deletes their own Teams block and
 * pastes another meeting's whole block in its place. That body is indistinguishable
 * from a genuine one. The only defence is on the server: the add-in sends the item's
 * start and end along with the link, and the server MUST refuse when they differ
 * from the start and end Graph returns for the resolved meeting (packages 3 and 6).
 *
 * Validation and Safe Links unwrapping are not done here: every candidate goes
 * through `validateTeamsUrl()` from `src/lib/teams/url.ts`, so a link accepted
 * here is exactly a link the paste-link flow would accept, and the URL returned
 * is the same normalized href that flow hands to Graph's `JoinWebUrl eq` filter.
 *
 * When a body holds several links, the one in Microsoft's invitation block wins:
 * the join anchor Teams writes carries `id="meet_invite_block.action.join_link"`
 * (current invitations) or `class="me-email-headline"` (older ones), in Outlook
 * on the web sometimes prefixed `x_`. A link the organizer typed into their own
 * text above the block is therefore not mistaken for this meeting. And if the
 * block's own link is broken, no other link stands in for it.
 *
 * Every pass is linear in the body's length: a body is attacker-influenced input
 * (anyone can send an invitation), and the server will run this too.
 */

import { extractJoinContext, isAllowedTeamsHost, isSafeLinksHost, validateTeamsUrl } from '@/lib/teams/url';

/** Where the winning link was found, best first. */
export type JoinLinkSource = 'invite-block' | 'href' | 'text';

/** Bodies above this are refused unread. A Teams invitation is a few KB; Outlook
 *  references inline images by `cid:` rather than embedding them. */
export const MAX_BODY_LENGTH = 1_000_000;

export type JoinLinkFromBody =
  | { ok: true; url: string; source: JoinLinkSource }
  /** Nothing that looks like a Teams join link. In new Outlook / on the web, this is
   *  what an appointment looks like before it has been sent (plan §3 F1). */
  | { ok: false; reason: 'none' }
  /** Something looks like a Teams join link but fails validation: `http:`, userinfo
   *  or a port, a broken or too deeply nested Safe Links wrapper, a link cut off
   *  mid-way (no thread id, or ending inside a `%` escape). */
  | { ok: false; reason: 'invalid' }
  /** A join path on a host that contains `teams.` but is not one we accept: a
   *  lookalike (`teams.microsoft.com.evil.example`) or a Microsoft host we don't know
   *  yet (`teams.cloud.microsoft`). Reported apart from `invalid`, because the second
   *  kind means this code needs updating, not that the user did something wrong. */
  | { ok: false; reason: 'unknown_teams_host'; hosts: string[] }
  /** Links to more than one meeting, and no single one in Microsoft's block. */
  | { ok: false; reason: 'multiple_distinct'; urls: string[] }
  /** Longer than `MAX_BODY_LENGTH`. */
  | { ok: false; reason: 'too_large' };

export type JoinLinkFailureReason = Extract<JoinLinkFromBody, { ok: false }>['reason'];

const SOURCE_RANK: Record<JoinLinkSource, number> = { 'invite-block': 0, href: 1, text: 2 };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  sol: '/',
  colon: ':',
  quest: '?',
  equals: '=',
  percnt: '%',
  num: '#',
};

/** Decodes the HTML entities a mail body realistically carries. Single pass, so
 *  `&amp;lt;` becomes `&lt;`, not `<`. Unknown or out-of-range entities are kept. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// --- Linear-time patterns ----------------------------------------------------
//
// `[^<>]*` in the tag patterns stops at the next `<`, so a failed match costs at
// most the distance to the next tag; with `[^>]*` a body of unclosed `<a ` repeats
// rescanned to the end from every one of them (quadratic: 400 KB took 5.6 s).
// Attribute values in mail HTML don't contain a raw `<` or `>` (they are `&lt;`).

/** Opening `<a …>` tags. */
const ANCHOR_RE = /<a\b([^<>]*)>/gi;

/** Any start or end tag. The name must be followed by whitespace, `/` or `>`, so a
 *  plain-text `<https://…>` or `<name@example.dk>` is not taken for a tag. Office's
 *  namespaced tags (`<o:p>`) are allowed. */
const TAG_RE = /<(\/?)([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)(?=[\s/>])([^<>]*)>/gi;

/** The value is optional, so a run of name characters without `=` is consumed as
 *  one (boolean) attribute. With a mandatory `=`, such a run was rescanned from
 *  every position in it. */
const ATTR_RE = /([a-z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;

/** An http(s) URL in text: stops at whitespace (incl. nbsp), quotes, angle brackets
 *  and backticks, which is how plain-text Outlook bodies delimit them (`text<url>`). */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** A URL in angle brackets, which is how plain-text Outlook bodies write a link, and
 *  where a long one may be wrapped over several lines. The line breaks are joined
 *  back out. Each repetition must start after a line break, so this is unambiguous
 *  and linear. */
const ANGLE_URL_RE = /<(https?:\/\/[^\s<>"'`]+(?:[ \t]*\r?\n[ \t]*[^\s<>"'`]+)*)>/gi;

/** Content no reader sees. `<head` also ends at `<body`, since `</head>` is optional. */
const HIDDEN_BLOCK_OPEN_RE = /<!--|<(style|script|head)(?=[\s/>])/gi;
const HIDDEN_BLOCK_CLOSE_RE: Record<string, RegExp> = {
  comment: /-->/g,
  style: /<\/style\s*>/gi,
  script: /<\/script\s*>/gi,
  head: /<\/head\s*>|(?=<body[\s/>])/gi,
};

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const INVITE_BLOCK_ID_RE = /^(?:x_)?meet_invite_block\.action\.join_link$/i;
const INVITE_BLOCK_CLASS_RE = /(?:^|\s)(?:x_)?me-email-headline(?:\s|$)/i;

const HIDING_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

function parseAttributes(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

/**
 * Removes comments and `<style>`, `<script>` and `<head>` blocks. An unterminated
 * one runs to the end of the body, as it would in a browser: dropping too much
 * can only cost a link (`none`), never pick a wrong one.
 */
function stripUnrenderedBlocks(html: string): string {
  const parts: string[] = [];
  let pos = 0;
  for (;;) {
    HIDDEN_BLOCK_OPEN_RE.lastIndex = pos;
    const open = HIDDEN_BLOCK_OPEN_RE.exec(html);
    if (!open) {
      parts.push(html.slice(pos));
      break;
    }
    parts.push(html.slice(pos, open.index), ' ');
    const close = HIDDEN_BLOCK_CLOSE_RE[open[1] ? open[1].toLowerCase() : 'comment'];
    close.lastIndex = open.index + open[0].length;
    const end = close.exec(html);
    if (!end) break;
    pos = end.index + end[0].length;
  }
  return parts.join('');
}

function isHidingTag(attrs: string): boolean {
  const parsed = parseAttributes(attrs);
  return parsed.has('hidden') || HIDING_STYLE_RE.test(parsed.get('style') ?? '');
}

/**
 * Removes every element hidden by an inline style or the `hidden` attribute,
 * descendants included. Tags are matched the way a browser recovers sloppy HTML:
 * an end tag closes the nearest open element of that name and everything opened
 * inside it, and an end tag with no open element of that name is ignored. Like a
 * browser, `/>` on a non-void element does not close it.
 */
function dropHiddenElements(html: string): string {
  const stack: Array<{ name: string; hiding: boolean }> = [];
  const openCount = new Map<string, number>();
  let hidingDepth = 0;
  const parts: string[] = [];
  let pos = 0;

  for (const m of html.matchAll(TAG_RE)) {
    const name = m[2].toLowerCase();
    const at = m.index ?? 0;

    if (m[1] === '/') {
      // The count check keeps this linear: we only walk the stack when the walk
      // ends at a match, and every element walked past is popped for good.
      if (!openCount.get(name)) continue;
      for (;;) {
        const top = stack.pop();
        if (!top) break;
        openCount.set(top.name, (openCount.get(top.name) ?? 1) - 1);
        if (top.hiding) hidingDepth -= 1;
        if (top.name === name) break;
      }
      if (hidingDepth === 0 && pos === -1) {
        parts.push(' ');
        pos = at + m[0].length;
      }
      continue;
    }

    const hiding = isHidingTag(m[3]);
    if (VOID_ELEMENTS.has(name)) {
      if (hiding && hidingDepth === 0) {
        parts.push(html.slice(pos, at), ' ');
        pos = at + m[0].length;
      }
      continue;
    }
    if (hiding && hidingDepth === 0) {
      parts.push(html.slice(pos, at));
      pos = -1;
    }
    stack.push({ name, hiding });
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
    if (hiding) hidingDepth += 1;
  }

  // A hidden element left open hides the rest, as in a browser.
  if (pos !== -1) parts.push(html.slice(pos));
  return parts.join('');
}

/** Trailing sentence punctuation is not part of a URL typed into text. A closing
 *  bracket is kept only when the URL also opened one. */
function trimTrailingPunctuation(url: string): string {
  const hasParen = url.includes('(');
  const hasBracket = url.includes('[');
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if ('.,;:!?'.includes(last) || (last === ')' && !hasParen) || (last === ']' && !hasBracket)) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

/** Percent-decodes as many layers as a Safe Links nest could plausibly hold, and one
 *  more than `validateTeamsUrl` unwraps, so a too-deep nest is still recognised as a
 *  Teams link (and reported `invalid`) instead of vanishing into `none`. Tolerates
 *  malformed escapes. Only used to classify. */
const CLASSIFY_DECODE_DEPTH = 8;

function looselyDecoded(raw: string): string {
  let out = raw;
  for (let i = 0; i < CLASSIFY_DECODE_DEPTH; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(out);
    } catch {
      break;
    }
    if (next === out) break;
    out = next;
  }
  // Fullwidth dots and the like are folded, as URL's IDNA step folds them.
  return out.normalize('NFKC');
}

/**
 * Does this (loosely decoded) string try to be a Teams join link? Deliberately
 * loose — any host with `teams.` in it counts, so that a lookalike or a new
 * Microsoft host is reported rather than silently treated as `none`. Acceptance is
 * `validateTeamsUrl`'s job, not this function's.
 */
function looksLikeTeamsJoinLink(decoded: string): boolean {
  return /teams\./i.test(decoded) && /\/(?:l\/meetup-join|meet)\//i.test(decoded);
}

const HOST_IN_TEXT_RE = /https?:\/\/([^/?#\s"'<>\\]+)/gi;

/** Hosts in the (decoded) candidate that contain `teams.` but are neither accepted
 *  Teams hosts nor Safe Links wrappers. */
function unknownTeamsHosts(decoded: string): string[] {
  const out: string[] = [];
  for (const m of decoded.matchAll(HOST_IN_TEXT_RE)) {
    const authority = m[1];
    const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase();
    if (host.includes('teams.') && !isAllowedTeamsHost(host) && !isSafeLinksHost(host)) out.push(host);
  }
  return out;
}

/** `…%` or `…%3`: a link cut off inside an escape, typically by a line break. */
function endsMidEscape(url: string): boolean {
  return /%[0-9a-f]?$/i.test(url);
}

function pathSegments(url: string): string[] {
  return new URL(url).pathname.split('/').filter(Boolean);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * What kind of Teams URL a validated link is. `meetup-join` needs a thread id and
 * the message segment after it; without them the link was cut short (plain text
 * wrapped mid-link), and a cut link may still resolve to some other meeting.
 */
function joinPathKind(url: string): 'meetup-join' | 'meet' | 'broken' | null {
  const segs = pathSegments(url);
  if (segs[0]?.toLowerCase() === 'l' && segs[1]?.toLowerCase() === 'meetup-join') {
    return extractJoinContext(url).threadId && segs[3] ? 'meetup-join' : 'broken';
  }
  if (segs[0]?.toLowerCase() === 'meet' && segs.length === 2) return 'meet';
  return null;
}

/**
 * Identity of the meeting a link points at, so the same meeting written twice
 * (wrapped and unwrapped, `%3a` and `%3A`, href and `originalsrc`) is one meeting.
 * A meetup-join link is keyed on thread *and* message id: every meeting held in one
 * Teams channel shares the channel's thread id, and only the message segment tells
 * them apart. Ids are case-sensitive (base64), so nothing is lowercased but the host.
 */
function meetingKey(url: string, kind: 'meetup-join' | 'meet'): string {
  const segs = pathSegments(url);
  if (kind === 'meetup-join') return `thread:${extractJoinContext(url).threadId}/${safeDecode(segs[3])}`;
  return `meet:${new URL(url).hostname}:${segs[1]}`;
}

type Verdict =
  | { kind: 'hit'; url: string; key: string }
  | { kind: 'invalid' }
  | { kind: 'unknown_host'; hosts: string[] }
  | { kind: 'skip' };

function judge(value: string): Verdict {
  const decoded = looselyDecoded(value);
  if (!looksLikeTeamsJoinLink(decoded)) return { kind: 'skip' };
  if (endsMidEscape(value.trim())) return { kind: 'invalid' };

  const check = validateTeamsUrl(value);
  if (!check.ok) {
    const hosts = unknownTeamsHosts(decoded);
    return hosts.length > 0 ? { kind: 'unknown_host', hosts } : { kind: 'invalid' };
  }
  if (endsMidEscape(check.url)) return { kind: 'invalid' };

  const kind = joinPathKind(check.url);
  if (kind === null) return { kind: 'skip' };
  if (kind === 'broken') return { kind: 'invalid' };
  return { kind: 'hit', url: check.url, key: meetingKey(check.url, kind) };
}

interface Hit {
  url: string;
  key: string;
  source: JoinLinkSource;
}

interface Failures {
  invalid: boolean;
  hosts: string[];
}

function failureResult(f: Failures): JoinLinkFromBody {
  if (f.hosts.length > 0) return { ok: false, reason: 'unknown_teams_host', hosts: [...new Set(f.hosts)] };
  return { ok: false, reason: f.invalid ? 'invalid' : 'none' };
}

/** Text-pass candidates: angle-bracketed URLs first (joined across line breaks),
 *  then bare URLs that don't lie inside one of those. */
function textCandidates(text: string): string[] {
  const out: string[] = [];
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(ANGLE_URL_RE)) {
    const at = m.index ?? 0;
    ranges.push([at, at + m[0].length]);
    out.push(m[1].replace(/[ \t]*\r?\n[ \t]*/g, ''));
  }
  let r = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    while (r < ranges.length && ranges[r][1] <= at) r += 1;
    if (r < ranges.length && ranges[r][0] <= at) continue;
    out.push(trimTrailingPunctuation(m[0]));
  }
  return out;
}

export function extractJoinLinkFromBody(body: string): JoinLinkFromBody {
  if (typeof body !== 'string' || body.length === 0) return { ok: false, reason: 'none' };
  if (body.length > MAX_BODY_LENGTH) return { ok: false, reason: 'too_large' };

  const visible = dropHiddenElements(stripUnrenderedBlocks(body));

  const raw: Array<{ value: string; source: JoinLinkSource }> = [];

  for (const m of visible.matchAll(ANCHOR_RE)) {
    const attrs = parseAttributes(m[1]);
    const href = attrs.get('href');
    if (!href) continue;
    const inBlock =
      INVITE_BLOCK_ID_RE.test(attrs.get('id') ?? '') || INVITE_BLOCK_CLASS_RE.test(attrs.get('class') ?? '');
    raw.push({ value: href, source: inBlock ? 'invite-block' : 'href' });
  }

  // Visible text, plain-text bodies, and attribute values the anchor pass doesn't
  // read (Outlook's `originalsrc`). Duplicates of hrefs are harmless: they collapse
  // onto the same meeting key, and the better source is kept.
  for (const value of textCandidates(decodeHtmlEntities(visible))) raw.push({ value, source: 'text' });

  const hits: Hit[] = [];
  const all: Failures = { invalid: false, hosts: [] };
  const block: Failures = { invalid: false, hosts: [] };
  for (const { value, source } of raw) {
    const verdict = judge(value);
    if (verdict.kind === 'skip') continue;
    if (verdict.kind === 'hit') {
      hits.push({ url: verdict.url, key: verdict.key, source });
      continue;
    }
    for (const f of source === 'invite-block' ? [all, block] : [all]) {
      if (verdict.kind === 'invalid') f.invalid = true;
      else f.hosts.push(...verdict.hosts);
    }
  }

  const inBlock = hits.filter((h) => h.source === 'invite-block');
  // Microsoft's block is there but its link is unusable: refuse, rather than let a
  // link from the organizer's own text stand in for this meeting.
  if (inBlock.length === 0 && (block.invalid || block.hosts.length > 0)) return failureResult(block);
  const pool = inBlock.length > 0 ? inBlock : hits;

  const byMeeting = new Map<string, Hit>();
  for (const hit of pool) {
    const seen = byMeeting.get(hit.key);
    if (!seen || SOURCE_RANK[hit.source] < SOURCE_RANK[seen.source]) byMeeting.set(hit.key, hit);
  }

  if (byMeeting.size === 1) {
    const [only] = byMeeting.values();
    return { ok: true, url: only.url, source: only.source };
  }
  if (byMeeting.size > 1) {
    return { ok: false, reason: 'multiple_distinct', urls: [...byMeeting.values()].map((h) => h.url) };
  }
  return failureResult(all);
}
