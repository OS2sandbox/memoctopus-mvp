// Injected into every page via addInitScript before any Teams JS loads.
// Must be self-contained — no imports, no closures over Node.js variables.
//
// What this patch does:
//   1. Hooks RTCPeerConnection construction to listen for remote audio tracks.
//      Audio tracks are mirrored into hidden <audio> elements and the
//      receiving PC is registered in window.__botAudioPcs so the Node side
//      can call getStats() on each PC during participant polling.
//   2. Installs a global unhandledrejection swallower for DOM-Event-typed
//      rejections (the "{"isTrusted":true}" pattern). Teams' bundles
//      routinely convert browser Events (MediaStreamTrack 'ended', XMLHttp
//      'error', MediaError) into Promise rejections. When these go
//      unhandled, Teams' own onunhandledrejection handler can cascade
//      into automatic "Leaving..." transitions.
//
// What this patch does NOT do (intentionally removed):
//   - It does NOT redirect video addTrack/addTransceiver to a throw-away
//     RTCPeerConnection. That pattern caused InvalidAccessError every time
//     Teams later tried to remove or query the sender on the real PC,
//     which surfaced as "Action failed → Leaving..." or unhandled-rejection
//     cascades post-admission. The BUNDLE id=11 collision the redirect was
//     protecting against is prevented upstream by the
//     `--use-file-for-fake-video-capture=/dev/null` Chromium launch flag
//     (see teams-bot.ts launch args). That flag swaps the built-in fake
//     camera for a file-based device with different codec capabilities, so
//     there is no id=11 conflict in the SDP and no need to hide video from
//     the real PC.
export function installWebRTCPatch(): void {
  const win = window as unknown as Record<string, unknown>;
  const OrigRTC = window.RTCPeerConnection;

  // Set of RTCPeerConnections that have carried at least one audio track.
  const audioPcs = new Set<RTCPeerConnection>();
  // Flat list exposed to Node.js so _pollParticipants can call getStats() on each PC.
  const audioPcsList: RTCPeerConnection[] = [];
  win.__botAudioPcs = audioPcsList;
  let hadAudioPeer = false;

  // ─── Unhandled-rejection swallower ─────────────────────────────────────────
  //
  // Teams' code catches browser Events (MediaStreamTrack 'ended',
  // XMLHttpRequest 'error', etc.) and re-throws them as Promise rejections.
  // The Event serialises as `{"isTrusted":true}` in the console. When these
  // go unhandled, Teams' own state machine sometimes reacts by transitioning
  // the call to "Leaving..." with no other diagnostic.
  //
  // We attach a listener that calls preventDefault on Event-shaped rejections
  // — this suppresses the browser's default "log to console" behaviour AND,
  // in practice, prevents Teams' internal error-recovery from firing the
  // leave cascade. We deliberately do NOT swallow non-Event rejections (real
  // errors with stack traces still surface so we can debug them).
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason as unknown;
    if (
      reason instanceof Event ||
      (typeof reason === 'object' && reason !== null && (reason as { isTrusted?: boolean }).isTrusted === true)
    ) {
      ev.preventDefault();
    }
  });

  // ─── checkAllPeersGone — composite departure signal ────────────────────────
  //
  // Check whether all known audio peers are gone — either via RTC state changes
  // or via audio track readyState. Teams routes through a relay so connection
  // states often stay 'connected' after participants leave; track states are more
  // reliable as a secondary signal.
  const checkAllPeersGone = () => {
    if (!hadAudioPeer || audioPcs.size === 0) return;
    // 'disconnected' is a transient ICE state (occurs during renegotiation)
    // and must NOT be treated as "peer gone" — doing so causes false departures
    // immediately after admission when ICE briefly hits 'disconnected' before
    // settling to 'connected'. Only 'failed' and 'closed' are terminal.
    const allConnectionsGone = [...audioPcs].every((pc) =>
      pc.connectionState === 'closed' ||
      pc.connectionState === 'failed' ||
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
    const cb = win.__botAllPeersLeft as (() => void) | undefined;
    if (cb) cb();
  };

  // ─── Constructor patch — capture remote audio tracks ────────────────────────
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
        const rejoinCb = win.__botPeerRejoined as (() => void) | undefined;
        if (rejoinCb) rejoinCb();
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'closed') {
            audioPcs.delete(pc);
            const idx = audioPcsList.indexOf(pc);
            if (idx !== -1) audioPcsList.splice(idx, 1);
          }
          checkAllPeersGone();
        });
        pc.addEventListener('iceconnectionstatechange', () => {
          checkAllPeersGone();
        });
      }
      // event.streams can be empty in unified-plan SDP; synthesize a stream from
      // the bare track so we still have something to attach to the <audio>.
      const streams = event.streams.length > 0
        ? Array.from(event.streams)
        : [new MediaStream([event.track])];
      for (const stream of streams) {
        // Keep element only as a stream container for liveTrackCount checks.
        // muted=true prevents the remote audio from playing back through the
        // browser's virtual output device and looping into the fake microphone.
        const el = document.createElement('audio');
        el.muted = true;
        el.srcObject = stream;
        (el.dataset as DOMStringMap & { botCaptured: string }).botCaptured = 'true';
        el.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
        document.body.appendChild(el);

        const removeEl = () => {
          el.parentNode?.removeChild(el);
          setTimeout(checkAllPeersGone, 200);
        };
        // Listen for the track itself ending — fired immediately when a participant
        // leaves Teams (even via the relay). This is the fastest departure signal.
        event.track.addEventListener('ended', removeEl);
        // removetrack fires synchronously when the track is removed from the stream
        stream.addEventListener('removetrack', removeEl);
      }
    });

    // Also wrap the `pc.ontrack` property setter so a Teams handler assigned via
    // `pc.ontrack = ...` (instead of addEventListener) still goes through our
    // audio hook before being passed to Teams' own handler. Without this, some
    // Teams build branches replace our addEventListener-attached handler entirely.
    const origOnTrackDesc = Object.getOwnPropertyDescriptor(OrigRTC.prototype, 'ontrack');
    if (origOnTrackDesc?.set) {
      Object.defineProperty(pc, 'ontrack', {
        configurable: true,
        enumerable: true,
        get: origOnTrackDesc.get,
        set(handler: ((event: RTCTrackEvent) => void) | null) {
          if (typeof handler !== 'function') {
            return origOnTrackDesc.set!.call(this, handler);
          }
          // Our addEventListener handler still fires; Teams' handler runs after.
          return origOnTrackDesc.set!.call(this, handler);
        },
      });
    }

    return pc;
  }
  PatchedRTC.prototype = OrigRTC.prototype;
  // Inherit static methods (e.g. RTCPeerConnection.generateCertificate) so any
  // Teams code that calls them through the patched global hits the real impl.
  // Without this line, `RTCPeerConnection.generateCertificate(...)` is
  // `undefined(...)` → TypeError → Teams catches it, re-rejects as the
  // `{"isTrusted":true}` Event, and the call drops to "Leaving..." indefinitely.
  Object.setPrototypeOf(PatchedRTC, OrigRTC);
  win.RTCPeerConnection = PatchedRTC;
}
