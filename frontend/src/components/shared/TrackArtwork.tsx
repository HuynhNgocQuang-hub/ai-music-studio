import React from 'react';

const GENRE_THEMES: Record<
  string,
  { from: string; via: string; to: string; accent: string; badge: string }
> = {
  Pop: {
    from: '#5b21b6',
    via: '#c026d3',
    to: '#f43f5e',
    accent: '#f9a8d4',
    badge: 'bg-pink-500/15 text-pink-300',
  },
  Ballad: {
    from: '#1e1b4b',
    via: '#1d4ed8',
    to: '#0ea5e9',
    accent: '#93c5fd',
    badge: 'bg-sky-500/15 text-sky-300',
  },
  'Lo-fi': {
    from: '#451a03',
    via: '#b45309',
    to: '#d97706',
    accent: '#fde68a',
    badge: 'bg-amber-500/15 text-amber-300',
  },
  'R&B': {
    from: '#3b0764',
    via: '#7e22ce',
    to: '#db2777',
    accent: '#e9d5ff',
    badge: 'bg-purple-500/15 text-purple-300',
  },
  'Hip-hop': {
    from: '#450a0a',
    via: '#dc2626',
    to: '#ea580c',
    accent: '#fed7aa',
    badge: 'bg-rose-500/15 text-rose-300',
  },
  EDM: {
    from: '#083344',
    via: '#0284c7',
    to: '#10b981',
    accent: '#67e8f9',
    badge: 'bg-cyan-500/15 text-cyan-300',
  },
  Acoustic: {
    from: '#064e3b',
    via: '#0d9488',
    to: '#ca8a04',
    accent: '#a7f3d0',
    badge: 'bg-emerald-500/15 text-emerald-300',
  },
  Rock: {
    from: '#18181b',
    via: '#991b1b',
    to: '#dc2626',
    accent: '#fca5a5',
    badge: 'bg-red-500/15 text-red-300',
  },
};

export function getGenreTheme(genre?: string) {
  if (genre && GENRE_THEMES[genre]) return GENRE_THEMES[genre];
  return GENRE_THEMES.Pop;
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function TrackArtwork({
  title,
  genre = 'Pop',
  seed = 'default',
  size = 'md',
  isPlaying = false,
  className = '',
}: {
  title?: string;
  genre?: string;
  seed?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'full';
  isPlaying?: boolean;
  className?: string;
}) {
  const theme = getGenreTheme(genre);
  const h = hashSeed(`${seed}:${genre}:${title || ''}`);
  const variant = h % 6;
  const angle = 120 + (h % 60);
  const shiftX = 20 + ((h >> 3) % 60);
  const shiftY = 20 + ((h >> 7) % 60);

  const dims: Record<typeof size, string> = {
    xs: 'h-10 w-10 rounded-md',
    sm: 'h-12 w-12 rounded-md',
    md: 'h-14 w-14 rounded-lg',
    lg: 'h-28 w-28 rounded-xl',
    full: 'w-full aspect-square rounded-lg',
  };

  return (
    <div
      className={`relative shrink-0 overflow-hidden shadow-lg shadow-black/40 ${dims[size]} ${className}`}
      style={{
        background: `radial-gradient(circle at ${shiftX}% ${shiftY}%, ${theme.accent}44, transparent 58%), linear-gradient(${angle}deg, ${theme.from}, ${theme.via}, ${theme.to})`,
      }}
      aria-hidden="true"
    >
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 120 120" preserveAspectRatio="none">
        {variant === 0 && (
          <>
            <circle cx={shiftX} cy={shiftY} r="36" fill={theme.accent} fillOpacity="0.22" />
            <circle cx={shiftX} cy={shiftY} r="22" fill="#ffffff" fillOpacity="0.18" />
            <path d="M0 86 Q 35 62, 68 82 T 120 74 L 120 120 L 0 120 Z" fill="#000000" fillOpacity="0.32" />
            <path d="M0 98 Q 42 78, 84 96 T 120 90 L 120 120 L 0 120 Z" fill="#000000" fillOpacity="0.28" />
          </>
        )}
        {variant === 1 && (
          <>
            <circle cx="96" cy="26" r="46" fill="#ffffff" fillOpacity="0.14" />
            <circle cx="24" cy="94" r="50" fill="#000000" fillOpacity="0.28" />
            <rect
              x="16"
              y="18"
              width="54"
              height="54"
              rx="14"
              transform={`rotate(${(h % 25) - 12} 43 45)`}
              fill="none"
              stroke="#ffffff"
              strokeOpacity="0.26"
              strokeWidth="2.2"
            />
          </>
        )}
        {variant === 2 && (
          <>
            <polygon points="0,120 48,18 120,76 120,120" fill="#000000" fillOpacity="0.28" />
            <polygon points="18,0 120,0 78,84" fill="#ffffff" fillOpacity="0.15" />
            <line x1="0" y1="30" x2="120" y2="95" stroke={theme.accent} strokeOpacity="0.5" strokeWidth="1.5" />
          </>
        )}
        {variant === 3 && (
          <>
            {[46, 35, 24, 14].map((r, i) => (
              <circle
                key={r}
                cx="60"
                cy="60"
                r={r}
                fill="none"
                stroke="#ffffff"
                strokeOpacity={0.12 + i * 0.06}
                strokeWidth={i % 2 === 0 ? '1.8' : '1'}
                strokeDasharray={i === 1 ? '8 5' : undefined}
              />
            ))}
          </>
        )}
        {variant === 4 && (
          <>
            {[24, 42, 60, 78, 96].map((y, idx) => (
              <path
                key={y}
                d={`M -10 ${y} C 30 ${y - (idx % 2 ? 14 : -14)}, 80 ${y + (idx % 2 ? 14 : -14)}, 130 ${y}`}
                fill="none"
                stroke="#ffffff"
                strokeOpacity="0.24"
                strokeWidth="2"
              />
            ))}
          </>
        )}
        {variant === 5 && (
          <>
            {Array.from({ length: 7 }, (_, i) => {
              const barH = 26 + ((h >> (i * 3)) % 56);
              return (
                <rect
                  key={i}
                  x={14 + i * 14}
                  y={104 - barH}
                  width="8"
                  height={barH}
                  rx="4"
                  fill="#ffffff"
                  fillOpacity="0.24"
                />
              );
            })}
          </>
        )}
      </svg>

      {/* Subtle corner glass sheen & playing pulse dot */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-white/10" />
      {isPlaying && (
        <span className="absolute top-2 right-2 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#1ed760] opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#1ed760]" />
        </span>
      )}
    </div>
  );
}

export function MiniSoundBars({
  active = false,
  bars = 4,
  className = '',
}: {
  active?: boolean;
  bars?: number;
  className?: string;
}) {
  const heights = [0.45, 0.9, 0.65, 1.0, 0.55, 0.8];
  const delays = ['0ms', '150ms', '300ms', '90ms', '220ms', '380ms'];
  return (
    <span className={`inline-flex h-3.5 items-end gap-[2px] ${className}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, idx) => (
        <span
          key={idx}
          className={`w-[2.5px] rounded-full ${
            active ? 'eq-bar bg-[#1ed760]' : 'bg-zinc-500/60'
          }`}
          style={{
            height: `${Math.round(heights[idx % heights.length] * 100)}%`,
            animationDelay: active ? delays[idx % delays.length] : undefined,
          }}
        />
      ))}
    </span>
  );
}
