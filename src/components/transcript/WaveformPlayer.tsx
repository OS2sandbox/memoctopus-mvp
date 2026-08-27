'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';

interface WaveformPlayerProps {
  audioUrl: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}

const NUM_BARS = 130;
const BAR_FILL = 0.68; // bar width as fraction of slot width

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

export function WaveformPlayer({
  audioUrl,
  currentTime,
  duration,
  isPlaying,
  onTogglePlay,
  onSeek,
}: WaveformPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [waveform, setWaveform] = useState<Float32Array | null>(null);

  // Fetch and decode audio to compute amplitude bars
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(audioUrl);
        if (!res.ok || cancelled) return;
        const arrayBuf = await res.arrayBuffer();
        if (cancelled) return;

        const actx = new AudioContext();
        const audioBuf = await actx.decodeAudioData(arrayBuf);
        actx.close();
        if (cancelled) return;

        const samples = audioBuf.getChannelData(0);
        const spp = Math.max(1, Math.floor(samples.length / NUM_BARS));
        const data = new Float32Array(NUM_BARS);

        for (let i = 0; i < NUM_BARS; i++) {
          const start = i * spp;
          const end = Math.min(start + spp, samples.length);
          let rms = 0;
          for (let j = start; j < end; j++) rms += samples[j] * samples[j];
          data[i] = Math.sqrt(rms / (end - start));
        }

        let peak = 0;
        for (let i = 0; i < NUM_BARS; i++) if (data[i] > peak) peak = data[i];
        if (peak > 0) for (let i = 0; i < NUM_BARS; i++) data[i] /= peak;

        setWaveform(data);
      } catch {
        // waveform stays null — canvas shows skeleton bars
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [audioUrl]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const logW = canvas.offsetWidth;
    const logH = canvas.offsetHeight;
    const W = logW * dpr;
    const H = logH * dpr;

    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, W, 0);
    bg.addColorStop(0, '#3a2040');
    bg.addColorStop(0.5, '#5a3050');
    bg.addColorStop(1, '#3a2040');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;
    const playedX = progress * W;

    const slotW = W / NUM_BARS;
    const barW = slotW * BAR_FILL;
    const gapW = slotW * (1 - BAR_FILL);
    const minH = H * 0.04;
    const maxH = H * 0.88;
    const radius = Math.min(barW / 2, 2.5 * dpr);

    for (let i = 0; i < NUM_BARS; i++) {
      const amplitude = waveform ? waveform[i] : 0.18 + (i % 3) * 0.06; // skeleton pattern
      const barH = Math.max(amplitude * maxH, minH);
      const x = i * slotW + gapW / 2;
      const y = (H - barH) / 2;

      const barCenter = x + barW / 2;
      const isPlayed = barCenter <= playedX;

      ctx.fillStyle = isPlayed ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.28)';
      drawRoundRect(ctx, x, y, barW, barH, radius);
      ctx.fill();
    }

    // Playback cursor line
    if (progress > 0 && progress < 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.70)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(playedX, H * 0.08);
      ctx.lineTo(playedX, H * 0.92);
      ctx.stroke();
    }
  }, [waveform, currentTime, duration]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Redraw on resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  }

  function fmt(secs: number) {
    if (!isFinite(secs) || isNaN(secs) || secs <= 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  return (
    <div className="mb-6 relative rounded-[var(--radius)] overflow-hidden" style={{ height: 80 }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'pointer' }}
        onClick={handleClick}
      />

      {/* Play/pause button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onTogglePlay();
        }}
        style={{
          position: 'absolute',
          left: 10,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.16)',
          border: '1.5px solid rgba(255,255,255,0.55)',
          color: 'white',
          cursor: 'pointer',
          fontSize: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        title={isPlaying ? 'Pause' : 'Afspil'}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>

      {/* Duration stamp */}
      <div
        style={{
          position: 'absolute',
          bottom: 6,
          right: 7,
          background: 'rgba(0,0,0,0.40)',
          color: 'rgba(255,255,255,0.88)',
          borderRadius: 3,
          padding: '1px 5px',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11,
          fontWeight: 500,
          lineHeight: '17px',
          pointerEvents: 'none',
        }}
      >
        {fmt(duration)}
      </div>
    </div>
  );
}
