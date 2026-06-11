import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { chromium, BrowserContext, Page } from 'playwright';
import { installWebRTCPatch } from './webrtc-patch';
import {
  newLeaveDetectorState,
  leaveDetectorTick,
  LeaveDetectorState,
} from './lib/leave-detector';
import { JoinRaceResult, isAdmitted, joinFailureMessage } from './lib/join-race';
import { isRealParticipant } from './lib/participants';

export type BotStatus = 'joining' | 'recording' | 'paused' | 'ended' | 'error';

export interface BotSessionConfig {
  meetingUrl: string;
  meetingId: string;
  userId: string;
  botName: string;
  callbackUrl: string;
  internalSecret: string;
}

// Bare aria-label="Leave" is intentionally omitted — it is too broad and matches the
// lobby's "leave the lobby" cancel button, causing a false-positive before admission.
// aria-label="Leave meeting" (and locale variants) is specific to the in-meeting toolbar.
// The [role="toolbar"]-scoped variant is safe because the lobby cancel button is not
// inside a toolbar (matches vexa's teamsInitialAdmissionIndicators).
const LEAVE_BTN = [
  '#hangup-button',
  'button[data-tid="hangup-main-btn"]',
  'button[data-tid="hangup-button"]',
  'button[aria-label="Leave meeting"]',
  'button[aria-label="Leave call"]',
  'button[aria-label="Forlad møde"]',
  'button[aria-label="Forlad opkald"]',
  '[role="toolbar"] button[aria-label*="Leave"]',
].join(', ');

// Join-now selectors — used both for clicking AND as a negative admission
// signal (if Join now is still visible we are NOT in the meeting yet).
const JOIN_NOW_BTN = [
  'button[data-tid="prejoin-join-button"]',
  'button[aria-label="Join now"]',
  '#prejoin-join-button',
  'button:has-text("Join now")',
  'button:has-text("Deltag nu")',
].join(', ');

// "Continue without audio or video" confirmation modal. Teams renders this
// intermittently (depends on media-permission cache state at page boot) and
// it BLOCKS the prejoin — Join now never enables until dismissed. Selector
// list mirrors vexa's teamsContinueWithoutMediaSelectors.
const NO_MEDIA_MODAL_BTN = [
  'button:has-text("Continue without audio or video")',
  'button[aria-label="Continue without audio or video"]',
  'button[aria-label*="Continue without audio"]',
  '[role="dialog"] button:has-text("Continue without audio or video")',
  '[role="alertdialog"] button:has-text("Continue without audio or video")',
].join(', ');

export class TeamsMeetingBot {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: BotSessionConfig;

  status: BotStatus = 'joining';
  participants: string[] = [];
  elapsed: number = 0;
  error: string | null = null;

  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private elapsedStartMs: number = 0;
  private participantTimer: ReturnType<typeof setInterval> | null = null;
  private aloneTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private audioFilePath: string = '';
  private audioWriteStream: fs.WriteStream | null = null;
  private audioChunkCount = 0;
  private readonly userDataDir: string;
  private hadActiveTracks = false;
  private hadOtherParticipants = false;
  private lastRtpPackets = -1;
  private rtpIdleChecks = 0;
  private rtpAudioIdleChecks = 0;
  private buttonCount = -1;
  private leaveDetector: LeaveDetectorState = newLeaveDetectorState();
  private onEndedCallback: (() => void) | null = null;

  constructor(config: BotSessionConfig) {
    this.config = config;
    this.userDataDir = path.join(os.tmpdir(), `bot-${config.meetingId}-${Date.now()}`);
  }

  async start(): Promise<void> {
    try {
      await this._launch();
      await this._joinMeeting();
      this.status = 'recording';
      this._startElapsedTimer();
      this._startParticipantPolling();
    } catch (err: unknown) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      console.error('[bot] Start failed:', err);
      await this._notifyNoRecording();
      await this._cleanup();
    }
  }

  private async _launch(): Promise<void> {
    // launchPersistentContext takes userDataDir as its first arg — Playwright does not
    // allow --user-data-dir in the args array when using chromium.launch().
    // Headless mode: defaults to true for local development so the bot doesn't
    // pop up a real browser window during `npm run dev`. The production Docker
    // image sets HEADLESS=false and runs Chromium against an Xvfb virtual
    // display — Teams' anti-bot heuristics detect headless mode (even Chrome's
    // new headless) and trigger post-admission "Leaving..." cascades.
    const headless = process.env.HEADLESS !== 'false';

    // Browser channel: default to MS Edge for Teams (Teams gates several code
    // paths on the Edge UA + CDP fingerprint and treats it as first-class
    // whereas Chromium can hit post-admission "Leaving..."). Falls back to
    // bundled Chromium if Edge isn't installed (arm64 / local dev), or if the
    // operator sets BROWSER_CHANNEL=chromium explicitly.
    const requestedChannel = process.env.BROWSER_CHANNEL;
    const tryChannels: (string | undefined)[] = requestedChannel === 'chromium'
      ? [undefined]
      : requestedChannel
        ? [requestedChannel, undefined]
        : ['msedge', undefined];

    const baseOpts = {
      headless,
      permissions: ['microphone', 'camera'],
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      // Remove Playwright's --enable-automation flag — Teams (and Chromium's own
      // anti-bot heuristics) gate behaviour on this flag and can refuse media
      // access or kick the session post-admission when it is set.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--incognito',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // Cross-origin iframe isolation breaks Teams' media initialisation in
        // headless Chromium and produces {"isTrusted":true} unhandled rejections
        // that cascade into "Leaving..." immediately after admission. Disabling
        // site isolation collapses Teams' SPA into a single renderer (same effect
        // as --renderer-process-limit=1 but more reliably across Playwright
        // versions). Acceptable: the bot only ever navigates to teams.microsoft.com.
        '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor',
        '--disable-site-isolation-trials',
        '--disable-infobars',
        '--disable-gpu',
        // Collapse gpu-process into the renderer. Avoids per-bot CPU bursts
        // from SwiftShader software compositing and removes a class of IPC
        // failures that surface as Event-typed unhandled rejections.
        '--in-process-gpu',
        '--hide-scrollbars',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        // No fake camera/mic flags. The gUM patch in this file substitutes a
        // canvas.captureStream() track for video (avoids the BUNDLE id=11
        // header-extension collision the built-in fake camera was producing)
        // and lets audio fall through to whatever device Chromium finds (real
        // mic on Mac dev, none in container — and the patch mutes it either
        // way). Previously --use-file-for-fake-video-capture=/dev/null was
        // supposed to swap the built-in fake camera; on Chromium it does NOT
        // do so reliably (verified locally), which is how the collision was
        // happening in the first place.
        '--allow-running-insecure-content',
        '--autoplay-policy=no-user-gesture-required',
        // Disables same-origin policy so the injected AudioContext can connect to
        // MediaStreams from cross-origin RTCPeerConnections.
        '--disable-web-security',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
        '--ignore-certificate-errors-spki-list',
        '--disk-cache-size=0',
        '--media-cache-size=0',
        // Disable extensions so Teams doesn't try to load background-page workers
        // that fail to initialise in headless mode and emit spurious error events.
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        // Prevent CPU bursts when the tab loses "focus" in headless mode
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-default-apps',
        '--disable-crash-reporter',
        '--noerrdialogs',
        '--disable-accelerated-2d-canvas',
      ],
    };

    let context: BrowserContext | null = null;
    let lastErr: unknown;
    for (const channel of tryChannels) {
      try {
        context = await chromium.launchPersistentContext(this.userDataDir, {
          ...baseOpts,
          channel,
          executablePath: channel ? undefined : (process.env.CHROMIUM_PATH || undefined),
        });
        console.log(`[bot] launched with channel=${channel ?? 'chromium'}`);
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[bot] channel=${channel ?? 'chromium'} launch failed: ${msg}`);
        // Wipe the user-data-dir so the next channel attempt starts clean
        // (a failed launch can leave a half-initialised profile that the next
        // launch refuses with "user data directory is already in use").
        await fs.promises.rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!context) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error('All browser channels failed to launch');
    }
    this.context = context;

    this.page = await this.context.newPage();

    // Forward browser console and unhandled errors to Node stdout so they appear
    // alongside bot logs. Errors show at [browser:error] to make them easy to grep.
    this.page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        console.log(`[browser:${type}]`, msg.text());
      }
    });
    this.page.on('pageerror', (err) => {
      console.log('[browser:pageerror]', err.message);
    });
    // Distinct tag for Teams' "Action failed" toast — historically the dominant
    // trigger for instant-leave regressions after admission. Logging it
    // separately makes grep find the trigger before the leave cascade.
    void this.page.exposeFunction('__botLogActionFailed', (text: string) => {
      console.log('[bot:action-failed]', text.slice(0, 200));
    });

    // Short-circuit requests that Teams makes to third-party domains which respond
    // without CORS headers. When these XHR calls fail, the browser fires a ProgressEvent
    // on the XMLHttpRequest whose onerror handler Teams passes directly to Promise.reject —
    // that event object serialises as {"isTrusted":true} in the unhandledrejection log.
    // Returning an empty 200 prevents the rejection from ever being raised.
    await this.page.route('**/admin.microsoft.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );

    // Patch getUserMedia.
    //
    // The video side is the load-bearing change: substitute Chromium's built-in
    // fake camera with a `canvas.captureStream()` video track. The built-in
    // fake camera advertises the RTP header extension `urn:3gpp:video-
    // orientation` at extmap id=11; Chromium's audio backend ALSO uses id=11
    // in some configurations, producing a BUNDLE collision on
    // `setLocalDescription` ("A BUNDLE group contains a codec collision for
    // header extension id=11"). Teams then renders "Sorry, we couldn't
    // connect you" and the call drops to "Leaving...". The canvas-sourced
    // video track is encoded by libwebrtc's screencast capturer, which uses
    // a leaner extension set (no video-orientation), so the collision can't
    // occur at the source. NB: we explicitly do NOT munge SDP at the JS
    // level — vexa's bug #281 (44 ms post-admission drop, malformed offer
    // SDP with BUNDLE enabled but rtcp-mux missing) was caused by exactly
    // that. Substituting upstream of the SDP generator avoids that class.
    //
    // The audio side stays as a real device with track.enabled=false. Do NOT
    // call track.stop() — it fires 'ended' which Teams' onended=reject
    // handler converts to a {"isTrusted":true} unhandled rejection. Do NOT
    // pass {video:false}; Teams dereferences the video track unconditionally
    // and crashes with "Failed to convert value to MediaStreamTrack".
    //
    // patched.toString() is shimmed to return the native string so anti-bot
    // fingerprinting that diffs Function.toString output doesn't flag us.
    await this.page.addInitScript(() => {
      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

      // Lazy canvas video stream — created once on first video gUM call,
      // cloned per consumer so multiple gUM callers can each get a track.
      let canvasStream: MediaStream | null = null;
      const getCanvasStream = (): MediaStream => {
        if (canvasStream) return canvasStream;
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        canvas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
        if (document.body) document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 640, 360);
        // captureStream(N) only emits frames when the canvas surface
        // changes. Without continuous dirty pixels Teams' liveness checks
        // see a frozen track and may treat the call as broken. A 1×1
        // alternation at requestAnimationFrame cadence is cheap.
        canvasStream = canvas.captureStream(15);
        let flip = 0;
        const pump = () => {
          ctx.fillStyle = (++flip) & 1 ? '#000001' : '#000000';
          ctx.fillRect(0, 0, 1, 1);
          requestAnimationFrame(pump);
        };
        requestAnimationFrame(pump);
        return canvasStream;
      };

      const patched = async (constraints?: MediaStreamConstraints) => {
        // Video requested → audio from origGUM (or empty), canvas for video.
        if (constraints && constraints.video) {
          const audioStream = constraints.audio
            ? await origGUM({ audio: constraints.audio })
            : new MediaStream();
          audioStream.getAudioTracks().forEach((t) => { t.enabled = false; });
          const out = new MediaStream();
          audioStream.getAudioTracks().forEach((t) => out.addTrack(t));
          out.addTrack(getCanvasStream().getVideoTracks()[0].clone());
          return out;
        }
        // Audio-only or empty constraints — pass through, mute everything.
        const stream = await origGUM(constraints ?? {});
        stream.getAudioTracks().forEach((t) => { t.enabled = false; });
        stream.getVideoTracks().forEach((t) => { t.enabled = false; });
        return stream;
      };
      Object.defineProperty(patched, 'toString', {
        value: () => 'function getUserMedia() { [native code] }',
        configurable: true,
      });
      Object.defineProperty(patched, 'name', { value: 'getUserMedia', configurable: true });
      navigator.mediaDevices.getUserMedia = patched;
    });

    // Patch RTCPeerConnection before any page scripts load so we capture every
    // remote audio track Teams creates. See src/webrtc-patch.ts for details.
    await this.page.addInitScript(installWebRTCPatch);
  }

  private async _joinMeeting(): Promise<void> {
    const page = this.page!;
    const debugSnapshots = process.env.BOT_DEBUG_SNAPSHOTS === '1';
    const snap = async (label: string) => {
      if (!debugSnapshots) return;
      try {
        const buf = await page.screenshot({ fullPage: true });
        const p = `/tmp/bot-snap-${label}.png`;
        fs.writeFileSync(p, buf);
        console.log(`[bot] snapshot → ${p}  url=${page.url()}`);
      } catch { /* ignore */ }
    };

    console.log('[bot] navigating to', this.config.meetingUrl);
    await page.goto(this.config.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for Teams to render its initial UI rather than sleeping a fixed 4 s.
    await page.waitForSelector(
      'button:has-text("Continue on this browser"), button[data-tid="prejoin-join-button"], button[aria-label="Join now"]',
      { timeout: 8000 },
    ).catch(() => {});
    await snap('01-landed');
    console.log('[bot] landed, url=', page.url(), 'title=', await page.title());

    // Click "Continue on this browser"
    const continueSelectors = [
      'button:has-text("Continue on this browser")',
      'button:has-text("Continue")',
      'button:has-text("Join on this browser")',
      'a:has-text("Continue on this browser")',
      'button:has-text("Fortsæt i denne browser")',
      'button:has-text("Deltag i denne browser")',
    ];
    for (const sel of continueSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('[bot] clicking continue selector:', sel);
        await btn.click();
        break;
      }
    }

    // Poll until the prejoin screen is genuinely ready (vexa pattern). A
    // one-shot modal check + fixed join-button wait raced Teams' rendering:
    // the "Continue without audio or video" modal appears intermittently and
    // LATE (after prejoin boot), and when missed it blocks Join now forever.
    await this._waitForPreJoinReadiness(45_000);
    await snap('02-prejoin');

    // Turn off camera and mute mic as early as possible on the prejoin screen —
    // before filling the name, so Teams reaches "Join now" with both already off.
    // Only click buttons that indicate the device is currently ON (to avoid toggling
    // something that is already off). The getUserMedia patch already disables
    // tracks (silence + black), but Teams' UI state is independent and can
    // show the mic/camera as "on".

    const cameraBtnSel = [
      'button[aria-label="Turn off video"]',
      'button[aria-label="Turn off camera"]',
      'button[aria-label="Turn camera off"]',
      'button[aria-label="Camera on, click to turn off"]',
      'button[aria-label="Video on, click to turn off"]',
      'button[aria-label="Sluk video"]',
      'button[aria-label="Sluk kamera"]',
      'button[data-tid="toggle-video"][aria-pressed="true"]',
      'button[data-tid="camera-button"][aria-pressed="true"]',
    ].join(', ');
    const cameraBtn = page.locator(cameraBtnSel).first();
    if (await cameraBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cameraBtn.click().catch(() => {});
      console.log('[bot] turned camera off (prejoin)');
    } else {
      console.log('[bot] camera off button not found — may already be off');
    }

    const micBtnSel = [
      'button[aria-label="Turn off microphone"]',
      'button[aria-label="Mute microphone"]',
      'button[aria-label="Microphone on, click to mute"]',
      'button[aria-label="Sluk mikrofon"]',
      'button[data-tid="toggle-mute"][aria-pressed="true"]',
      'button[data-tid="microphone-button"][aria-pressed="true"]',
    ].join(', ');
    const micBtn = page.locator(micBtnSel).first();
    if (await micBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await micBtn.click().catch(() => {});
      console.log('[bot] muted microphone (prejoin)');
    } else {
      // Keyboard fallback — Ctrl+Shift+M is Teams' global mute toggle.
      // Fires even if the button selector didn't match (e.g. different locale or Teams version).
      await page.keyboard.press('Control+Shift+M').catch(() => {});
      console.log('[bot] muted microphone via Ctrl+Shift+M (prejoin fallback)');
    }

    // Fill in the display name after muting so Teams sees the final device state before join.
    const nameInput = page.locator(
      'input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i], input[aria-label*="name" i], input[type="text"]',
    ).first();
    if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[bot] filling name:', this.config.botName);
      await nameInput.fill('');
      await nameInput.fill(this.config.botName);
      await page.waitForTimeout(300);
    } else {
      console.log('[bot] name input not found');
    }

    // Ensure "Computer audio" is selected before joining. Teams can default
    // to "Don't use audio" (especially after the no-media modal path) — in
    // that mode Teams sets up NO audio transceivers at all: remote audio
    // tracks never arrive, the recording stays empty, and the in-call mic
    // button doesn't even render. vexa does this explicitly (join.ts Step 5)
    // and it is load-bearing for audio capture.
    const computerAudioRadio = page.locator([
      '[role="radio"][aria-label*="Computer audio"]',
      '[role="radio"][aria-label*="Computerlyd"]',
      'input[type="radio"][aria-label*="Computer audio"]',
      'label:has-text("Computer audio") input[type="radio"]',
    ].join(', ')).first();
    const dontUseAudioRadio = page.locator([
      `[role="radio"][aria-label*="Don't use audio"]`,
      '[role="radio"][aria-label*="Brug ikke lyd"]',
    ].join(', ')).first();
    if (await computerAudioRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Only read "Don't use audio" state if that radio is actually present.
      // getAttribute() blocks for its full default 30s timeout when the
      // element is absent — guarding with the immediate isVisible() check
      // avoids a ~30s stall on the prejoin (the radio is often not rendered
      // once Computer audio is already the default).
      if (await dontUseAudioRadio.isVisible().catch(() => false)) {
        const dontUseChecked = await dontUseAudioRadio.getAttribute('aria-checked', { timeout: 1000 }).catch(() => null);
        if (dontUseChecked === 'true') {
          console.log(`[bot] "Don't use audio" was selected — switching to Computer audio`);
        }
      }
      await computerAudioRadio.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(200);
      console.log('[bot] selected Computer audio');
    } else {
      console.log('[bot] computer audio radio not visible — continuing with defaults');
    }
    // Force the speaker on if Teams shows it disabled — remote audio playback
    // (which our capture pipeline consumes) requires the speaker enabled.
    const speakerOnBtn = page.locator([
      'button[aria-label*="Turn speaker on"]',
      'button[aria-label*="Speaker is off"]',
      'button:has-text("Turn speaker on")',
    ].join(', ')).first();
    if (await speakerOnBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await speakerOnBtn.click({ timeout: 5000 }).catch(() => {});
      console.log('[bot] enabled speaker (prejoin)');
    }

    // Click "Join now"
    const joinSelectors = [
      'button[data-tid="prejoin-join-button"]',
      'button[aria-label="Join now"]',
      '#prejoin-join-button',
      'button:has-text("Join now")',
      'button:has-text("Deltag nu")',
      'button:has-text("Join")',
      'button:has-text("Deltag")',
    ];
    let joined = false;
    for (const sel of joinSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[bot] clicking join selector:', sel);
        await btn.click();
        joined = true;
        break;
      }
    }
    if (!joined) {
      await snap('03-no-join-btn');
      if (debugSnapshots) {
        const htmlFail = await page.content().catch(() => '');
        fs.writeFileSync('/tmp/bot-page-no-join.html', htmlFail);
      }
      throw new Error('Could not find join button');
    }
    // Wait for the lobby/meeting UI to appear rather than sleeping a fixed 4 s.
    await page.waitForSelector(
      `${LEAVE_BTN}, [data-tid="lobby-section"], [aria-label="Lobby"]`,
      { timeout: 8000 },
    ).catch(() => {});
    await snap('03-after-join');

    // Poll for admission: admitted (enabled Leave button) vs denied vs timeout (5 min)
    {
      const lobbyUrl = page.url();
      const lobbyTitle = await page.title().catch(() => '');
      const lobbyText = await page.evaluate(() => (document.body.innerText ?? '').slice(0, 300)).catch(() => '');
      console.log('[bot] waiting for admission — url=', lobbyUrl, 'title=', lobbyTitle);
      console.log('[bot] page preview:', lobbyText.replace(/\n/g, ' | '));
    }
    // Always snapshot at this point to help diagnose lobby vs meeting state
    const lobbySnap = await page.screenshot({ fullPage: false }).catch(() => null);
    if (lobbySnap) fs.writeFileSync('/tmp/bot-snap-lobby.png', lobbySnap);
    console.log('[bot] lobby snapshot → /tmp/bot-snap-lobby.png');

    const joinResult: JoinRaceResult = await this._waitForAdmission(300_000);

    if (!isAdmitted(joinResult)) {
      console.log(`[bot] join failed: ${joinResult}`);
      await snap(`04-join-${joinResult}`);
      // Unconditional snapshot and page text for failed joins so the state of
      // the Teams page is always captured without needing BOT_DEBUG_SNAPSHOTS.
      try {
        const failSnap = await page.screenshot({ fullPage: false });
        fs.writeFileSync(`/tmp/bot-snap-join-${joinResult}.png`, failSnap);
        const failText = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 500)).catch(() => '');
        console.log(`[bot] page text at join-${joinResult}:`, failText.replace(/\n/g, ' | '));
      } catch { /* ignore */ }
      throw new Error(joinFailureMessage(joinResult));
    }

    await snap('05-in-meeting');
    if (debugSnapshots) {
      const htmlIn = await page.content().catch(() => '');
      fs.writeFileSync('/tmp/bot-page-in-meeting.html', htmlIn);
    }
    console.log('[bot] in meeting, proceeding to audio capture, url=', page.url());

    await this._startAudioCapture();

    // No post-admission UI clicks. Clicking the in-call mic toggle or the
    // participants-panel button inside the first ~5 s after admission triggers
    // Teams' "Action failed" toast → auto-leave, because:
    //   1. Teams' mic-toggle handler iterates RTCRtpSenders. The video sender
    //      returned by webrtc-patch.ts:addTrack belongs to a throw-away PC, so
    //      any sender method call on it throws InvalidAccessError.
    //   2. The toolbar buttons mount before React binds their handlers; clicks
    //      in that window dispatch unhandled rejections that Teams surfaces as
    //      "Action failed".
    // Why neither click is needed:
    //   - The getUserMedia patch sets `track.enabled = false` on every audio
    //     track at construction time. The bot literally cannot transmit audio
    //     regardless of Teams' UI mute state.
    //   - The prejoin mute step (lines ~263–299) already drives Teams' mute
    //     state to "off" before we click Join now.
    //   - _pollParticipants reads the roster via headcount badge + roster cells
    //     that work whether the participants panel is open or closed.
  }

  /**
   * Poll until the Teams prejoin screen is genuinely interactive (vexa's
   * waitForTeamsPreJoinReadiness pattern). Each 300 ms tick:
   *   1. Dismiss the "Continue without audio or video" modal (≤3 attempts) —
   *      it appears intermittently and LATE, and blocks Join now until
   *      dismissed.
   *   2. Success when Join now is visible, OR Cancel is visible together
   *      with a prejoin control (name input / camera toggle / audio radio).
   *   3. Re-click "Continue on this browser" if it is still showing
   *      (≤2 attempts) — the first click sometimes doesn't take.
   *   4. If Teams shows its permission gate ("Select Allow to let Microsoft
   *      Teams use your mic and camera"), run a one-shot getUserMedia
   *      warm-up so device enumeration completes. Our gUM patch makes this
   *      safe: audio comes back disabled, video is a canvas clone.
   */
  private async _waitForPreJoinReadiness(timeoutMs: number): Promise<boolean> {
    const page = this.page!;
    const start = Date.now();
    let modalClicks = 0;
    let continueClicks = 0;
    let warmedUp = false;

    const prejoinControlSel = [
      'input[data-tid="prejoin-display-name-input"]',
      'input[placeholder*="name" i]',
      'button[aria-label*="camera" i]',
      'button[aria-label*="video" i]',
      '[role="radio"][aria-label*="Computer audio"]',
    ].join(', ');

    while (Date.now() - start < timeoutMs) {
      // 1. Late-appearing no-media modal
      const modal = page.locator(NO_MEDIA_MODAL_BTN).first();
      if (modalClicks < 3 && await modal.isVisible().catch(() => false)) {
        modalClicks++;
        console.log(`[bot] dismissing "Continue without audio or video" modal (attempt ${modalClicks})`);
        await modal.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }

      // 2. Ready? The prejoin is interactive as soon as the Join-now button
      // OR any prejoin control (name input / camera toggle / audio radio) is
      // visible. We deliberately do NOT require a "Cancel" button —
      // teams.live.com's anonymous prejoin often has no Cancel, and requiring
      // it kept this loop spinning forever even though the form was ready.
      const joinNowVisible = await page.locator(JOIN_NOW_BTN).first().isVisible().catch(() => false);
      const controlVisible = await page.locator(prejoinControlSel).first().isVisible().catch(() => false);
      if (joinNowVisible || controlVisible) {
        console.log('[bot] prejoin controls ready');
        return true;
      }

      // 3. Still on the launcher page (no prejoin control visible) and a
      // "Continue on this browser" button is showing — re-click it. We only
      // reach here when step 2 found NO prejoin control, so this can't fire
      // mid-prejoin and disrupt teams.live.com's in-page transition.
      const continueBtn = page.locator('button:has-text("Continue on this browser"), button:has-text("Fortsæt i denne browser")').first();
      if (continueClicks < 2 && await continueBtn.isVisible().catch(() => false)) {
        continueClicks++;
        console.log(`[bot] re-clicking Continue on this browser (attempt ${continueClicks})`);
        await continueBtn.click().catch(() => {});
        await page.waitForTimeout(800);
        continue;
      }

      // 4. Permission gate — nudge device enumeration once
      if (!warmedUp) {
        const gateVisible = await page
          .locator('text=/Select Allow to let Microsoft Teams use your mic and camera/i')
          .first().isVisible().catch(() => false);
        if (gateVisible) {
          warmedUp = true;
          console.log('[bot] permission gate detected — running media warm-up');
          const result = await page.evaluate(async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
              const n = stream.getTracks().length;
              stream.getTracks().forEach((t) => t.stop());
              return `warm-up ok (tracks=${n})`;
            } catch (err) {
              return `warm-up failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          }).catch((err: unknown) => `warm-up evaluate failed: ${err instanceof Error ? err.message : String(err)}`);
          console.log(`[bot] ${result}`);
        }
      }

      await page.waitForTimeout(300);
    }

    console.log(`[bot] prejoin readiness timed out after ${timeoutMs} ms (url=${page.url()})`);
    return false;
  }

  /**
   * Poll for admission after "Join now" (vexa's admission.ts pattern).
   *
   * Replaces the old Promise.race of waitForSelector/waitForFunction arms —
   * a polling loop re-evaluates every signal each 2 s tick, so a transient
   * state (Leave button hidden mid-animation, slow lobby→meeting
   * transition) can never permanently mis-settle the outcome the way a
   * settled race arm could. Per tick:
   *
   *   1. Denial text → 'denied'.
   *   2. Connection-error page ("couldn't connect you") → click "Rejoin
   *      call" (max 3 attempts across the whole wait); if retries are
   *      exhausted and the error page persists → 'denied'.
   *   3. Admission: a LEAVE_BTN match that is visible AND not
   *      aria-disabled, with no Join-now button visible (negative check —
   *      the lobby cancel button can match broad Leave selectors). Require
   *      2 consecutive ticks to debounce transient matches.
   *   4. Lobby tracking: if lobby indicators are visible, remember we were
   *      in the lobby.
   *   5. Assume-admitted fallback: we were in the lobby, lobby indicators
   *      have been gone ≥3 consecutive ticks, and no denial / connection
   *      error is present → 'admitted'. (vexa does the same; the in-meeting
   *      leave-detector backstops a false positive.)
   */
  private async _waitForAdmission(timeoutMs: number): Promise<JoinRaceResult> {
    const page = this.page!;
    const start = Date.now();
    const TICK_MS = 2000;

    const denialTexts = [
      // ours (historical)
      "weren't let in", 'was not let in', "didn't let you in",
      'request was declined', 'entry was denied', 'sorry, but you were denied',
      // from vexa's teamsRejectionIndicators
      'you were denied entry', 'access denied', 'entry denied',
      'request denied', 'admission denied',
    ];
    const lobbySel = '[data-tid="lobby-section"], [aria-label="Lobby"]';
    const rejoinSel = [
      'button:has-text("Rejoin call")',
      'button:has-text("Try again")',
      'button:has-text("Prøv igen")',
      'button:has-text("Forsøg igen")',
    ].join(', ');

    let rejoinClicks = 0;
    let admittedTicks = 0;
    let wasInLobby = false;
    let lobbyGoneTicks = 0;

    while (Date.now() - start < timeoutMs) {
      const bodyText = await page.evaluate(() => (document.body?.innerText ?? '').toLowerCase()).catch(() => '');

      // 1. Denial
      if (denialTexts.some((t) => bodyText.includes(t))) {
        console.log('[bot] denial text detected');
        return 'denied';
      }

      // 2. Connection-error page
      const onErrorPage = bodyText.includes("couldn't connect you") || bodyText.includes('could not connect you');
      if (onErrorPage) {
        admittedTicks = 0;
        if (rejoinClicks >= 3) {
          console.log('[bot] connection-error page persists after 3 rejoin attempts — giving up');
          return 'denied';
        }
        const rejoinBtn = page.locator(rejoinSel).first();
        if (await rejoinBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          rejoinClicks++;
          console.log(`[bot] connection-error page — clicking Rejoin call (attempt ${rejoinClicks}/3)`);
          await rejoinBtn.click().catch(() => {});
          await page.waitForTimeout(1500);
        }
        await page.waitForTimeout(TICK_MS);
        continue;
      }

      // 3. Admission (enabled Leave button + Join-now negative, debounced)
      const joinNowVisible = await page.locator(JOIN_NOW_BTN).first().isVisible().catch(() => false);
      let leaveEnabled = false;
      if (!joinNowVisible) {
        const leaveBtn = page.locator(LEAVE_BTN).first();
        if (await leaveBtn.isVisible().catch(() => false)) {
          const disabled = await leaveBtn.getAttribute('aria-disabled').catch(() => null);
          leaveEnabled = disabled !== 'true';
        }
      }
      if (leaveEnabled) {
        admittedTicks++;
        if (admittedTicks >= 2) {
          console.log('[bot] admitted — enabled Leave button on 2 consecutive ticks, url=', page.url());
          return 'admitted';
        }
      } else {
        admittedTicks = 0;
      }

      // 4–5. Lobby tracking + assume-admitted fallback
      const inLobby = joinNowVisible
        || await page.locator(lobbySel).first().isVisible().catch(() => false)
        || bodyText.includes('someone in the meeting should let you in')
        || bodyText.includes('waiting for others to arrive')
        || bodyText.includes('when the meeting starts');
      if (inLobby) {
        wasInLobby = true;
        lobbyGoneTicks = 0;
      } else if (wasInLobby) {
        lobbyGoneTicks++;
        if (lobbyGoneTicks >= 3 && !leaveEnabled && admittedTicks === 0) {
          console.log('[bot] lobby disappeared without denial — assuming admitted (leave-detector will backstop)');
          return 'admitted';
        }
      }

      await page.waitForTimeout(TICK_MS);
    }

    console.log(`[bot] admission wait timed out after ${timeoutMs} ms`);
    const failSnap = await page.screenshot({ fullPage: false }).catch(() => null);
    if (failSnap) fs.writeFileSync('/tmp/bot-snap-admission-timeout.png', failSnap);
    return 'timeout';
  }

  private async _startAudioCapture(): Promise<void> {
    const page = this.page!;

    this.audioFilePath = path.join(os.tmpdir(), `bot-audio-${this.config.meetingId}-${Date.now()}.webm`);
    this.audioWriteStream = fs.createWriteStream(this.audioFilePath);

    await page.exposeFunction('__botAudioChunk', (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      this.audioChunkCount++;
      this.audioWriteStream?.write(buf);
    });

    await page.exposeFunction('__botMeetingEnded', () => {
      void this._handleMeetingEnded();
    });

    // Fired by the RTCPeerConnection patch when a new audio peer joins.
    // Cancels any pending alone-timer so a reconnecting participant doesn't trigger a stop.
    // Also resets RTP tracking so idle-detection restarts cleanly for the new peer.
    await page.exposeFunction('__botPeerRejoined', () => {
      if (this.aloneTimer) {
        clearTimeout(this.aloneTimer);
        this.aloneTimer = null;
      }
      this.lastRtpPackets = -1;
      this.rtpIdleChecks = 0;
      this.rtpAudioIdleChecks = 0;
      this.buttonCount = -1;
      console.log('[bot] New audio peer joined — cancelled alone timer');
    });

    // Fired by the tile observer when multiple participant tiles are visible.
    // Unlike __botPeerRejoined, this does NOT reset RTP tracking — we only want
    // to cancel any pending departure and confirm presence, not restart idle counters.
    await page.exposeFunction('__botPresenceConfirmed', () => {
      if (this.aloneTimer) {
        clearTimeout(this.aloneTimer);
        this.aloneTimer = null;
      }
      this.rtpAudioIdleChecks = 0;
      console.log('[bot] Participant tiles visible — presence confirmed, cancelled alone timer');
    });

    // Fired by the RTCPeerConnection patch when all audio peers close their connections
    // or when the audio silence detector confirms sustained near-silence.
    // We schedule a stop with a 5-second grace window so brief reconnections don't
    // cause a premature exit.
    await page.exposeFunction('__botAllPeersLeft', () => {
      // Allow stopping if we've recorded something OR been in the meeting >60 s
      // (handles the case where someone joins and immediately leaves before speaking).
      const canStop = this.hadActiveTracks || this.elapsed > 60;
      if (canStop && this.isActivelyRecording()) {
        if (!this.aloneTimer) {
          console.log('[bot] All audio peers disconnected — will stop in 5 s unless someone rejoins');
          this.aloneTimer = setTimeout(() => {
            this.aloneTimer = null;
            const stillCanStop = this.hadActiveTracks || this.elapsed > 60;
            if (stillCanStop && this.isActivelyRecording()) {
              console.log('[bot] Grace period elapsed — alone in meeting, stopping');
              void this.stop();
            }
          }, 5_000);
        }
      }
    });

    await page.evaluate(() => {
      try {
        const ctx = new AudioContext();
        // AudioContext starts suspended in headless Chrome even with the autoplay flag.
        ctx.resume().catch(() => {});
        ctx.onstatechange = () => {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        };

        // Audio graph: sources → silenceAnalyser → dest (recorder)
        // Placing the analyser in the signal path lets us read energy directly
        // without calling createMediaStreamSource(dest.stream), which fails silently
        // in headless Chrome (no audio output device → stream is unreadable).
        const dest = ctx.createMediaStreamDestination();
        const silenceAnalyser = ctx.createAnalyser();
        silenceAnalyser.fftSize = 256;
        silenceAnalyser.connect(dest);

        const connectedStreams = new Set<MediaStream>();
        const connectEl = (el: HTMLAudioElement) => {
          const stream = el.srcObject;
          if (!(stream instanceof MediaStream)) return;
          if (connectedStreams.has(stream)) return;
          connectedStreams.add(stream);
          ctx.createMediaStreamSource(stream).connect(silenceAnalyser);
        };

        // Connect all existing bot-captured audio elements
        document.querySelectorAll<HTMLAudioElement>('audio[data-bot-captured]').forEach(connectEl);

        // Connect new elements added by the RTCPeerConnection hook as participants join
        const audioObs = new MutationObserver(() => {
          document.querySelectorAll<HTMLAudioElement>('audio[data-bot-captured]').forEach((el) => {
            if ((el.dataset as DOMStringMap & { botConnected?: string }).botConnected) return;
            (el.dataset as DOMStringMap & { botConnected: string }).botConnected = 'true';
            connectEl(el);
          });
        });
        audioObs.observe(document.body, { childList: true, subtree: true });

        // Pick the best supported mimeType
        const mimeType = ['audio/webm;codecs=opus', 'audio/webm', ''].find(
          (m) => m === '' || MediaRecorder.isTypeSupported(m),
        ) ?? '';
        const recorderOpts: MediaRecorderOptions = { audioBitsPerSecond: 128_000 };
        if (mimeType) recorderOpts.mimeType = mimeType;
        const recorder = new MediaRecorder(dest.stream, recorderOpts);
        console.log('[bot] MediaRecorder mimeType:', recorder.mimeType);

        recorder.ondataavailable = async (e: BlobEvent) => {
          if (e.data.size === 0) return;
          const ab = await e.data.arrayBuffer();
          // Chunked base64 encoding — spreading a large Uint8Array into
          // String.fromCharCode blows the call stack at ~480 KB (30 s × 128 kbps).
          const bytes = new Uint8Array(ab);
          let binary = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
          }
          (window as unknown as Record<string, (s: string) => void>).__botAudioChunk(btoa(binary));
        };

        recorder.start(30_000); // 30-second timeslices

        (window as unknown as Record<string, unknown>).__mediaRecorder = recorder;

        // Video tile observer — used purely as a PRESENCE signal.
        // Tries multiple known Teams data-tid selectors for participant tiles. When any
        // selector finds > 1 tiles, calls __botPresenceConfirmed to cancel any pending
        // alone timer. Departure detection is handled by checkAllPeersGone(), live track
        // polling, RTP idle, and the audio silence detector below — not by this observer.
        const TILE_SELECTORS = [
          '[data-tid^="video-item-container-"]',
          '[data-tid="calling-roster-cell"]',
          '[data-tid^="roster-participant-"]',
          '[data-tid="participant-roster-item"]',
        ];
        let tileDebounce: ReturnType<typeof setTimeout> | null = null;
        const tileObs = new MutationObserver(() => {
          if (tileDebounce) return;
          tileDebounce = setTimeout(() => {
            tileDebounce = null;
            for (const sel of TILE_SELECTORS) {
              if (document.querySelectorAll(sel).length > 1) {
                (window as unknown as Record<string, (() => void) | undefined>).__botPresenceConfirmed?.();
                break;
              }
            }
          }, 500);
        });
        tileObs.observe(document.body, { childList: true, subtree: true });

        // Audio silence detector — silenceAnalyser sits in the signal path (sources →
        // silenceAnalyser → dest) so we can read energy directly without needing to
        // create a new source from dest.stream (which fails in headless Chrome).
        // Threshold of 15 corresponds to ~-91 dBFS average — below real audio (even quiet
        // presence gives 20-60) but above true digital silence (0-5). 30 × 2 s = 60 s.
        const silenceFreqData = new Uint8Array(silenceAnalyser.frequencyBinCount);
        let silenceChecks = 0;
        const silenceInterval = setInterval(() => {
          silenceAnalyser.getByteFrequencyData(silenceFreqData);
          const avgEnergy = silenceFreqData.reduce((s: number, v: number) => s + v, 0) / silenceFreqData.length;
          if (avgEnergy < 15) {
            if (++silenceChecks >= 30) {
              clearInterval(silenceInterval);
              (window as unknown as Record<string, (() => void) | undefined>).__botAllPeersLeft?.();
            }
          } else {
            silenceChecks = 0;
          }
        }, 2000);
        (window as unknown as Record<string, unknown>).__botSilenceInterval = silenceInterval;

        // Watch for meeting-ended or kicked state.
        // Selector is intentionally narrow: [aria-label*="ended" i] is too broad and
        // matches transient Teams UI elements during the lobby→meeting transition, causing
        // the bot to leave immediately after joining. Rely on the specific data-tid/class
        // that Teams sets only when the meeting is genuinely over.
        // endObsFired prevents the debounced callback from firing more than once
        // if multiple DOM mutations arrive before the 300 ms timeout resolves.
        let endObsFired = false;
        const endObs = new MutationObserver(() => {
          if (endObsFired) return;
          // Quick pre-check without innerText (cheap DOM query only).
          const ended = document.querySelector('[data-tid="call-ended-title"], .ts-call-ended');
          if (!ended) return;
          // Defer the text check by 300 ms so Teams has time to finish rendering the
          // error page text before we read innerText. Without this delay there is a
          // race: the [data-tid="call-ended-title"] element is inserted in one DOM
          // batch before the "couldn't connect you" text is injected in the next,
          // causing the guard below to miss and fire __botMeetingEnded prematurely.
          setTimeout(() => {
            if (endObsFired) return;
            const endedNow = document.querySelector('[data-tid="call-ended-title"], .ts-call-ended');
            const text = (document.body.innerText ?? '').toLowerCase();
            const kicked =
              text.includes("you were removed") ||
              text.includes("you've been removed") ||
              text.includes("removed from the meeting") ||
              text.includes("du blev fjernet") ||
              text.includes("du er blevet fjernet") ||
              text.includes("fjernet fra mødet");
            if (!endedNow && !kicked) return;
            // The Teams connection error page ("Sorry, we couldn't connect you") reuses
            // [data-tid="call-ended-title"] — don't treat it as a genuine meeting end.
            if (!kicked && (text.includes("couldn't connect you") || text.includes("could not connect you"))) return;
            endObsFired = true;
            console.log('[bot-browser] endObs triggered — ended:', !!endedNow, 'kicked:', kicked);
            endObs.disconnect();
            audioObs.disconnect();
            recorder.stop();
            (window as unknown as Record<string, () => void>).__botMeetingEnded();
          }, 300);
        });
        endObs.observe(document.body, { childList: true, subtree: true });

        // Action-failed toast observer — surfaces a distinct log line as soon
        // as Teams renders its generic error toast. We do NOT take any action
        // here (the existing leave-detection paths handle the cascade); this
        // is purely forensic, so post-mortems can pinpoint the trigger.
        const ACTION_FAILED_PATTERNS = [
          'action failed',
          'handlingen mislykkedes',
          'handlingen kunne ikke',
        ];
        let actionFailedSeen = false;
        const actionFailedObs = new MutationObserver(() => {
          if (actionFailedSeen) return;
          try {
            const alerts = document.querySelectorAll('[role="alert"], [aria-live="assertive"], [data-tid*="toast" i]');
            for (const el of Array.from(alerts)) {
              const text = ((el as HTMLElement).innerText ?? '').toLowerCase();
              if (!text) continue;
              if (ACTION_FAILED_PATTERNS.some((p) => text.includes(p))) {
                actionFailedSeen = true;
                (window as unknown as Record<string, ((s: string) => void) | undefined>).__botLogActionFailed?.(text);
                actionFailedObs.disconnect();
                break;
              }
            }
          } catch { /* swallow — observability must never throw */ }
        });
        actionFailedObs.observe(document.body, { childList: true, subtree: true });
      } catch (err) {
        console.error('[bot] audio capture setup failed', err);
      }
    });
  }

  pause(): void {
    if (this.status !== 'recording') return;
    this.status = 'paused';
    this._stopElapsedTimer();
    this.page?.evaluate(() => {
      const rec = (window as unknown as Record<string, unknown>).__mediaRecorder as MediaRecorder | undefined;
      if (rec?.state === 'recording') rec.pause();
    }).catch(() => {});
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'recording';
    this._startElapsedTimer();
    this.page?.evaluate(() => {
      const rec = (window as unknown as Record<string, unknown>).__mediaRecorder as MediaRecorder | undefined;
      if (rec?.state === 'paused') rec.resume();
    }).catch(() => {});
  }

  private isActivelyRecording(): boolean {
    return this.status === 'recording' || this.status === 'paused';
  }

  async stop(): Promise<void> {
    this.status = 'ended';
    this._stopElapsedTimer();
    this._stopParticipantPolling();

    await this.page?.evaluate(() => {
      const rec = (window as unknown as Record<string, unknown>).__mediaRecorder as MediaRecorder | undefined;
      if (rec && rec.state !== 'inactive') rec.stop();
    }).catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 1500));

    await this._uploadAudio();
    await this._cleanup();
  }

  async abort(): Promise<void> {
    this.status = 'ended';
    this._stopElapsedTimer();
    this._stopParticipantPolling();
    await this._cleanup();
  }

  private async _handleMeetingEnded(): Promise<void> {
    if (this.status === 'ended') return;
    // Ignore signals that arrive before we're fully in the meeting — endObs can fire on
    // transient DOM elements during the lobby→meeting transition while status is still 'joining'.
    if (!this.isActivelyRecording()) {
      console.log(`[bot] Ignoring meeting-ended signal in status '${this.status}' — not yet recording`);
      return;
    }
    // Guard against false positives in the first 30 s after joining.
    // Teams can transiently render [data-tid="call-ended-title"] during the
    // lobby→meeting transition while the SPA re-initialises; endObs may fire
    // before Teams finishes settling.  30 s is enough for Teams to stabilise.
    // Genuine kicks (< 30 s) are an acceptable edge case.
    if (this.elapsed < 30) {
      console.log(`[bot] Ignoring early meeting-ended signal (elapsed=${this.elapsed}s) — may be transient`);
      return;
    }
    this.status = 'ended';
    this._stopElapsedTimer();
    this._stopParticipantPolling();
    await this._uploadAudio();
    await this._cleanup();
    this.onEndedCallback?.();
  }

  private async _uploadAudio(): Promise<void> {
    // Flush and close the write stream before reading
    await new Promise<void>((resolve) => {
      if (this.audioWriteStream) {
        this.audioWriteStream.end(resolve);
        this.audioWriteStream = null;
      } else {
        resolve();
      }
    });

    if (this.audioChunkCount === 0 || !this.audioFilePath) {
      await this._notifyNoRecording();
      return;
    }

    const fileSize = await fs.promises.stat(this.audioFilePath).then((s) => s.size).catch(() => 0);
    if (fileSize === 0) {
      await this._notifyNoRecording();
      return;
    }

    const form = new FormData();
    // Stream from disk — avoids holding the full recording in memory
    form.append('audio', fs.createReadStream(this.audioFilePath), {
      filename: 'recording.webm',
      contentType: 'audio/webm',
      knownLength: fileSize,
    });
    form.append('meetingId', this.config.meetingId);
    form.append('userId', this.config.userId);
    form.append('duration', String(this.elapsed));
    // Strip internal sentinels and system phantoms ("Microsoft Teams meeting")
    // before sending to the server so they don't appear in the meeting's
    // participant list.
    const realParticipants = this.participants.filter((p) => isRealParticipant(p, this.config.botName));
    form.append('participants', JSON.stringify(realParticipants));

    try {
      const res = await fetch(this.config.callbackUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.internalSecret}`,
          ...form.getHeaders(),
        },
        body: form,
      });
      if (!res.ok) {
        console.error('[bot] Audio upload failed:', res.status, await res.text());
      }
    } catch (err) {
      console.error('[bot] Audio upload error:', err);
    }
  }

  private async _notifyNoRecording(): Promise<void> {
    try {
      await fetch(this.config.callbackUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.internalSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          meetingId: this.config.meetingId,
          userId: this.config.userId,
          hasRecording: false,
        }),
      });
    } catch (err) {
      console.error('[bot] No-recording notify failed:', err);
    }
  }

  private async _cleanup(): Promise<void> {
    // Close write stream if upload path didn't already do it
    await new Promise<void>((resolve) => {
      if (this.audioWriteStream) {
        this.audioWriteStream.end(resolve);
        this.audioWriteStream = null;
      } else {
        resolve();
      }
    });

    // Click the Teams hangup button before closing the browser so Teams receives a
    // clean "leave" signal. Without this, closing the browser abruptly leaves a ghost
    // session in Teams that shows as "Leaving..." indefinitely and cannot be removed.
    // Exception: skip the click when the page is showing the connection error screen
    // ("Sorry, we couldn't connect you") — the "Dismiss" button on that page also
    // matches LEAVE_BTN (data-tid="hangup-button") and clicking it sends a garbled
    // leave signal that leaves Teams stuck in "Leaving..." permanently.
    if (this.page) {
      try {
        const onErrorPage = await this.page.evaluate(() => {
          const text = (document.body?.innerText ?? '').toLowerCase();
          return text.includes("couldn't connect you") || text.includes("could not connect you");
        }).catch(() => false);

        if (onErrorPage) {
          // Navigate away instead of clicking the Dismiss button — clicking it sends
          // a garbled leave signal that leaves the Teams session stuck in "Leaving..."
          // permanently. Navigating to about:blank triggers Teams' JS unload handler,
          // which sends a proper disconnect signal to the signaling server.
          console.log('[bot] error page — navigating away to trigger Teams disconnect signal');
          await this.page.goto('about:blank', { timeout: 5000 }).catch(() => {});
          await this.page.waitForTimeout(2000);
        } else {
          const leaveBtn = this.page.locator(LEAVE_BTN).first();
          if (await leaveBtn.isVisible({ timeout: 2000 })) {
            console.log('[bot] clicking leave button for clean Teams exit');
            await leaveBtn.click();
            await this.page.waitForTimeout(3000);
          }
        }
      } catch { /* ignore — page may already be gone */ }
    }

    try {
      await this.page?.close();
      await this.context?.close(); // also closes the underlying browser with launchPersistentContext
    } catch { /* ignore */ }
    this.page = null;
    this.context = null;

    // Delete temp audio file and per-session Chromium profile
    if (this.audioFilePath) {
      await fs.promises.unlink(this.audioFilePath).catch(() => {});
      this.audioFilePath = '';
    }
    await fs.promises.rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  private _startElapsedTimer(): void {
    this._stopElapsedTimer();
    this.elapsedStartMs = Date.now() - this.elapsed * 1000;
    this.elapsedTimer = setInterval(() => {
      this.elapsed = Math.floor((Date.now() - this.elapsedStartMs) / 1000);
    }, 500);
  }

  private _stopElapsedTimer(): void {
    if (this.elapsedTimer) { clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
  }

  private _startParticipantPolling(): void {
    this._stopParticipantPolling();
    this.participantTimer = setInterval(() => { void this._pollParticipants(); }, 2000);
  }

  private _stopParticipantPolling(): void {
    if (this.participantTimer) { clearInterval(this.participantTimer); this.participantTimer = null; }
    if (this.aloneTimer) { clearTimeout(this.aloneTimer); this.aloneTimer = null; }
    this._stopWatchdog();
  }

  private _resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      console.error('[bot] Watchdog: poll loop silent for 5 min — aborting hung session');
      void this.abort();
    }, 5 * 60 * 1000);
  }

  private _stopWatchdog(): void {
    if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
  }

  private async _pollParticipants(): Promise<void> {
    if (!this.page) return;
    this._resetWatchdog();
    try {
      // Primary: check if Leave button is still visible — if gone, we were kicked or meeting ended.
      // Only activate after 30 s in the meeting: Teams takes several seconds to fully render the
      // in-call toolbar after admission (SPA navigation, CallTitleService fetch, media
      // negotiation), and hadActiveTracks can become true on the very first poll — using it as
      // the activation condition caused the check to fire at t+4 s before Teams finished settling.
      // The 30 s threshold matches the _handleMeetingEnded guard. Require 5 consecutive missing
      // polls (≈10 s) so transient toolbar animations or error-recovery screens don't trigger a stop.
      // Other signals (track count, participant count) cover departures inside the 30 s window.
      const leaveVisible = await this.page.locator(LEAVE_BTN).first().isVisible().catch(() => false);
      const decision = leaveDetectorTick(this.leaveDetector, {
        leaveButtonVisible: leaveVisible,
        elapsedSeconds: this.elapsed,
        isActivelyRecording: this.isActivelyRecording(),
      });
      this.leaveDetector = decision.state;
      if (decision.logLine) console.log(`[bot] ${decision.logLine}`);
      if (decision.shouldStop) {
        void this.stop();
        return;
      }

      // Participants button aria-label contains the live headcount, e.g. "Show participants (2)".
      // This is the most reliable departure signal because it reflects Teams' own UI state
      // and is unaffected by the SFU keeping RTC connections/packets alive after peers leave.
      const rawButtonCount = await this.page.evaluate(() => {
        const selectors = [
          'button[data-tid="participants-button"]',
          'button[aria-label*="participant" i]',
          'button[aria-label*="deltager" i]',
          'button[aria-label*="people" i]',
          '[data-tid="participants-button"]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (!btn) continue;
          const label = btn.getAttribute('aria-label') ?? '';
          const m = label.match(/\((\d+)\)/);
          if (m) return parseInt(m[1], 10);
          // Fallback: numeric badge inside the button (Teams uses data-tid="toolbar-item-badge")
          const badge = btn.querySelector('[class*="count" i], [class*="badge" i], [data-tid="toolbar-item-badge"]');
          if (badge) {
            const n = parseInt((badge as HTMLElement).innerText, 10);
            if (!isNaN(n)) return n;
          }
        }
        return -1;
      }).catch(() => -1) as number;

      if (rawButtonCount >= 0) {
        const prevCount = this.buttonCount;
        this.buttonCount = rawButtonCount;

        if (rawButtonCount > 1) this.hadOtherParticipants = true;

        // Teams counts ALL participants including the bot itself, so ≤1 means bot is alone.
        const botAlone = rawButtonCount <= 1;
        const hadOthers = prevCount > 1;

        if (botAlone && hadOthers && (this.hadActiveTracks || this.hadOtherParticipants)
            && this.isActivelyRecording()) {
          if (!this.aloneTimer) {
            console.log(`[bot] Participant button count dropped to ${rawButtonCount} — will stop in 5 s`);
            this.aloneTimer = setTimeout(() => {
              this.aloneTimer = null;
              if (this.isActivelyRecording()) {
                console.log('[bot] Participant count alone confirmed — stopping');
                void this.stop();
              }
            }, 5_000);
          }
        } else if (!botAlone && this.aloneTimer) {
          // Someone joined back
          clearTimeout(this.aloneTimer);
          this.aloneTimer = null;
        }
      }

      // Count remote audio tracks that are still live. When this transitions from > 0
      // to 0 we know all participants have left (the RTCPeerConnection patch also fires
      // __botAllPeersLeft for the same condition via connection state events).
      const liveTrackCount = await this.page.evaluate(() => {
        let n = 0;
        document.querySelectorAll<HTMLAudioElement>('audio[data-bot-captured]').forEach((el) => {
          const s = el.srcObject;
          if (s instanceof MediaStream) n += s.getAudioTracks().filter((t) => t.readyState === 'live').length;
        });
        return n;
      }).catch(() => -1);

      if (liveTrackCount > 0) {
        this.hadActiveTracks = true;
        if (this.participants.length === 0) this.participants = ['__audio_detected__'];
        // Note: aloneTimer is NOT cancelled here — Teams can leave tracks in 'live'
        // state even after a participant disconnects. Cancellation is handled by
        // __botPeerRejoined which fires only when a genuinely new peer joins.
      } else if (liveTrackCount === 0 && this.hadActiveTracks
          && this.isActivelyRecording()
          && !this.aloneTimer) {
        // Schedule a stop after a 5-second grace period so brief renegotiations
        // don't cause a premature exit.
        console.log('[bot] No live remote tracks — will stop in 5 s unless tracks return');
        this.aloneTimer = setTimeout(() => {
          this.aloneTimer = null;
          if (this.hadActiveTracks && this.isActivelyRecording()) {
            console.log('[bot] Grace period elapsed — alone in meeting, stopping');
            void this.stop();
          }
        }, 5_000);
      }

      // RTP packet + audio level check.
      // audioLevel (0–1 linear RMS) is the most sensitive departure signal:
      // SFU comfort noise is near-zero (< 0.002) while any real presence — even a
      // silently listening participant — shows at least slight background noise (> 0.002).
      // Packet counting is a secondary check for when audioLevel is unavailable.
      if (this.hadActiveTracks && this.isActivelyRecording()) {
        const rtpResult = await this.page.evaluate(async () => {
          const pcs = ((window as unknown as Record<string, unknown>).__botAudioPcs ?? []) as RTCPeerConnection[];
          let total = 0;
          let maxAudioLevel = -1;
          for (const pc of pcs) {
            if (pc.connectionState === 'closed') continue;
            try {
              const report = await pc.getStats();
              report.forEach((s) => {
                if (s.type === 'inbound-rtp' && (s as Record<string, unknown>).kind === 'audio') {
                  total += ((s as Record<string, unknown>).packetsReceived as number | undefined) ?? 0;
                  const lvl = (s as Record<string, unknown>).audioLevel as number | undefined;
                  if (lvl !== undefined && lvl > maxAudioLevel) maxAudioLevel = lvl;
                }
              });
            } catch { /* ignore */ }
          }
          return { total, maxAudioLevel };
        }).catch(() => ({ total: -1, maxAudioLevel: -1 }));

        const { total: rtpPackets, maxAudioLevel } = rtpResult as { total: number; maxAudioLevel: number };

        // Audio level idle — 30 polls × 2 s = 60 s near-silence → start alone timer.
        if (maxAudioLevel >= 0) {
          if (maxAudioLevel < 0.002) {
            this.rtpAudioIdleChecks++;
            if (this.rtpAudioIdleChecks >= 30 && !this.aloneTimer) {
              console.log('[bot] Near-zero audio level for ~60 s — will stop in 5 s');
              this.aloneTimer = setTimeout(() => {
                this.aloneTimer = null;
                if (this.hadActiveTracks && this.isActivelyRecording()) {
                  console.log('[bot] Audio level idle confirmed — alone in meeting, stopping');
                  void this.stop();
                }
              }, 5_000);
            }
          } else {
            this.rtpAudioIdleChecks = 0;
          }
        }

        if (rtpPackets >= 0) {
          if (this.lastRtpPackets < 0) {
            this.lastRtpPackets = rtpPackets; // first reading — just initialise
          } else if (rtpPackets > this.lastRtpPackets) {
            this.lastRtpPackets = rtpPackets;
            this.rtpIdleChecks = 0;
            // Packets flowing — do NOT cancel aloneTimer: Teams SFU sends comfort-noise
            // keepalives even after everyone leaves, so flowing packets don't mean presence.
          } else {
            this.rtpIdleChecks++;
            if (this.rtpIdleChecks >= 15 && !this.aloneTimer) {
              console.log('[bot] No new inbound RTP audio packets for ~30 s — will stop in 5 s');
              this.aloneTimer = setTimeout(() => {
                this.aloneTimer = null;
                if (this.hadActiveTracks && this.isActivelyRecording()) {
                  console.log('[bot] RTP idle confirmed — alone in meeting, stopping');
                  void this.stop();
                }
              }, 5_000);
            }
          }
        }
      }

      // Extract participant names by trying multiple Teams DOM selector patterns.
      // Teams' exact data-tid attributes vary across versions; we try several and use
      // whichever returns results. Names are read from data-tid, aria-label, or inner text.
      const rosterResult = await this.page.evaluate(() => {
        const selectors: Array<{ sel: string; nameFrom: 'data-tid' | 'aria-label' | 'text' | 'data-tid-suffix' }> = [
          // Video stage tiles — data-stream-type="Video" elements carry data-tid="{participant name}"
          // and are always present in DOM regardless of whether the roster panel is open.
          // This is the most reliable selector for modern Teams web client.
          { sel: '[data-stream-type="Video"]', nameFrom: 'data-tid' },
          // Roster panel entries (group calls / meetings with panel open)
          { sel: '[data-tid^="video-item-container-"]', nameFrom: 'data-tid-suffix' },
          { sel: '[data-tid="calling-roster-cell"]', nameFrom: 'text' },
          { sel: '[data-tid^="roster-participant-"]', nameFrom: 'aria-label' },
          { sel: '[data-tid="participant-roster-item"]', nameFrom: 'text' },
          { sel: '[data-cid="roster-participant"]', nameFrom: 'text' },
          { sel: '[data-tid="meeting-roster-item"]', nameFrom: 'text' },
          { sel: '[data-tid^="participant-pane-entry-"]', nameFrom: 'aria-label' },
          { sel: '[data-tid="roster-section"] [aria-label]', nameFrom: 'aria-label' },
          // Video stage display names (1-on-1 calls show the other person's name here)
          { sel: '[data-tid="tile-display-name"]', nameFrom: 'text' },
          { sel: '[data-tid^="calling-roster-tile-"]', nameFrom: 'text' },
          { sel: '[data-tid="call-roster-entry"]', nameFrom: 'text' },
          { sel: '[class*="displayName"]', nameFrom: 'text' },
        ];
        for (const { sel, nameFrom } of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length === 0) continue;
          const names = els.map((el) => {
            if (nameFrom === 'data-tid-suffix') {
              return (el.getAttribute('data-tid') ?? '').replace('video-item-container-', '').trim();
            }
            if (nameFrom === 'aria-label') {
              return (el.getAttribute('aria-label') ?? '').trim();
            }
            return ((el as HTMLElement).innerText ?? '').split('\n')[0].trim();
          }).filter(Boolean);
          const uniqueNames = [...new Set(names)];
          if (uniqueNames.length > 0) return { names: uniqueNames, rosterCount: uniqueNames.length };
        }

        // Broad fallback: scan the participant panel container for list items.
        const panelContainer = (
          document.querySelector('[data-tid="participant-pane"]') ??
          document.querySelector('[data-tid="roster"]') ??
          document.querySelector('[aria-label="Participants"]') ??
          document.querySelector('[aria-label="People"]') ??
          document.querySelector('[aria-label="Deltagere"]')
        );
        if (panelContainer) {
          const items = Array.from(panelContainer.querySelectorAll('[role="listitem"], [role="option"], [role="treeitem"]'));
          if (items.length > 0) {
            const names = items.map((el) => (el as HTMLElement).innerText.split('\n')[0].trim()).filter(Boolean);
            if (names.length > 0) return { names, rosterCount: items.length };
          }
        }

        // Last resort for 1-on-1 calls: parse the page title.
        // Teams sets the title to "[Name] | Microsoft Teams" or "Call with [Name] | Microsoft Teams".
        const title = document.title ?? '';
        const titleMatch = title.match(/^(?:Call with\s+)?(.+?)\s*[|\-]\s*Microsoft Teams/i);
        if (titleMatch?.[1]) {
          return { names: [titleMatch[1].trim()], rosterCount: 1 };
        }

        return { names: [] as string[], rosterCount: -1 };
      }).catch(() => ({ names: [] as string[], rosterCount: -1 }));

      const { names, rosterCount } = rosterResult as { names: string[]; rosterCount: number };

      if (names.length > 0) {
        console.log(`[bot] roster names found: ${JSON.stringify(names)} (rosterCount=${rosterCount})`);
      }

      // filtered = real human participants — excludes the bot's own name AND
      // system phantoms like "Microsoft Teams meeting" (which teams.live.com
      // always lists). Counting the phantom kept definitelyNotAlone true after
      // the last human left, cancelling the alone-timer so the bot never left.
      const filtered = names.filter((n) => isRealParticipant(n, this.config.botName));
      if (filtered.length > 0) {
        this.hadOtherParticipants = true;
        this.participants = Array.from(new Set([...this.participants, ...filtered]));
      }

      // Roster-based alone detection: stop when no real human remains.
      if ((this.hadActiveTracks || this.hadOtherParticipants) && this.isActivelyRecording()) {
        // The DOM rosterCount includes phantoms and can't distinguish them, so
        // we trust the filtered real-name count whenever we successfully read
        // names. Only when NO names could be extracted (re-render / panel
        // closed → names empty, rosterCount -1) do we fall back to the raw
        // rosterCount, and then only treat ≤1 as alone.
        const haveNames = names.length > 0;
        const definitelyAlone = haveNames
          ? filtered.length === 0
          : (rosterCount >= 0 && rosterCount <= 1);
        const definitelyNotAlone = filtered.length > 0;

        if (definitelyAlone && this.isActivelyRecording() && !this.aloneTimer) {
          console.log(`[bot] Roster alone (rosterCount=${rosterCount}, realHumans=${filtered.length}) — will stop in 5 s`);
          this.aloneTimer = setTimeout(() => {
            this.aloneTimer = null;
            if (this.isActivelyRecording()) {
              console.log('[bot] Roster alone confirmed — stopping');
              void this.stop();
            }
          }, 5_000);
        } else if (definitelyNotAlone) {
          // Video tiles confirm others are present — cancel any pending alone timer.
          // This is the reliable cancellation path (unlike RTP which keeps flowing via SFU).
          if (this.aloneTimer) { clearTimeout(this.aloneTimer); this.aloneTimer = null; }
        }
      }
    } catch { /* ignore — page may be navigating */ }
  }
}
