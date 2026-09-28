#!/usr/bin/env node
// Mock Microsoft Graph for local testing of the Teams integration.
//
// Serves just enough of https://graph.microsoft.com/v1.0 for src/lib/teams/*:
// /me, /me/calendarView, /me/onlineMeetings (filter by JoinWebUrl, get, PATCH),
// transcripts (VTT) and recordings (302 to an off-origin blob, like real Graph).
// Zero dependencies. Point the app at it with GRAPH_BASE_URL=http://localhost:4010/v1.0
// and link the signed-in user to a fake Microsoft account with seed-account.mjs.
//
// Control endpoints (no auth):
//   GET  /__mock/state                        everything the mock knows
//   POST /__mock/meetings/:id/end             { transcribed?: bool, recorded?: bool } — end now
//   POST /__mock/meetings/:id/reset           back to "not started"
//   POST /__mock/settings                     { policyBlocked?, transcriptsDisabled?, artifactDelayMs? }
//   POST /__mock/reset                        fresh state
//
// Env: MOCK_GRAPH_PORT (4010), MOCK_ARTIFACT_DELAY_MS (60000): how long after a
// meeting's scheduled end the artifacts appear when nobody ended it by hand.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PORT = Number(process.env.MOCK_GRAPH_PORT || 4010);
const ORIGIN = `http://localhost:${PORT}`;
// A *different* origin for the blob redirect (127.0.0.1 vs localhost) so the
// app's "drop the bearer when leaving Graph" logic is actually exercised.
const BLOB_ORIGIN = `http://127.0.0.1:${PORT}`;
const startedAt = Date.now();

// ---------------------------------------------------------------- fixtures

const ME = {
  id: 'me-0000-0000-0000-000000000001',
  displayName: 'Test Bruger',
  mail: 'test.bruger@mock.local',
  userPrincipalName: 'test.bruger@mock.local',
};
const OTHER = {
  id: 'other-0000-0000-0000-00000000002',
  displayName: 'Anden Organisator',
  mail: 'anden.organisator@mock.local',
};

// What the "meeting" contained. Real names, real Danish, two speakers, so the
// review step can show attribution. Durations are measured after synthesis.
const SCRIPT = [
  { speaker: 'Mette Hansen', text: 'Godmorgen alle sammen. Skal vi starte med status på budgettet for næste kvartal?' },
  { speaker: 'Jens Nielsen', text: 'Ja, tak. Vi ligger cirka fem procent under det forventede forbrug, primært fordi to ansættelser er udskudt.' },
  { speaker: 'Mette Hansen', text: 'Fint. Så aftaler vi, at Jens sender en opdateret prognose til økonomiudvalget inden fredag.' },
  { speaker: 'Jens Nielsen', text: 'Det gør jeg. Og så vil jeg gerne have, at vi beslutter, om borgermødet skal holdes i april eller maj.' },
  { speaker: 'Mette Hansen', text: 'Vi går med maj. Så har vi tallene klar. Tak for i dag.' },
];

function joinUrl(slug, organizerOid) {
  const ctx = encodeURIComponent(JSON.stringify({ Tid: 'mock-tenant-0000', Oid: organizerOid }));
  return `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${slug}%40thread.v2/0?context=${ctx}`;
}

function iso(msFromStart) {
  return new Date(startedAt + msFromStart).toISOString();
}

const MIN = 60_000;

function baseMeeting(id, subject, organizer, startMs, endMs, extra = {}) {
  return {
    id,
    subject,
    joinWebUrl: joinUrl(id, organizer.id),
    startDateTime: iso(startMs),
    endDateTime: iso(endMs),
    meetingType: 'scheduled',
    allowRecording: true,
    allowTranscription: true,
    recordAutomatically: false,
    meetingSpokenLanguageTag: null,
    participants: {
      organizer: { identity: { user: { id: organizer.id, displayName: organizer.displayName } } },
    },
    // mock-only bookkeeping (stripped before serialising)
    _organizer: organizer,
    _ended: null, // { at, transcribed, recorded } once the meeting is over
    _recurring: false,
    ...extra,
  };
}

function freshState() {
  const meetings = [
    baseMeeting('mtgpast', 'Afsluttet møde (artefakter klar nu)', ME, -40 * MIN, -10 * MIN, {
      _ended: { at: iso(-9 * MIN), transcribed: true, recorded: true },
      recordAutomatically: true,
      meetingSpokenLanguageTag: 'da-DK',
    }),
    baseMeeting('mtgsoon', 'Budgetmøde Q4', ME, 5 * MIN, 35 * MIN),
    baseMeeting('mtginvitee', 'Møde hvor du kun er inviteret', OTHER, 60 * MIN, 90 * MIN),
    baseMeeting('mtgweekly', 'Ugentligt afdelingsmøde', ME, 24 * 60 * MIN, 24 * 60 * MIN + 30 * MIN, {
      meetingType: 'recurring',
      _recurring: true,
    }),
  ];
  return {
    settings: {
      policyBlocked: false, // tenant policy silently ignores recordAutomatically
      transcriptsDisabled: false, // tenant blocked Graph access to transcripts (403)
      artifactDelayMs: Number(process.env.MOCK_ARTIFACT_DELAY_MS || 60_000),
    },
    meetings: Object.fromEntries(meetings.map((m) => [m.id, m])),
    log: [],
  };
}

let state = freshState();

// ---------------------------------------------------------------- media

const media = { vtt: null, mp4Path: null, durationSec: 0, how: 'none' };

function which(bin) {
  return spawnSync('which', [bin]).status === 0;
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(String(r.stdout).trim()) || 0;
}

function hms(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
}

function escapeVtt(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildVtt(cues) {
  const lines = ['WEBVTT', ''];
  cues.forEach((c, i) => {
    lines.push(String(i + 1), `${hms(c.start)} --> ${hms(c.end)}`, `<v ${c.speaker}>${escapeVtt(c.text)}</v>`, '');
  });
  return lines.join('\r\n');
}

/**
 * Synthesises the meeting audio with macOS `say` (Danish voice "Sara") so hviske
 * has real speech to transcribe, and derives the VTT cue times from the measured
 * clip lengths so speaker attribution is genuinely aligned. Falls back to a
 * tone + hand-timed VTT when `say` or ffmpeg is missing (transcript-only still works).
 */
function prepareMedia() {
  const dir = path.join(os.tmpdir(), 'mock-graph');
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('sha1').update(JSON.stringify(SCRIPT)).digest('hex').slice(0, 10);
  const mp4 = path.join(dir, `recording-${key}.mp4`);
  const vttPath = path.join(dir, `transcript-${key}.vtt`);

  if (fs.existsSync(mp4) && fs.existsSync(vttPath)) {
    Object.assign(media, { vtt: fs.readFileSync(vttPath, 'utf8'), mp4Path: mp4, durationSec: probeDuration(mp4), how: 'cached' });
    return;
  }

  const haveFfmpeg = which('ffmpeg') && which('ffprobe');
  const haveSay = process.platform === 'darwin' && which('say');
  const GAP = 0.6;

  if (haveFfmpeg && haveSay) {
    const clips = [];
    for (const [i, line] of SCRIPT.entries()) {
      const aiff = path.join(dir, `clip-${key}-${i}.aiff`);
      const r = spawnSync('say', ['-v', 'Sara', '-o', aiff, line.text]);
      if (r.status !== 0) {
        console.warn('[mock-graph] `say` failed, falling back to tone:', String(r.stderr));
        break;
      }
      clips.push({ ...line, file: aiff, duration: probeDuration(aiff) });
    }
    if (clips.length === SCRIPT.length) {
      // Build cue times and a concat list with silence gaps between speakers.
      const silence = path.join(dir, `silence-${key}.aiff`);
      spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(GAP), silence]);
      const list = [];
      const cues = [];
      let t = 0;
      for (const c of clips) {
        list.push(`file '${c.file}'`);
        cues.push({ speaker: c.speaker, text: c.text, start: t, end: t + c.duration });
        t += c.duration;
        list.push(`file '${silence}'`);
        t += GAP;
      }
      const listPath = path.join(dir, `concat-${key}.txt`);
      fs.writeFileSync(listPath, list.join('\n'));
      const r = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-ar', '16000', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', mp4]);
      if (r.status === 0) {
        const vtt = buildVtt(cues);
        fs.writeFileSync(vttPath, vtt);
        Object.assign(media, { vtt, mp4Path: mp4, durationSec: t, how: 'say+ffmpeg' });
        return;
      }
      console.warn('[mock-graph] ffmpeg concat failed:', String(r.stderr).slice(-400));
    }
  }

  // Fallback: hand-timed VTT, 4s per line; a tone track if ffmpeg exists at all.
  const cues = SCRIPT.map((l, i) => ({ ...l, start: i * 4.6, end: i * 4.6 + 4 }));
  const vtt = buildVtt(cues);
  fs.writeFileSync(vttPath, vtt);
  media.vtt = vtt;
  media.durationSec = cues.at(-1).end;
  if (haveFfmpeg) {
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${media.durationSec}`, '-ar', '16000', '-ac', '1', '-c:a', 'aac', mp4]);
    if (r.status === 0) {
      media.mp4Path = mp4;
      media.how = 'tone (no `say`; hviske will hear a beep — use TEAMS_ARTIFACT_MODE=transcript-only)';
      return;
    }
  }
  media.how = 'vtt only (no ffmpeg; recordings list will be empty → transcript-only mode)';
}

// ---------------------------------------------------------------- helpers

function publicMeeting(m) {
  const out = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function endedInfo(m) {
  if (m._ended) return m._ended;
  const autoEnd = new Date(m.endDateTime).getTime() + state.settings.artifactDelayMs;
  if (Date.now() >= autoEnd && new Date(m.endDateTime).getTime() < Date.now()) {
    // Auto-end: artifacts exist only if the meeting was armed (recordAutomatically).
    return { at: new Date(autoEnd).toISOString(), transcribed: !!m.recordAutomatically, recorded: !!m.recordAutomatically, auto: true };
  }
  return null;
}

function artifactId(m, kind) {
  return `${kind}-${m.id}-${Buffer.from(m._ended?.at || endedInfo(m)?.at || 'x').toString('base64url').slice(0, 8)}`;
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  const data = isText ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(data);
}

function graphError(res, status, code, message, innerCode) {
  send(res, status, { error: { code, message, innerError: innerCode ? { code: innerCode } : undefined } });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function calendarEvents(url) {
  const from = new Date(url.searchParams.get('startDateTime') || 0).getTime();
  const to = new Date(url.searchParams.get('endDateTime') || 8.64e15).getTime();
  const events = [];
  for (const m of Object.values(state.meetings)) {
    const occurrences = m._recurring ? [0, 7, 14].map((d) => d * 24 * 60 * MIN) : [0];
    for (const [i, offset] of occurrences.entries()) {
      const start = new Date(m.startDateTime).getTime() + offset;
      const end = new Date(m.endDateTime).getTime() + offset;
      if (end < from || start > to) continue;
      events.push({
        id: m._recurring ? `evt-${m.id}-occ${i}` : `evt-${m.id}`,
        subject: m.subject,
        start: { dateTime: new Date(start).toISOString().replace('Z', '0000'), timeZone: 'UTC' },
        end: { dateTime: new Date(end).toISOString().replace('Z', '0000'), timeZone: 'UTC' },
        isOnlineMeeting: true,
        onlineMeeting: { joinUrl: m.joinWebUrl },
        organizer: { emailAddress: { name: m._organizer.displayName, address: m._organizer.mail } },
        seriesMasterId: m._recurring ? `series-${m.id}` : null,
        type: m._recurring ? 'occurrence' : 'singleInstance',
      });
    }
  }
  events.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
  return events;
}

function findByJoinUrl(filter) {
  // $filter=JoinWebUrl eq '<url>' — single quotes doubled inside the literal.
  const m = /JoinWebUrl\s+eq\s+'((?:[^']|'')*)'/i.exec(filter || '');
  if (!m) return null;
  const wanted = m[1].replace(/''/g, "'");
  return Object.values(state.meetings).find((x) => x.joinWebUrl === wanted) || null;
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  const auth = req.headers.authorization || '';
  state.log.push({ t: new Date().toISOString(), method: req.method, path: p + url.search, auth: auth ? 'bearer' : 'none' });
  if (state.log.length > 200) state.log.shift();
  console.log(`[mock-graph] ${req.method} ${p}${url.search} ${auth ? '' : '(no auth)'}`);

  try {
    // ---- control plane
    if (p === '/__mock/state') return send(res, 200, { me: ME, settings: state.settings, media: { ...media, vtt: undefined }, meetings: Object.values(state.meetings).map((m) => ({ ...publicMeeting(m), _ended: endedInfo(m), _isOrganizer: m._organizer.id === ME.id })), log: state.log.slice(-40) });
    if (p === '/__mock/reset' && req.method === 'POST') { state = freshState(); return send(res, 200, { ok: true }); }
    if (p === '/__mock/settings' && req.method === 'POST') { Object.assign(state.settings, await readJson(req)); return send(res, 200, state.settings); }
    let cm = /^\/__mock\/meetings\/([^/]+)\/(end|reset)$/.exec(p);
    if (cm && req.method === 'POST') {
      const m = state.meetings[cm[1]];
      if (!m) return send(res, 404, { error: 'unknown meeting' });
      if (cm[2] === 'reset') m._ended = null;
      else {
        const body = await readJson(req);
        m._ended = { at: new Date().toISOString(), transcribed: body.transcribed ?? true, recorded: body.recorded ?? true };
      }
      return send(res, 200, { id: m.id, ended: m._ended });
    }

    // ---- blob host (the pre-signed storage URL Graph redirects to)
    let bm = /^\/blob\/([^/]+)\.mp4$/.exec(p);
    if (bm) {
      if (auth) return send(res, 400, 'Authorization header sent to storage host — the app leaked the Graph bearer token');
      if (!media.mp4Path) return send(res, 404, 'no recording media');
      const stat = fs.statSync(media.mp4Path);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': stat.size });
      return fs.createReadStream(media.mp4Path).pipe(res);
    }

    // ---- Graph proper
    if (!p.startsWith('/v1.0/')) return send(res, 404, { error: 'not found', hint: 'Graph lives under /v1.0' });
    if (!/^Bearer\s+\S+/.test(auth)) return graphError(res, 401, 'InvalidAuthenticationToken', 'Access token is empty.');
    const g = p.slice('/v1.0'.length);

    if (g === '/me' && req.method === 'GET') return send(res, 200, ME);
    if (g === '/me/calendarView' && req.method === 'GET') return send(res, 200, { value: calendarEvents(url) });

    if (g === '/me/onlineMeetings' && req.method === 'GET') {
      const m = findByJoinUrl(url.searchParams.get('$filter'));
      return send(res, 200, { value: m ? [publicMeeting(m)] : [] });
    }

    const mm = /^\/me\/onlineMeetings\/([^/]+)(?:\/(transcripts|recordings)(?:\/([^/]+)\/content)?)?$/.exec(g);
    if (!mm) return graphError(res, 404, 'ResourceNotFound', `No route for ${g}`);
    const m = state.meetings[decodeURIComponent(mm[1])];
    if (!m) return graphError(res, 404, 'ResourceNotFound', 'Meeting not found');
    const kind = mm[2];
    const artId = mm[3];

    if (!kind) {
      if (req.method === 'GET') return send(res, 200, publicMeeting(m));
      if (req.method === 'PATCH') {
        if (m._organizer.id !== ME.id) return graphError(res, 403, 'Forbidden', 'Only the organizer can update meeting options.');
        const body = await readJson(req);
        for (const k of ['allowRecording', 'allowTranscription', 'recordAutomatically', 'meetingSpokenLanguageTag']) {
          if (k in body) m[k] = body[k];
        }
        if (state.settings.policyBlocked) m.recordAutomatically = false;
        return send(res, 200, publicMeeting(m));
      }
      return graphError(res, 405, 'MethodNotAllowed', req.method);
    }

    if (kind === 'transcripts' && state.settings.transcriptsDisabled) {
      return graphError(res, 403, 'Forbidden', 'Graph API access to transcripts is disabled for this tenant.', 'GraphAccessToTranscriptsDisabled');
    }
    const ended = endedInfo(m);
    const have = ended && (kind === 'transcripts' ? ended.transcribed : ended.recorded && media.mp4Path);
    if (!have) return graphError(res, 404, 'ResourceNotFound', `No ${kind} for this meeting yet`);
    const id = artifactId(m, kind === 'transcripts' ? 'tr' : 'rec');
    const item = {
      id,
      meetingId: m.id,
      callId: `call-${m.id}`,
      createdDateTime: ended.at,
      endDateTime: ended.at,
      contentCorrelationId: `corr-${m.id}`,
      meetingOrganizer: { user: { id: m._organizer.id, displayName: null, userIdentityType: 'aadUser' } },
    };

    if (!artId) {
      if (kind === 'transcripts') item.transcriptContentUrl = `${ORIGIN}/v1.0/me/onlineMeetings/${m.id}/transcripts/${id}/content`;
      else item.recordingContentUrl = `${ORIGIN}/v1.0/me/onlineMeetings/${m.id}/recordings/${id}/content`;
      return send(res, 200, { '@odata.count': 1, value: [item] });
    }
    if (decodeURIComponent(artId) !== id) return graphError(res, 404, 'ResourceNotFound', 'Unknown artifact id');

    if (kind === 'transcripts') {
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
      return res.end(media.vtt);
    }
    // Real Graph answers 302 to a pre-signed storage URL on another host.
    res.writeHead(302, { location: `${BLOB_ORIGIN}/blob/${id}.mp4?sig=mock-presigned` });
    return res.end();
  } catch (err) {
    console.error('[mock-graph] error', err);
    return graphError(res, 500, 'InternalServerError', String(err?.message || err));
  }
});

prepareMedia();
server.listen(PORT, () => {
  console.log(`[mock-graph] listening on ${ORIGIN}/v1.0  (media: ${media.how}, ${media.durationSec.toFixed(1)}s)`);
  console.log(`[mock-graph] app env: GRAPH_BASE_URL=${ORIGIN}/v1.0`);
  console.log('[mock-graph] meetings:');
  for (const m of Object.values(state.meetings)) {
    console.log(`  ${m.id.padEnd(12)} ${m._organizer.id === ME.id ? 'organizer' : 'invitee  '}  ${m.subject}`);
    console.log(`               ${m.joinWebUrl}`);
  }
  console.log(`[mock-graph] control: GET ${ORIGIN}/__mock/state · POST ${ORIGIN}/__mock/meetings/<id>/end`);
});
