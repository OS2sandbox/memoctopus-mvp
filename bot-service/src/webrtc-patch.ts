// Injected into every page via addInitScript before any Teams JS loads.
// Must be self-contained — no imports, no closures over Node.js variables.
export function installWebRTCPatch(): void {
  const OrigRTC = window.RTCPeerConnection;

  // Set of RTCPeerConnections that have carried at least one audio track.
  const audioPcs = new Set<RTCPeerConnection>();
  // Exposed to Node.js so _pollParticipants can call getStats() on each PC.
  const audioPcsList: RTCPeerConnection[] = [];
  (window as unknown as Record<string, unknown>).__botAudioPcs = audioPcsList;
  let hadAudioPeer = false;

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
    const cb = (window as unknown as Record<string, unknown>).__botAllPeersLeft as (() => void) | undefined;
    if (cb) cb();
  };

  // Redirect video addTrack/addTransceiver calls to throw-away PeerConnections so
  // the meeting PC stays audio-only.  Chrome's fake device assigns conflicting RTP
  // header extension id=11 values to the audio and video m-sections in a BUNDLE
  // group; with video absent from the real PC the offer contains only one m-section
  // and the collision cannot occur.  Teams receives real RTCRtpSender /
  // RTCRtpTransceiver objects (from the throw-away PC) so its internal video-sender
  // bookkeeping is satisfied without crashing.
  const throwawayPCMap = new WeakMap<RTCPeerConnection, RTCPeerConnection>();
  const getThrowawayPC = (pc: RTCPeerConnection): RTCPeerConnection => {
    let t = throwawayPCMap.get(pc);
    if (!t) { t = new OrigRTC(); throwawayPCMap.set(pc, t); }
    return t;
  };
  const _origAddTrack = OrigRTC.prototype.addTrack;
  OrigRTC.prototype.addTrack = function(
    this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]
  ): RTCRtpSender {
    if (track?.kind === 'video') {
      console.log('[webrtc-patch] addTrack(video) → throw-away PC (avoiding BUNDLE id=11 collision)');
      return _origAddTrack.call(getThrowawayPC(this), track, ...streams);
    }
    return _origAddTrack.call(this, track, ...streams);
  };
  // Some Teams versions use addTransceiver instead of addTrack for video setup.
  const _origAddTransceiver = OrigRTC.prototype.addTransceiver as (
    trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit
  ) => RTCRtpTransceiver;
  (OrigRTC.prototype as unknown as {
    addTransceiver: (t: MediaStreamTrack | string, i?: RTCRtpTransceiverInit) => RTCRtpTransceiver
  }).addTransceiver = function(
    this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit
  ): RTCRtpTransceiver {
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind?.kind;
    if (kind === 'video') {
      console.log('[webrtc-patch] addTransceiver(video) → throw-away PC');
      return _origAddTransceiver.call(getThrowawayPC(this), trackOrKind, init as RTCRtpTransceiverInit);
    }
    return _origAddTransceiver.call(this, trackOrKind, init as RTCRtpTransceiverInit);
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
}
