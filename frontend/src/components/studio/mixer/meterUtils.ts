export const CHANNEL_ACCENT: Record<string, string> = {
  vocal: 'bg-emerald-400',
  texture: 'bg-cyan-400',
  drums: 'bg-amber-400',
  bass: 'bg-violet-400',
  harmony: 'bg-indigo-400',
  lead: 'bg-sky-400',
};

export function dbToSegmentCount(db: number, total = 12): number {
  if (!Number.isFinite(db) || db <= -58) return 0;
  const clamped = Math.max(-54, Math.min(0, db));
  return Math.round(((clamped + 54) / 54) * total);
}
