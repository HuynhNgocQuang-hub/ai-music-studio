import React, { useEffect, useMemo, useRef, useState } from 'react';

interface WaveformClipCanvasProps {
  peaks: number[] | null;
  seed?: string;
  color?: string;
  strokeColor?: string;
  playedColor?: string;
  playProgress?: number; // 0..1
  fadeInRatio?: number; // 0..0.5
  fadeOutRatio?: number; // 0..0.5
  className?: string;
}

function generateFallbackPeaks(seed: string, count = 240): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const res: number[] = [];
  let phraseEnv = 0.55;
  for (let i = 0; i < count; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const raw = ((h >>> 0) % 1000) / 1000;
    const t = i / Math.max(1, count - 1);
    if (i % 14 === 0) {
      phraseEnv = 0.35 + raw * 0.6;
    }
    const transient = i % 7 === 0 ? 0.28 : 0;
    const microRipple = Math.abs(Math.sin(t * Math.PI * 26 + (h % 9))) * 0.25;
    const edge = Math.sin(Math.min(1, t * 7) * (Math.PI / 2)) * Math.sin(Math.min(1, (1 - t) * 7) * (Math.PI / 2));
    const amp = (0.14 + raw * 0.56 + microRipple + transient) * phraseEnv * (0.35 + 0.65 * edge);
    res.push(Math.max(0.05, Math.min(0.95, amp)));
  }
  return res;
}

/** Smoothly resample peak array to dense pixel resolution for continuous polygon rendering. */
function resamplePeaks(src: number[], targetCount: number): number[] {
  if (src.length === 0) return [];
  if (src.length >= targetCount) return src;
  const out = new Array<number>(targetCount);
  const lastIdx = src.length - 1;
  for (let i = 0; i < targetCount; i++) {
    const pos = (i / Math.max(1, targetCount - 1)) * lastIdx;
    const lo = Math.floor(pos);
    const hi = Math.min(lastIdx, lo + 1);
    const frac = pos - lo;
    // Slight transient micro-modulation between coarse buckets so polygon retains natural crispness
    const base = src[lo] * (1 - frac) + src[hi] * frac;
    const ripple = (i % 2 === 0 ? 1 : 0.86);
    out[i] = Math.max(0.04, Math.min(0.96, base * ripple));
  }
  return out;
}

export default function WaveformClipCanvas({
  peaks,
  seed = 'clip',
  color = 'rgba(226, 232, 240, 0.88)',
  strokeColor = 'rgba(248, 250, 252, 0.96)',
  playedColor = 'rgba(74, 222, 128, 0.95)',
  playProgress,
  fadeInRatio = 0,
  fadeOutRatio = 0,
  className = '',
}: WaveformClipCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sizeTick, setSizeTick] = useState(0);
  const fallbackPeaks = useMemo(() => generateFallbackPeaks(seed, 240), [seed]);
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
    const maxHalfH = Math.max(3, height * 0.45);
    const desiredSamples = Math.max(48, Math.min(480, Math.round(rect.width / 1.4)));
    const densePeaks = resamplePeaks(effectivePeaks, desiredSamples);
    const n = densePeaks.length;
    if (n < 2) return;

    const upperY = new Float32Array(n);
    const lowerY = new Float32Array(n);
    const xCoords = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const ratio = i / (n - 1);
      let amp = densePeaks[i];
      if (fadeInRatio > 0 && ratio < fadeInRatio) {
        amp *= Math.max(0.05, ratio / fadeInRatio);
      }
      if (fadeOutRatio > 0 && ratio > 1 - fadeOutRatio) {
        amp *= Math.max(0.05, (1 - ratio) / fadeOutRatio);
      }
      const half = Math.max(dpr * 0.75, amp * maxHalfH);
      xCoords[i] = ratio * width;
      upperY[i] = midY - half;
      lowerY[i] = midY + half;
    }

    const traceWaveformPath = () => {
      ctx.beginPath();
      ctx.moveTo(xCoords[0], upperY[0]);
      for (let i = 1; i < n; i++) {
        ctx.lineTo(xCoords[i], upperY[i]);
      }
      for (let i = n - 1; i >= 0; i--) {
        ctx.lineTo(xCoords[i], lowerY[i]);
      }
      ctx.closePath();
    };

    // Crisp zero-crossing axis across full clip width
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(0, midY - 0.5, width, Math.max(1, dpr * 0.6));

    // Base continuous symmetric filled polygon
    traceWaveformPath();
    ctx.fillStyle = hasRealPeaks
      ? color
      : color.includes('rgba(')
      ? color.replace(/0\.[0-9]+\)/, '0.46)')
      : 'rgba(226, 232, 240, 0.46)';
    ctx.fill();

    // Subtle crisp crest stroke top & bottom (FL Audio Clip silhouette look)
    ctx.lineWidth = Math.max(1, dpr * 0.7);
    ctx.strokeStyle = hasRealPeaks ? strokeColor : 'rgba(248, 250, 252, 0.45)';
    ctx.beginPath();
    ctx.moveTo(xCoords[0], upperY[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(xCoords[i], upperY[i]);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(xCoords[0], lowerY[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(xCoords[i], lowerY[i]);
    ctx.stroke();

    // Active playback sweep clipped strictly to the polygon shape
    if (typeof playProgress === 'number' && playProgress > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, Math.min(width, playProgress * width), height);
      ctx.clip();
      traceWaveformPath();
      ctx.fillStyle = playedColor;
      ctx.fill();
      ctx.restore();
    }

    // Diagonal FL-style fade-in / fade-out envelope curve guides
    if (fadeInRatio > 0.008) {
      const fw = Math.min(width * 0.48, fadeInRatio * width);
      ctx.fillStyle = 'rgba(9, 13, 22, 0.42)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(fw, 0);
      ctx.quadraticCurveTo(fw * 0.35, height * 0.35, 0, height);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = Math.max(1, dpr * 0.75);
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.quadraticCurveTo(fw * 0.35, height * 0.35, fw, 0);
      ctx.stroke();
    }
    if (fadeOutRatio > 0.008) {
      const fw = Math.min(width * 0.48, fadeOutRatio * width);
      ctx.fillStyle = 'rgba(9, 13, 22, 0.42)';
      ctx.beginPath();
      ctx.moveTo(width, 0);
      ctx.lineTo(width - fw, 0);
      ctx.quadraticCurveTo(width - fw * 0.35, height * 0.35, width, height);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = Math.max(1, dpr * 0.75);
      ctx.beginPath();
      ctx.moveTo(width - fw, 0);
      ctx.quadraticCurveTo(width - fw * 0.35, height * 0.35, width, height);
      ctx.stroke();
    }
  }, [effectivePeaks, hasRealPeaks, color, strokeColor, playedColor, playProgress, fadeInRatio, fadeOutRatio, sizeTick]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 block h-full w-full ${className}`}
      aria-hidden="true"
    />
  );
}
