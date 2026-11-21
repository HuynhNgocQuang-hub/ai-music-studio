import React, { useEffect, useMemo, useRef, useState } from 'react';

interface WaveformClipCanvasProps {
  peaks: number[] | null;
  seed?: string;
  color?: string;
  playedColor?: string;
  playProgress?: number; // 0..1
  fadeInRatio?: number; // 0..0.5
  fadeOutRatio?: number; // 0..0.5
  className?: string;
}

function generateFallbackPeaks(seed: string, count = 48): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const res: number[] = [];
  for (let i = 0; i < count; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const raw = ((h >>> 0) % 100) / 100;
    const env = Math.sin((i / Math.max(1, count - 1)) * Math.PI);
    res.push(Math.max(0.12, Math.min(0.88, (0.2 + raw * 0.72) * (0.45 + 0.55 * env))));
  }
  return res;
}

export default function WaveformClipCanvas({
  peaks,
  seed = 'clip',
  color = 'rgba(110, 231, 183, 0.72)',
  playedColor = 'rgba(34, 211, 238, 0.95)',
  playProgress,
  fadeInRatio = 0,
  fadeOutRatio = 0,
  className = '',
}: WaveformClipCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sizeTick, setSizeTick] = useState(0);
  const fallbackPeaks = useMemo(() => generateFallbackPeaks(seed, 56), [seed]);
  const hasRealPeaks = Boolean(peaks && peaks.length > 0);
  const effectivePeaks = hasRealPeaks ? (peaks as number[]) : fallbackPeaks;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setSizeTick((t) => t + 1);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const midY = height / 2;
    const barCount = effectivePeaks.length;
    const slotW = width / barCount;
    const barW = Math.max(1.2, slotW * 0.62);
    const maxHalfH = Math.max(2, height * 0.44);

    // Center zero-crossing reference line
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(0, midY - 0.5, width, 1);

    for (let i = 0; i < barCount; i++) {
      const ratio = i / Math.max(1, barCount);
      let amp = effectivePeaks[i];

      // Visually shape fade-in and fade-out envelope on the waveform bars
      if (fadeInRatio > 0 && ratio < fadeInRatio) {
        amp *= Math.max(0.08, ratio / fadeInRatio);
      }
      if (fadeOutRatio > 0 && ratio > 1 - fadeOutRatio) {
        amp *= Math.max(0.08, (1 - ratio) / fadeOutRatio);
      }

      const barH = Math.max(2 * dpr, amp * maxHalfH * 2);
      const x = i * slotW + (slotW - barW) / 2;
      const y = midY - barH / 2;

      const isPlayed = typeof playProgress === 'number' && ratio <= playProgress;
      ctx.fillStyle = isPlayed
        ? playedColor
        : hasRealPeaks
        ? color
        : color.includes('rgba(')
        ? color.replace(/0\.[0-9]+\)/, '0.32)')
        : 'rgba(148, 163, 184, 0.35)';
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 2));
      ctx.fill();
    }

    // Subtle fade slope shading triangles on left/right edges
    if (fadeInRatio > 0.005) {
      const fw = Math.min(width * 0.48, fadeInRatio * width);
      ctx.fillStyle = 'rgba(8, 10, 16, 0.45)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(fw, 0);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fill();
    }
    if (fadeOutRatio > 0.005) {
      const fw = Math.min(width * 0.48, fadeOutRatio * width);
      ctx.fillStyle = 'rgba(8, 10, 16, 0.45)';
      ctx.beginPath();
      ctx.moveTo(width, 0);
      ctx.lineTo(width - fw, 0);
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    }
  }, [effectivePeaks, hasRealPeaks, color, playedColor, playProgress, fadeInRatio, fadeOutRatio, sizeTick]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none block h-full w-full ${className}`}
      aria-hidden="true"
    />
  );
}
