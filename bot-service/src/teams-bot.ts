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
  private aloneCheckCount = 0;
  private lastRtpPackets = -1;
  private rtpIdleChecks = 0;
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

    // Silence the bot's outgoing microphone at the WebRTC level.
    // --use-fake-ui-for-media-stream provides a fake audio device that can produce
    // audible tones/clicks. Intercepting getUserMedia lets us disable the audio
    // track before Teams ever adds it to an RTCPeerConnection, so the bot always
    // transmits silence regardless of what the Teams UI shows.
    await this.page.addInitScript(() => {
      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const stream = await origGUM(constraints ?? {});
        stream.getAudioTracks().forEach((t) => { t.enabled = false; });
        return stream;
      };
    });

    // Patch RTCPeerConnection before any page scripts load so we capture every
    // remote audio track Teams creates. Each track gets a hidden <audio> element
    // with data-bot-captured="true" that _startAudioCapture() connects to the
    // AudioContext recording pipeline.
    await this.page.addInitScript(() => {
      const OrigRTC = window.RTCPeerConnection;
      // Set of RTCPeerConnections that have carried at least one audio track.
      // Used to detect when all remote peers have disconnected.
      const audioPcs = new Set<RTCPeerConnection>();
      // Flat list exposed to Node.js so _pollParticipants can call getStats() on each PC.
      const audioPcsList: RTCPeerConnection[] = [];
      (window as unknown as Record<string, unknown>).__botAudioPcs = audioPcsList;
      let hadAudioPeer = false;

      // Check whether all known audio peers are gone — either via RTC state changes
      // or via audio track readyState. Teams routes through a relay so connection
      // states often stay 'connected' after participants leave; track states are more
      // reliable as a secondary signal.
      const checkAllPeersGone = () => {
        if (!hadAudioPeer || audioPcs.size === 0) return;
        const allConnectionsGone = [...audioPcs].every((pc) =>
          pc.connectionState === 'closed' ||
          pc.connectionState === 'failed' ||
          pc.iceConnectionState === 'disconnected' ||
          pc.iceConnectionState === 'failed' ||
          pc.iceConnectionState === 'closed',
        );
        // Also trigger if every captured audio track has ended
        const capturedEls = Array.from(document.querySelectorAll<HTMLAudioElement>('audio[data-bot-captured]'));
        const allTracksEnded = capturedEls.length > 0 && capturedEls.every((el) => {
          const s = el.srcObject;
          if (!(s instanceof MediaStream)) return true;
          return s.getAudioTracks().every((t) => t.readyState === 'ended');
        });
        if (!allConnectionsGone && !allTracksEnded) return;
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
            audioPcsList.push(pc);
            hadAudioPeer = true;
            // Notify Node.js side so it can cancel any pending alone-timer
            const rejoinCb = (window as unknown as Record<string, unknown>).__botPeerRejoined as (() => void) | undefined;
            if (rejoinCb) rejoinCb();
            pc.addEventListener('connectionstatechange', () => {
              if (pc.connectionState === 'closed') audioPcs.delete(pc);
              checkAllPeersGone();
            });
            pc.addEventListener('iceconnectionstatechange', () => {
              checkAllPeersGone();
            });
          }
          // Listen for the track itself ending — fired immediately when a participant
          // leaves Teams (even via the relay). This is the fastest departure signal.
          event.track.addEventListener('ended', () => {
            setTimeout(checkAllPeersGone, 200);
          });
          for (const stream of event.streams) {
            // Keep element only as a stream container for liveTrackCount checks.
            // muted=true prevents the remote audio from playing back through the
            // browser's virtual output device and looping into the fake microphone.
            const el = document.createElement('audio');
            el.muted = true;
            el.srcObject = stream;
            (el.dataset as DOMStringMap & { botCaptured: string }).botCaptured = 'true';
            el.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
            document.body.appendChild(el);
            // removetrack fires synchronously when the track is removed from the stream
            stream.addEventListener('removetrack', () => {
              setTimeout(checkAllPeersGone, 200);
            });
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

    // Mute microphone — prevents the bot from sending audio back to participants
    // (feedback loop) and from appearing as a speaking participant in Teams.
    const micBtn = page.locator([
      'button[aria-label="Turn off microphone"]',
      'button[aria-label="Mute microphone"]',
      'button[aria-label="Microphone on, click to mute"]',
      'button[aria-label="Sluk mikrofon"]',
      'button[data-tid="toggle-mute"]',
    ].join(', ')).first();
    if (await micBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await micBtn.click().catch(() => {});
      console.log('[bot] muted microphone');
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
    // Wait for the lobby/meeting UI to appear rather than sleeping a fixed 4 s.
    await page.waitForSelector(
      `${LEAVE_BTN}, [data-tid="lobby-section"], [aria-label="Lobby"]`,
      { timeout: 8000 },
    ).catch(() => {});
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

    // Teams sometimes re-enables the mic after lobby admission — mute as soon as
    // the in-call toolbar renders. Wait up to 5 s for it to appear.
    const inCallMicSel = [
      'button[data-tid="microphone-button"]',
      'button[data-tid="toggle-mute"]',
      'button[aria-label="Mute"]',
      'button[aria-label="Mute microphone"]',
      'button[aria-label="Sluk mikrofon"]',
      'button[aria-label="Slå lyden fra"]',
      'button[title="Mute microphone (Ctrl+Shift+M)"]',
    ].join(', ');
    const inCallMicBtn = page.locator(inCallMicSel).first();
    if (await inCallMicBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await inCallMicBtn.click().catch(() => {});
      console.log('[bot] muted microphone in-call via button');
    } else {
      // Fallback: Ctrl+Shift+M is Teams' universal mute toggle.
      // Ensure the page has focus so the keyboard shortcut registers.
      await page.bringToFront().catch(() => {});
      await page.locator('body').click({ position: { x: 10, y: 10 } }).catch(() => {});
      await page.keyboard.press('Control+Shift+M').catch(() => {});
      console.log('[bot] muted microphone in-call via Ctrl+Shift+M');
    }

    // Open the participants panel so the roster selectors in _pollParticipants()
    // find real names — the panel DOM nodes only exist when the panel is open.
    const participantsBtn = page.locator([
      'button[data-tid="participants-button"]',
      'button[aria-label="Show participants"]',
      'button[aria-label="Vis deltagere"]',
      'button[aria-label="People"]',
    ].join(', ')).first();
    if (await participantsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await participantsBtn.click().catch(() => {});
      console.log('[bot] opened participants panel');
    }
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

    // Fired by the RTCPeerConnection patch when a new audio peer joins.
    // Cancels any pending alone-timer so a reconnecting participant doesn't trigger a stop.
    await page.exposeFunction('__botPeerRejoined', () => {
      if (this.aloneTimer) {
        clearTimeout(this.aloneTimer);
        this.aloneTimer = null;
      }
      this.aloneCheckCount = 0;
      this.lastRtpPackets = -1;
      this.rtpIdleChecks = 0;
      console.log('[bot] New audio peer joined — cancelled alone timer');
    });

    // Fired by the RTCPeerConnection patch when all audio peers close their connections
    // or when the roster DOM observer detects only the bot remains.
    // We schedule a stop with a 5-second grace window so brief reconnections don't
    // cause a premature exit.
    await page.exposeFunction('__botAllPeersLeft', () => {
      // Allow stopping if we've recorded something OR been in the meeting >60 s
      // (handles the case where someone joins and immediately leaves before speaking).
      const canStop = this.hadActiveTracks || this.elapsed > 60;
      if (canStop && (this.status === 'recording' || this.status === 'paused')) {
        if (!this.aloneTimer) {
          console.log('[bot] All audio peers disconnected — will stop in 5 s unless someone rejoins');
          this.aloneTimer = setTimeout(() => {
            this.aloneTimer = null;
            const stillCanStop = this.hadActiveTracks || this.elapsed > 60;
            if (stillCanStop && (this.status === 'recording' || this.status === 'paused')) {
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

        // Audio graph: sources → analyser → dest (recorder)
        // The analyser is used for long-silence fallback detection (see below).
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        const dest = ctx.createMediaStreamDestination();
        analyser.connect(dest);

        // createMediaStreamSource routes the MediaStream directly into the graph,
        // bypassing the audio-element playback requirement that silently fails in
        // headless Chrome (no real audio output device → element never decoded).
        const connectedStreams = new Set<MediaStream>();
        const connectEl = (el: HTMLAudioElement) => {
          const stream = el.srcObject;
          if (!(stream instanceof MediaStream)) return;
          if (connectedStreams.has(stream)) return;
          connectedStreams.add(stream);
          ctx.createMediaStreamSource(stream).connect(analyser);
        };

        // Long-silence fallback — Teams routes audio through a relay that keeps
        // RTC connections alive even after every participant has left, so peer
        // state and track-ended events are unreliable departure signals.
        // 60 checks × 5 s = 5 minutes of unbroken silence → trigger leave.
        // This is intentionally conservative: normal pauses, muted speakers, and
        // screen-share-only segments all produce silence without meaning everyone
        // has left. Five minutes of complete silence reliably means an empty room.
        const silenceData = new Uint8Array(analyser.frequencyBinCount);
        let hadAudio = false;
        let silenceChecks = 0;
        setInterval(() => {
          analyser.getByteTimeDomainData(silenceData);
          let maxDev = 0;
          for (let i = 0; i < silenceData.length; i++) {
            const dev = Math.abs(silenceData[i] - 128);
            if (dev > maxDev) maxDev = dev;
          }
          const win = window as unknown as Record<string, (() => void) | undefined>;
          if (maxDev > 5) {
            hadAudio = true;
            silenceChecks = 0;
          } else if (hadAudio) {
            silenceChecks++;
            if (silenceChecks >= 60) {
              silenceChecks = 0;
              win.__botAllPeersLeft?.();
            }
          }
        }, 5000);

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

        // Participant panel observer — fires the moment a participant row is removed.
        // This is faster than polling and works even when track/RTC states are masked
        // by the Teams relay server keeping connections alive.
        const watchRosterPanel = (panel: Element) => {
          const rosterObs = new MutationObserver(() => {
            const win2 = window as unknown as Record<string, (() => void) | undefined>;
            // Count visible participant rows
            const rowSelectors = [
              '[data-tid="calling-roster-content"] [data-tid="participant-item"]',
              '[data-tid="calling-roster-content"] [class*="participantItem"]',
              '[data-tid="calling-roster-content"] > div',
            ];
            let count = -1;
            for (const sel of rowSelectors) {
              const els = panel.querySelectorAll(sel);
              if (els.length > 0) { count = els.length; break; }
            }
            // Also check the header count badge as a cross-reference
            const header = document.querySelector('[data-tid="calling-roster-header"]');
            if (header) {
              const m = (header.textContent ?? '').match(/\d+/);
              if (m) count = parseInt(m[0], 10);
            }
            if (count === 1) win2.__botAllPeersLeft?.();
          });
          rosterObs.observe(panel, { childList: true, subtree: true });
        };

        const existingPanel = document.querySelector(
          '[data-tid="calling-roster-content"], [data-tid="participant-list"]',
        );
        if (existingPanel) {
          watchRosterPanel(existingPanel);
        } else {
          // Panel opens after the bot joins — wait for it to appear
          const panelWatcher = new MutationObserver(() => {
            const panel = document.querySelector(
              '[data-tid="calling-roster-content"], [data-tid="participant-list"]',
            );
            if (panel) { panelWatcher.disconnect(); watchRosterPanel(panel); }
          });
          panelWatcher.observe(document.body, { childList: true, subtree: true });
        }

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
    // Strip internal sentinel values before sending to the server
    const realParticipants = this.participants.filter((p) => p !== '__audio_detected__');
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
    this.participantTimer = setInterval(() => { void this._pollParticipants(); }, 2000);
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
        this.aloneCheckCount = 0;
        if (this.participants.length === 0) this.participants = ['__audio_detected__'];
        // Note: aloneTimer is NOT cancelled here — Teams can leave tracks in 'live'
        // state even after a participant disconnects. Cancellation is handled by
        // __botPeerRejoined which fires only when a genuinely new peer joins.
      } else if (liveTrackCount === 0 && this.hadActiveTracks
          && (this.status === 'recording' || this.status === 'paused')
          && !this.aloneTimer) {
        // Schedule a stop after an 8-second grace period so brief renegotiations
        // don't cause a premature exit.
        console.log('[bot] No live remote tracks — will stop in 5 s unless tracks return');
        this.aloneTimer = setTimeout(() => {
          this.aloneTimer = null;
          if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
            console.log('[bot] Grace period elapsed — alone in meeting, stopping');
            void this.stop();
          }
        }, 5_000);
      }

      // RTP packet count check — more reliable than track readyState because Teams'
      // SFU stops forwarding audio packets to the bot when no participants remain,
      // even though it keeps the RTC connection alive. Muted participants still
      // cause packets to flow (comfort noise / keep-alive), so this correctly
      // distinguishes "muted but present" from "everyone left".
      // 15 polls × 2 s = 30 s of zero new packets → start the alone timer.
      if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
        const rtpPackets = await this.page.evaluate(async () => {
          const pcs = ((window as unknown as Record<string, unknown>).__botAudioPcs ?? []) as RTCPeerConnection[];
          let total = 0;
          for (const pc of pcs) {
            if (pc.connectionState === 'closed') continue;
            try {
              const report = await pc.getStats();
              report.forEach((s) => {
                if (s.type === 'inbound-rtp' && (s as Record<string, unknown>).kind === 'audio') {
                  total += ((s as Record<string, unknown>).packetsReceived as number | undefined) ?? 0;
                }
              });
            } catch { /* ignore */ }
          }
          return total;
        }).catch(() => -1);

        if (rtpPackets >= 0) {
          if (this.lastRtpPackets < 0) {
            this.lastRtpPackets = rtpPackets; // first reading — just initialise
          } else if (rtpPackets > this.lastRtpPackets) {
            this.lastRtpPackets = rtpPackets;
            this.rtpIdleChecks = 0;
            // Packets are flowing — someone is still in the call; cancel any pending timer
            if (this.aloneTimer) { clearTimeout(this.aloneTimer); this.aloneTimer = null; }
          } else {
            // No new packets this poll
            this.rtpIdleChecks++;
            if (this.rtpIdleChecks >= 15 && !this.aloneTimer) {
              console.log('[bot] No new inbound RTP audio packets for ~30 s — will stop in 5 s');
              this.aloneTimer = setTimeout(() => {
                this.aloneTimer = null;
                if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
                  console.log('[bot] RTP idle confirmed — alone in meeting, stopping');
                  void this.stop();
                }
              }, 5_000);
            }
          }
        }
      }

      // Best-effort: extract participant names and count from roster panel.
      // The panel is open (opened in _joinMeeting) so its DOM nodes are present.
      const rosterResult = await this.page.evaluate(() => {
        // Try to read participant item display names — multiple selector strategies for
        // different Teams web versions and locales.
        const nameSelectors = [
          '[data-tid="calling-roster-content"] [data-tid="participant-item-display-name"]',
          '[data-tid="participant-list"] [class*="displayName"]',
          '[id="roster-section"] [class*="participantName"]',
          '.ts-calling-screen [class*="participantName"]',
          // Additional selectors for newer Teams web versions
          '[data-tid="calling-roster-content"] [data-tid="participant-item"] [class*="name" i]',
          '[data-tid="calling-roster-content"] [data-tid="participant-item"] span:first-child',
          '[class*="rosterSection"] [class*="name"]',
          '[class*="participantsList"] [class*="name"]',
        ];
        let names: string[] = [];
        for (const sel of nameSelectors) {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length > 0) {
            names = els.map((el) => el.textContent?.trim() ?? '').filter(Boolean);
            break;
          }
        }

        // Fallback: extract first meaningful text from each participant row directly.
        // Teams often nests the name in the first non-empty span inside the item.
        if (names.length === 0) {
          const items = document.querySelectorAll('[data-tid="participant-item"]');
          if (items.length > 0) {
            const extracted: string[] = [];
            items.forEach((item) => {
              // Walk spans to find the first one that looks like a name (not an icon/status word)
              const spans = Array.from(item.querySelectorAll('span'));
              const uiWords = /^(muted|unmuted|presenter|attendee|video|off|on|\d+)$/i;
              for (const span of spans) {
                const text = span.textContent?.trim() ?? '';
                if (text && text.length > 1 && !uiWords.test(text)) {
                  extracted.push(text);
                  break;
                }
              }
            });
            if (extracted.length > 0) names = extracted;
          }
        }

        // Also scrape names from video tiles visible in the main meeting grid.
        // These are present even when the roster panel is closed.
        if (names.length === 0) {
          const tileNameSelectors = [
            '[data-tid="video-tile-display-name"]',
            '[data-tid="display-name"]',
            '[class*="videoTile"] [class*="displayName"]',
            '[class*="videoTile"] [class*="name"]',
            '[class*="stageTile"] [class*="name"]',
          ];
          for (const sel of tileNameSelectors) {
            const els = Array.from(document.querySelectorAll(sel));
            if (els.length > 0) {
              names = els.map((el) => el.textContent?.trim() ?? '').filter(Boolean);
              break;
            }
          }
        }

        // Try to get total participant count (including unnamed items).
        // Teams shows a count in the panel header or as numbered list items.
        let rosterCount = -1;
        const countSelectors = [
          '[data-tid="calling-roster-header"]',
          '[data-tid="participants-button"] [class*="count"]',
          '[aria-label*="participants" i]',
          '[aria-label*="deltagere" i]',
        ];
        for (const sel of countSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const match = (el.textContent ?? '').match(/\d+/);
            if (match) { rosterCount = parseInt(match[0]); break; }
          }
        }
        // Fallback: count distinct participant rows in the panel
        if (rosterCount < 0) {
          const rowSelectors = [
            '[data-tid="calling-roster-content"] [data-tid="participant-item"]',
            '[data-tid="calling-roster-content"] [class*="participantItem"]',
            '[data-tid="calling-roster-content"] > div',
          ];
          for (const sel of rowSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) { rosterCount = els.length; break; }
          }
        }

        return { names, rosterCount };
      }).catch(() => ({ names: [] as string[], rosterCount: -1 }));

      const { names, rosterCount } = rosterResult as { names: string[]; rosterCount: number };

      const filtered = names.filter((n) => n && n !== this.config.botName);
      if (filtered.length > 0) {
        this.aloneCheckCount = 0;
        this.participants = Array.from(new Set([...this.participants, ...filtered]));
      }

      // Roster-based alone detection: if count dropped to 1 (just the bot) after
      // we previously had other participants, increment the consecutive-alone counter.
      // After 2 consecutive polls (≈4 s), start the grace timer.
      if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
        const hadRealNames = this.participants.filter((p) => p !== '__audio_detected__').length > 0;
        const definitelyAlone = rosterCount === 1
          || (rosterCount < 0 && filtered.length === 0 && hadRealNames);
        const definitelyNotAlone = rosterCount > 1 || filtered.length > 0;

        if (definitelyAlone) {
          this.aloneCheckCount++;
          // At 2s polling, 2 consecutive "alone" reads = 4 s of confirmed solitude
          if (this.aloneCheckCount >= 2 && !this.aloneTimer) {
            console.log('[bot] Roster shows bot is alone — will stop in 5 s unless someone joins');
            this.aloneTimer = setTimeout(() => {
              this.aloneTimer = null;
              if (this.hadActiveTracks && (this.status === 'recording' || this.status === 'paused')) {
                console.log('[bot] Grace period elapsed — alone in meeting, stopping');
                void this.stop();
              }
            }, 5_000);
          }
        } else if (definitelyNotAlone) {
          this.aloneCheckCount = 0;
        }
      }
    } catch { /* ignore — page may be navigating */ }
  }
}
