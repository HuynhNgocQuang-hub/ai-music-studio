import type { AudioTrackState, MidiTrackState, ProjectState } from '@/types/project';
import { CHANNEL_ACCENT, dbToSegmentCount } from './meterUtils';

type ChannelTrack = AudioTrackState | MidiTrackState;

interface MixerChannelStripProps {
  trackId: string;
  track: ChannelTrack;
  instruments: string[];
  channelPeakDb: number;
  isPlaying: boolean;
  onToggleTrackFlag: (trackId: string, field: 'mute' | 'solo') => void;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onChannelEq: (
    trackId: string,
    eqPatch: { lowDb?: number; midDb?: number; highDb?: number },
    withUndo?: boolean
  ) => void;
  onChannelSend: (
    trackId: string,
    sendPatch: { reverbSend?: number; delaySend?: number },
    withUndo?: boolean
  ) => void;
  onTrackVolumePan: (trackId: string, field: 'volume' | 'pan', value: number) => void;
}

export default function MixerChannelStrip({
  trackId,
  track,
  instruments,
  channelPeakDb,
  isPlaying,
  onToggleTrackFlag,
  onMutateWithUndo,
  onChannelEq,
  onChannelSend,
  onTrackVolumePan,
}: MixerChannelStripProps) {
  const volPct = Math.round((track.volume ?? 0.85) * 100);
  const panVal = Math.round((track.pan ?? 0) * 100);
  const approxDb = volPct <= 0 ? '-∞ dB' : `${(20 * Math.log10(volPct / 100)).toFixed(1)} dB`;
  const litSegments = track.mute || !isPlaying ? 0 : dbToSegmentCount(channelPeakDb, 12);
  const stripAccent = CHANNEL_ACCENT[trackId] || 'bg-indigo-400';
  const eq = {
    lowDb: Math.round(track.low_db ?? 0),
    midDb: Math.round(track.mid_db ?? 0),
    highDb: Math.round(track.high_db ?? 0),
  };
  const hasEqChange = eq.lowDb !== 0 || eq.midDb !== 0 || eq.highDb !== 0;
  const supportsSendFx = trackId === 'vocal' || trackId === 'lead';
  const revPct = Math.round((track.reverb_send ?? 0) * 100);
  const dlyPct = Math.round((track.delay_send ?? 0) * 100);
  const hasSendChange = revPct > 0 || dlyPct > 0;

  return (
    <div className="flex min-w-[138px] flex-1 flex-col justify-between rounded-lg border border-white/10 bg-[#1b1e25] p-2">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${stripAccent}`} />
            <span className="truncate text-[10px] font-bold uppercase tracking-wide text-white">
              {trackId}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onToggleTrackFlag(trackId, 'mute')}
              aria-label={`Mute ${trackId}`}
              aria-pressed={track.mute}
              className={`inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold ${
                track.mute ? 'bg-rose-500 text-white' : 'bg-white/10 text-slate-300'
              }`}
            >
              M
            </button>
            <button
              type="button"
              onClick={() => onToggleTrackFlag(trackId, 'solo')}
              aria-label={`Solo ${trackId}`}
              aria-pressed={track.solo}
              className={`inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold ${
                track.solo ? 'bg-amber-400 text-slate-950' : 'bg-white/10 text-slate-300'
              }`}
            >
              S
            </button>
          </div>
        </div>

        {track.type === 'midi' ? (
          <select
            id={`mixer-inst-${trackId}`}
            name={`mixerInstrument_${trackId}`}
            aria-label={`Nhạc cụ ${trackId}`}
            value={track.instrument || ''}
            onChange={(e) => {
              const nextInstrument = e.target.value;
              onMutateWithUndo((p) => {
                const currentTrack = p.tracks[trackId];
                if (!currentTrack || currentTrack.type !== 'midi') return p;
                return {
                  ...p,
                  tracks: {
                    ...p.tracks,
                    [trackId]: { ...currentTrack, instrument: nextInstrument },
                  },
                };
              });
            }}
            className="w-full rounded border border-white/10 bg-[#0b0d11] px-1.5 py-0.5 text-[10px] text-slate-200"
          >
            {instruments.map((inst) => (
              <option key={inst} value={inst}>
                {inst}
              </option>
            ))}
          </select>
        ) : (
          <div className="rounded bg-[#0b0d11]/70 px-1.5 py-0.5 text-center text-[10px] text-slate-300">
            Audio Bus
          </div>
        )}

        {/* Persisted 3-Band Channel EQ (-12..+12 dB) */}
        <div className="space-y-0.5 rounded border border-white/[0.06] bg-[#0b0d11]/85 px-1.5 py-1">
          <div className="flex min-h-[16px] items-center justify-between text-[8px] font-bold uppercase tracking-wider text-slate-300">
            <span>EQ</span>
            {hasEqChange && (
              <button
                type="button"
                onClick={() => onChannelEq(trackId, { lowDb: 0, midDb: 0, highDb: 0 }, true)}
                className="min-h-[24px] px-1 text-[9px] text-amber-300 hover:text-amber-200"
              >
                Reset
              </button>
            )}
          </div>
          {(['lowDb', 'midDb', 'highDb'] as const).map((band) => {
            const bandLabel = band === 'lowDb' ? 'L' : band === 'midDb' ? 'M' : 'H';
            const bandVal = eq[band];
            return (
              <div key={band} className="flex items-center gap-1 font-mono text-[8px]">
                <span className="w-2.5 text-slate-300">{bandLabel}</span>
                <input
                  id={`mixer-eq-${band}-${trackId}`}
                  name={`mixerEq_${band}_${trackId}`}
                  aria-label={`${bandLabel} EQ ${trackId}`}
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={bandVal}
                  onChange={(e) => onChannelEq(trackId, { [band]: Number(e.target.value) })}
                  className="min-h-[24px] flex-1 cursor-pointer accent-amber-400"
                />
                <span className="w-5 text-right tabular-nums text-slate-300">
                  {bandVal > 0 ? `+${bandVal}` : bandVal}
                </span>
              </div>
            );
          })}
        </div>

        {/* Dedicated Send FX Bus Controls (Reverb / Delay) for Vocal & Lead */}
        {supportsSendFx && (
          <div className="space-y-0.5 rounded border border-sky-500/20 bg-sky-950/20 px-1.5 py-1">
            <div className="flex min-h-[16px] items-center justify-between text-[8px] font-bold uppercase tracking-wider text-sky-300">
              <span>FX SEND</span>
              {hasSendChange && (
                <button
                  type="button"
                  onClick={() => onChannelSend(trackId, { reverbSend: 0, delaySend: 0 }, true)}
                  className="min-h-[24px] px-1 text-[9px] text-amber-300 hover:text-amber-200"
                >
                  Reset
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 font-mono text-[8px]">
              <span className="w-5 text-sky-300">REV</span>
              <input
                id={`mixer-send-reverb-${trackId}`}
                name={`mixerReverbSend_${trackId}`}
                aria-label={`Reverb Send ${trackId}`}
                type="range"
                min={0}
                max={100}
                step={1}
                value={revPct}
                onChange={(e) =>
                  onChannelSend(trackId, { reverbSend: Number(e.target.value) / 100 })
                }
                className="min-h-[24px] flex-1 cursor-pointer accent-sky-400"
              />
              <span className="w-6 text-right tabular-nums text-slate-300">{revPct}%</span>
            </div>
            <div className="flex items-center gap-1 font-mono text-[8px]">
              <span className="w-5 text-violet-300">DLY</span>
              <input
                id={`mixer-send-delay-${trackId}`}
                name={`mixerDelaySend_${trackId}`}
                aria-label={`Delay Send ${trackId}`}
                type="range"
                min={0}
                max={100}
                step={1}
                value={dlyPct}
                onChange={(e) =>
                  onChannelSend(trackId, { delaySend: Number(e.target.value) / 100 })
                }
                className="min-h-[24px] flex-1 cursor-pointer accent-violet-400"
              />
              <span className="w-6 text-right tabular-nums text-slate-300">{dlyPct}%</span>
            </div>
          </div>
        )}

        {/* Pan Control */}
        <div className="space-y-0.5">
          <div className="flex items-center justify-between font-mono text-[9px] text-slate-300">
            <span>PAN</span>
            <span className="text-slate-100">
              {panVal === 0 ? 'CENTER' : panVal < 0 ? `${Math.abs(panVal)}L` : `${panVal}R`}
            </span>
          </div>
          <input
            id={`mixer-pan-${trackId}`}
            name={`mixerPan_${trackId}`}
            aria-label={`Pan ${trackId}`}
            type="range"
            min={-100}
            max={100}
            value={panVal}
            onChange={(e) => onTrackVolumePan(trackId, 'pan', Number(e.target.value) / 100)}
            className="min-h-[24px] w-full cursor-pointer accent-cyan-400"
          />
        </div>
      </div>

      {/* Vertical Fader + dB Scale + Real-Time VU Meter */}
      <div className="my-1 flex items-center justify-center gap-2 rounded-md border border-white/[0.06] bg-[#0a0c14] px-2 py-1">
        <div className="flex h-[60px] flex-col justify-between font-mono text-[8px] text-slate-300">
          <span>+2</span>
          <span>0</span>
          <span>-6</span>
          <span>-18</span>
          <span>-∞</span>
        </div>

        <input
          id={`mixer-vol-${trackId}`}
          name={`mixerVolume_${trackId}`}
          aria-label={`Volume fader ${trackId}`}
          type="range"
          min={0}
          max={120}
          value={volPct}
          onChange={(e) => onTrackVolumePan(trackId, 'volume', Number(e.target.value) / 100)}
          className="daw-fader"
        />

        <div
          className="flex h-[60px] flex-col-reverse justify-between gap-[1px] rounded bg-black/50 p-1"
          title={isPlaying ? `${channelPeakDb.toFixed(1)} dBFS` : 'Idle'}
        >
          {Array.from({ length: 12 }, (_, idx) => {
            const lit = idx < litSegments;
            const segCls =
              idx >= 10
                ? 'bg-rose-500 shadow-[0_0_5px_rgba(244,63,94,0.8)]'
                : idx >= 7
                  ? 'bg-amber-400'
                  : 'bg-emerald-400';
            return (
              <span
                key={idx}
                className={`h-1 w-2.5 rounded-[1px] transition-colors duration-75 ${
                  lit ? segCls : 'bg-white/[0.08]'
                }`}
              />
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between rounded bg-[#0b0d11] px-2 py-0.5 font-mono text-[10px] tabular-nums">
        <span className="text-amber-300">{volPct}%</span>
        <span className="text-slate-300">{approxDb}</span>
      </div>
    </div>
  );
}
