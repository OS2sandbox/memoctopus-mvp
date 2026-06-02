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
  private audioChunks: Buffer[] = [];
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
    }
  }

  private async _launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: false,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    this.context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    });

    this.page = await this.context.newPage();
  }

  private async _joinMeeting(): Promise<void> {
    const page = this.page!;

    await page.goto(this.config.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // "Continue on this browser" or "Join on this browser" button
    const continueSelectors = [
      'button:has-text("Continue on this browser")',
      'button:has-text("Join on this browser")',
      'a:has-text("Continue on this browser")',
    ];
    for (const sel of continueSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(2000);
        break;
      }
    }

    // Fill in the display name
    const nameInput = page.locator(
      'input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i], input[aria-label*="name" i]',
    ).first();
    if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await nameInput.fill('');
      await nameInput.fill(this.config.botName);
    }

    // Turn off camera (if toggle is present)
    const cameraToggle = page.locator(
      'div[data-tid="toggle-video"], button[aria-label*="camera" i], button[aria-label*="video" i]',
    ).first();
    if (await cameraToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isOn = await cameraToggle.getAttribute('aria-pressed').catch(() => null);
      if (isOn === 'true') await cameraToggle.click();
    }

    // Click "Join now"
    const joinBtn = page.locator(
      'button[data-tid="prejoin-join-button"], button:has-text("Join now"), button:has-text("Deltag nu")',
    ).first();
    await joinBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await joinBtn.click();

    // Wait until admitted / in the meeting
    await page.waitForSelector(
      '[data-tid="calling-roster-content"], [data-tid="participant-list"], [id="roster-section"]',
      { timeout: 60_000 },
    );

    // Start capturing audio via MediaRecorder injected into the page
    await this._startAudioCapture();
  }

  private async _startAudioCapture(): Promise<void> {
    const page = this.page!;

    // Expose a function so the page can send audio chunks back to Node
    await page.exposeFunction('__botAudioChunk', (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      this.audioChunks.push(buf);
    });

    await page.exposeFunction('__botMeetingEnded', () => {
      void this._handleMeetingEnded();
    });

    await page.evaluate(() => {
      try {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();

        // Capture all audio elements (Teams pipes audio through <audio> or AudioContext)
        document.querySelectorAll<HTMLAudioElement>('audio').forEach((el) => {
          try {
            const src = ctx.createMediaElementSource(el);
            src.connect(dest);
          } catch { /* element already has a source node */ }
        });

        const recorder = new MediaRecorder(dest.stream, {
          mimeType: 'audio/webm;codecs=opus',
          audioBitsPerSecond: 128_000,
        });

        recorder.ondataavailable = async (e: BlobEvent) => {
          if (e.data.size === 0) return;
          const ab = await e.data.arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
          (window as unknown as Record<string, unknown>).__botAudioChunk(b64);
        };

        recorder.start(30_000); // 30-second timeslices

        (window as unknown as Record<string, unknown>).__mediaRecorder = recorder;

        // Watch for meeting-ended state
        const obs = new MutationObserver(() => {
          const ended = document.querySelector(
            '[data-tid="call-ended-title"], .ts-call-ended, [aria-label*="ended" i]',
          );
          if (ended) {
            obs.disconnect();
            recorder.stop();
            (window as unknown as Record<string, unknown>).__botMeetingEnded();
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
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

    // Request final chunk from MediaRecorder
    await this.page?.evaluate(() => {
      const rec = (window as unknown as Record<string, unknown>).__mediaRecorder as MediaRecorder | undefined;
      if (rec && rec.state !== 'inactive') rec.stop();
    }).catch(() => {});

    // Small wait for the final ondataavailable to fire
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
    if (this.audioChunks.length === 0) return;

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
  }

  private async _pollParticipants(): Promise<void> {
    if (!this.page) return;
    try {
      const names = await this.page.evaluate(() => {
        // Teams renders participants in a roster panel
        const selectors = [
          '[data-tid="calling-roster-content"] [data-tid="participant-item-display-name"]',
          '[data-tid="participant-list"] [class*="displayName"]',
          '[id="roster-section"] [class*="participantName"]',
          // Fallback: any element that looks like a participant name
          '.ts-calling-screen [class*="participantName"]',
        ];
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > 0) return els.map((el) => el.textContent?.trim() ?? '').filter(Boolean);
        }
        return [];
      });

      // Exclude the bot itself from the list
      const botName = this.config.botName;
      const filtered = (names as string[]).filter((n: string) => n && n !== botName);
      if (filtered.length > 0) {
        // Merge new names into existing list (deduplicate)
        const merged = Array.from(new Set([...this.participants, ...filtered]));
        this.participants = merged;
      }
    } catch { /* ignore — page may be navigating */ }
  }
}
