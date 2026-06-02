import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { assembleWebM } from './audio-utils';

export type BotStatus = 'joining' | 'recording' | 'paused' | 'ended' | 'error';

export interface BotSessionConfig {
  meetingUrl: string;
  meetingId: string;
  userId: string;
  botName: string;
  callbackUrl: string;
  internalSecret: string;
}

const LEAVE_BTN = '#hangup-button, button[data-tid="hangup-main-btn"], button[aria-label="Leave"], button[aria-label="Leave meeting"]';

export class TeamsMeetingBot {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: BotSessionConfig;

  status: BotStatus = 'joining';
  participants: string[] = [];
  elapsed: number = 0;
  error: string | null = null;

  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private participantTimer: ReturnType<typeof setInterval> | null = null;
  private aloneTimer: ReturnType<typeof setTimeout> | null = null;
  private audioChunks: Buffer[] = [];
  private hadActiveTracks = false;
  private onEndedCallback: (() => void) | null = null;

  constructor(config: BotSessionConfig) {
    this.config = config;
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
    this.browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--hide-scrollbars',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--ignore-certificate-errors',
      ],
    });

    this.context = await this.browser.newContext({
      permissions: ['microphone'],
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    });

    this.page = await this.context.newPage();

    // Patch RTCPeerConnection before any page scripts load so we capture every
    // remote audio track Teams creates. Each track gets a hidden <audio> element
    // with data-bot-captured="true" that _startAudioCapture() connects to the
    // AudioContext recording pipeline.
    await this.page.addInitScript(() => {
      const OrigRTC = window.RTCPeerConnection;
      // Set of RTCPeerConnections that have carried at least one audio track.
      // Used to detect when all remote peers have disconnected.
      const audioPcs = new Set<RTCPeerConnection>();
      let hadAudioPeer = false;

      const checkAllPeersGone = () => {
        if (!hadAudioPeer || audioPcs.size > 0) return;
        const cb = (window as unknown as Record<string, unknown>).__botAllPeersLeft as (() => void) | undefined;
        if (cb) cb();
      };

      function PatchedRTC(
        this: RTCPeerConnection,
        ...args: ConstructorParameters<typeof RTCPeerConnection>
      ) {
        const pc = new OrigRTC(...(args as [RTCConfiguration?]));
        pc.addEventListener('track', (event: RTCTrackEvent) => {
          if (event.track.kind !== 'audio') return;
          // Track this connection as an audio peer
          if (!audioPcs.has(pc)) {
            audioPcs.add(pc);
            hadAudioPeer = true;
            pc.addEventListener('connectionstatechange', () => {
              if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                audioPcs.delete(pc);
                checkAllPeersGone();
              }
            });
          }
          for (const stream of event.streams) {
            const el = document.createElement('audio');
            el.autoplay = true;
            el.muted = false;
            el.volume = 1.0;
            el.srcObject = stream;
            (el.dataset as DOMStringMap & { botCaptured: string }).botCaptured = 'true';
            el.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
            document.body.appendChild(el);
            el.play().catch(() => {});
          }
        });
        return pc;
      }
      PatchedRTC.prototype = OrigRTC.prototype;
      (window as unknown as Record<string, unknown>).RTCPeerConnection = PatchedRTC;
    });
  }

  private async _joinMeeting(): Promise<void> {
    const page = this.page!;
    const fs = await import('fs');

    const snap = async (label: string) => {
      try {
        const buf = await page.screenshot({ fullPage: true });
        const p = `/tmp/bot-snap-${label}.png`;
        fs.writeFileSync(p, buf);
        console.log(`[bot] snapshot → ${p}  url=${page.url()}`);
      } catch { /* ignore */ }
    };

    console.log('[bot] navigating to', this.config.meetingUrl);
    await page.goto(this.config.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(4000);
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

    // Teams may show "Continue without audio or video" modal when browser has
    // no camera/mic device. This BLOCKS the Join now button. Dismiss it eagerly.
    const noMediaBtn = page.locator([
      'button:has-text("Continue without audio or video")',
      'button[aria-label="Continue without audio or video"]',
    ].join(', ')).first();
    if (await noMediaBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('[bot] dismissing "Continue without audio or video" modal');
      await noMediaBtn.click();
      await page.waitForTimeout(500);
    }

    // Wait for the prejoin screen join button
    console.log('[bot] waiting for prejoin join button…');
    await page.waitForSelector(
      'button[data-tid="prejoin-join-button"], button[aria-label="Join now"], #prejoin-join-button',
      { timeout: 20_000 },
    ).catch(() => { console.log('[bot] prejoin join button wait timed out'); });
    await page.waitForTimeout(500);
    await snap('02-prejoin');

    // Fill in the display name
    const nameInput = page.locator(
      'input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i], input[aria-label*="name" i]',
    ).first();
    if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[bot] filling name:', this.config.botName);
      await nameInput.fill('');
      await nameInput.fill(this.config.botName);
      await page.waitForTimeout(300);
    } else {
      console.log('[bot] name input not found');
    }

    // Turn off camera using the actual aria-label button (not the hidden checkbox input)
    const cameraBtn = page.locator([
      'button[aria-label="Turn off video"]',
      'button[aria-label="Turn off camera"]',
      'button[aria-label="Turn camera off"]',
      'button[aria-label="Camera on, click to turn off"]',
      'button[aria-label="Sluk video"]',
      'button[aria-label="Sluk kamera"]',
    ].join(', ')).first();
    if (await cameraBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cameraBtn.click().catch(() => {});
      console.log('[bot] turned camera off');
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
      const htmlFail = await page.content().catch(() => '');
      fs.writeFileSync('/tmp/bot-page-no-join.html', htmlFail);
      throw new Error('Could not find join button');
    }
    await page.waitForTimeout(4000);
    await snap('03-after-join');

    // Race: admitted (Leave button appears) vs denied vs timeout (5 min)
    console.log('[bot] waiting for admission (may be in lobby)…');
    const joinResult = await Promise.race([
      // Leave button is the reliable "I'm in the meeting" indicator
      page.waitForSelector(LEAVE_BTN, { timeout: 300_000 })
        .then(() => 'admitted' as const),

      // Text-based denial detection
      page.waitForFunction(
        () => {
          const text = (document.body.innerText ?? '').toLowerCase();
          return (
            text.includes("weren't let in") ||
            text.includes("was not let in") ||
            text.includes("didn't let you in") ||
            text.includes("request was declined") ||
            text.includes("entry was denied") ||
            text.includes("sorry, but you were denied")
          );
        },
        undefined,
        { timeout: 300_000 },
      ).then(() => 'denied' as const),
    ]).catch(async () => {
      await snap('04-lobby-timeout');
      const htmlFb = await page.content().catch(() => '');
      fs.writeFileSync('/tmp/bot-page-fallback.html', htmlFb);
      return 'timeout' as const;
    });

    if (joinResult !== 'admitted') {
      console.log(`[bot] join failed: ${joinResult}`);
      await snap(`04-join-${joinResult}`);
      throw new Error(`Entry ${joinResult} — host denied or meeting unreachable`);
    }

    await snap('05-in-meeting');
    const htmlIn = await page.content().catch(() => '');
    fs.writeFileSync('/tmp/bot-page-in-meeting.html', htmlIn);
    console.log('[bot] in meeting, proceeding to audio capture, url=', page.url());

    await this._startAudioCapture();
  }

  private async _startAudioCapture(): Promise<void> {
    const page = this.page!;

    await page.exposeFunction('__botAudioChunk', (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      this.audioChunks.push(buf);
    });

    await page.exposeFunction('__botMeetingEnded', () => {
      void this._handleMeetingEnded();
    });

    // Fired by the RTCPeerConnection patch when all audio peers close their connections.
    // We schedule a stop with a 15-second grace window so brief reconnections don't
    // cause a premature exit.
    await page.exposeFunction('__botAllPeersLeft', () => {
      if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
        if (!this.aloneTimer) {
          console.log('[bot] All audio peers disconnected — will stop in 15 s unless someone rejoins');
          this.aloneTimer = setTimeout(() => {
            this.aloneTimer = null;
            if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
              console.log('[bot] Grace period elapsed — alone in meeting, stopping');
              void this.stop();
            }
          }, 15_000);
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

        const dest = ctx.createMediaStreamDestination();

        const connectEl = (el: HTMLAudioElement) => {
          try {
            const src = ctx.createMediaElementSource(el);
            src.connect(dest);
          } catch { /* already connected */ }
        };

        // Connect all existing audio elements (including RTCPeerConnection-injected ones)
        document.querySelectorAll<HTMLAudioElement>('audio').forEach(connectEl);

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

        // Watch for meeting-ended or kicked state
        const endObs = new MutationObserver(() => {
          const ended = document.querySelector(
            '[data-tid="call-ended-title"], .ts-call-ended, [aria-label*="ended" i]',
          );
          const text = (document.body.innerText ?? '').toLowerCase();
          const kicked =
            text.includes("you were removed") ||
            text.includes("you've been removed") ||
            text.includes("removed from the meeting");
          if (ended || kicked) {
            endObs.disconnect();
            audioObs.disconnect();
            recorder.stop();
            (window as unknown as Record<string, () => void>).__botMeetingEnded();
          }
        });
        endObs.observe(document.body, { childList: true, subtree: true });
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
    this.status = 'ended';
    this._stopElapsedTimer();
    this._stopParticipantPolling();
    await this._uploadAudio();
    await this._cleanup();
    this.onEndedCallback?.();
  }

  private async _uploadAudio(): Promise<void> {
    if (this.audioChunks.length === 0) {
      await this._notifyNoRecording();
      return;
    }

    const audioBuffer = assembleWebM(this.audioChunks);

    const FormData = (await import('form-data')).default;
    const fetch = (await import('node-fetch')).default;

    const form = new FormData();
    form.append('audio', audioBuffer, {
      filename: 'recording.webm',
      contentType: 'audio/webm',
    });
    form.append('meetingId', this.config.meetingId);
    form.append('userId', this.config.userId);
    form.append('participants', JSON.stringify(this.participants));

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
    const fetch = (await import('node-fetch')).default;
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
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.close();
    } catch { /* ignore */ }
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  private _startElapsedTimer(): void {
    this._stopElapsedTimer();
    this.elapsedTimer = setInterval(() => { this.elapsed += 1; }, 1000);
  }

  private _stopElapsedTimer(): void {
    if (this.elapsedTimer) { clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
  }

  private _startParticipantPolling(): void {
    this._stopParticipantPolling();
    this.participantTimer = setInterval(() => { void this._pollParticipants(); }, 5000);
  }

  private _stopParticipantPolling(): void {
    if (this.participantTimer) { clearInterval(this.participantTimer); this.participantTimer = null; }
    if (this.aloneTimer) { clearTimeout(this.aloneTimer); this.aloneTimer = null; }
  }

  private async _pollParticipants(): Promise<void> {
    if (!this.page) return;
    try {
      // Primary: check if Leave button is still visible — if gone, we were kicked or meeting ended
      const leaveVisible = await this.page.locator(LEAVE_BTN).first().isVisible().catch(() => false);
      if (!leaveVisible && this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
        console.log('[bot] Leave button gone — kicked or meeting ended');
        void this.stop();
        return;
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
        // Cancel any pending alone-timer since audio tracks are still live
        if (this.aloneTimer) { clearTimeout(this.aloneTimer); this.aloneTimer = null; }
      } else if (liveTrackCount === 0 && this.hadActiveTracks
          && (this.status === 'recording' || this.status === 'paused')
          && !this.aloneTimer) {
        // Schedule a stop after a 15-second grace period so brief renegotiations
        // don't cause a premature exit.
        console.log('[bot] No live remote tracks — will stop in 15 s unless tracks return');
        this.aloneTimer = setTimeout(() => {
          this.aloneTimer = null;
          if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
            console.log('[bot] Grace period elapsed — alone in meeting, stopping');
            void this.stop();
          }
        }, 15_000);
      }

      // Best-effort: extract participant names from roster (may not work on all Teams variants)
      const names = await this.page.evaluate(() => {
        const selectors = [
          '[data-tid="calling-roster-content"] [data-tid="participant-item-display-name"]',
          '[data-tid="participant-list"] [class*="displayName"]',
          '[id="roster-section"] [class*="participantName"]',
          '.ts-calling-screen [class*="participantName"]',
        ];
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > 0) return els.map((el) => el.textContent?.trim() ?? '').filter(Boolean);
        }
        return [];
      }).catch(() => [] as string[]);

      const filtered = (names as string[]).filter((n) => n && n !== this.config.botName);
      if (filtered.length > 0) {
        this.participants = Array.from(new Set([...this.participants, ...filtered]));
      }
    } catch { /* ignore — page may be navigating */ }
  }
}
