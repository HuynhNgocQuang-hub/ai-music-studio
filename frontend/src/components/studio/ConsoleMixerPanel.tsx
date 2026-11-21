import { Volume2 } from 'lucide-react';
import type { TransportSnapshot } from '@/lib/audio/player';
import type { ProjectState } from '@/types/project';

const CHANNEL_ACCENT: Record<string, string> = {
  vocal: 'bg-emerald-400',
  texture: 'bg-cyan-400',
  drums: 'bg-amber-400',
  bass: 'bg-violet-400',
  harmony: 'bg-indigo-400',
  lead: 'bg-sky-400',
};

function dbToSegmentCount(db: number, total = 12): number {
  if (!Number.isFinite(db) || db <= -58) return 0;
  const clamped = Math.max(-54, Math.min(0, db));
  return Math.round(((clamped + 54) / 54) * total);
}

interface ConsoleMixerPanelProps {
  project: ProjectState;
  trackKeys: string[];
  instruments: Record<string, string[]>;
  transport: TransportSnapshot;
  fxBusUi: { reverbReturn: number; delayReturn: number; bypassed: boolean };
  autoMixBusy: boolean;
  onToggleTrackFlag: (trackId: string, field: 'mute' | 'solo') => void;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onUpdateProject: (updater: (prev: ProjectState) => ProjectState) => void;
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
  onFxBusChange: (patch: Partial<{ reverbReturn: number; delayReturn: number; bypassed: boolean }>) => void;
  onAutoMix: () => void;
}

export default function ConsoleMixerPanel({
  project,
  trackKeys,
  instruments,
  transport,
  fxBusUi,
  autoMixBusy,
  onToggleTrackFlag,
  onMutateWithUndo,
  onUpdateProject,
  onChannelEq,
  onChannelSend,
  onTrackVolumePan,
  onFxBusChange,
  onAutoMix,
}: ConsoleMixerPanelProps) {
  const syncDelayMs = Math.round(
    Math.max(0.12, Math.min(0.75, 0.75 * (60 / Math.max(40, transport.bpm || 100)))) * 1000
  );
  const vocalRev = Math.round((project.tracks.vocal?.reverb_send ?? 0) * 100);
  const leadRev = Math.round((project.tracks.lead?.reverb_send ?? 0) * 100);
  const vocalDly = Math.round((project.tracks.vocal?.delay_send ?? 0) * 100);
  const leadDly = Math.round((project.tracks.lead?.delay_send ?? 0) * 100);

  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1">
      {trackKeys.map((trackId) => {
        const track = project.tracks[trackId];
        if (!track) return null;
        const volPct = Math.round((track.volume ?? 0.85) * 100);
        const panVal = Math.round((track.pan ?? 0) * 100);
        const approxDb =
          volPct <= 0 ? '-∞ dB' : `${(20 * Math.log10(volPct / 100)).toFixed(1)} dB`;
        const chanDb = transport.channelPeakDb?.[trackId] ?? -60;
        const litSegments = track.mute || !transport.isPlaying ? 0 : dbToSegmentCount(chanDb, 12);
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
          <div
            key={trackId}
            className="flex min-w-[138px] flex-1 flex-col justify-between rounded-lg border border-white/10 bg-[#1b1e25] p-2"
          >
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${stripAccent}`} />
                  <span className="truncate text-[10px] font-bold uppercase tracking-wide text-white">
                    {trackId}
                  </span>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => onToggleTrackFlag(trackId, 'mute')}
                    className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                      track.mute ? 'bg-rose-500 text-white' : 'bg-white/10 text-slate-400'
                    }`}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleTrackFlag(trackId, 'solo')}
                    className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                      track.solo ? 'bg-amber-400 text-slate-950' : 'bg-white/10 text-slate-400'
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
                  onChange={(e) =>
                    onMutateWithUndo((p) => ({
                      ...p,
                      tracks: {
                        ...p.tracks,
                        [trackId]: { ...track, instrument: e.target.value },
                      },
                    }))
                  }
                  className="w-full rounded border border-white/10 bg-[#0b0d11] px-1.5 py-0.5 text-[10px] text-slate-200"
                >
                  {(instruments[trackId] || (track.instrument ? [track.instrument] : [])).map(
                    (inst) => (
                      <option key={inst} value={inst}>
                        {inst}
                      </option>
                    )
                  )}
                </select>
              ) : (
                <div className="rounded bg-[#0b0d11]/70 px-1.5 py-0.5 text-center text-[10px] text-slate-400">
                  Audio Bus
                </div>
              )}

              {/* Persisted 3-Band Channel EQ (-12..+12 dB) */}
              <div className="space-y-0.5 rounded border border-white/[0.06] bg-[#0b0d11]/85 px-1.5 py-1">
                <div className="flex h-3 items-center justify-between text-[8px] font-bold uppercase tracking-wider text-slate-400">
                  <span>EQ</span>
                  {hasEqChange && (
                    <button
                      type="button"
                      onClick={() => onChannelEq(trackId, { lowDb: 0, midDb: 0, highDb: 0 }, true)}
                      className="text-amber-400 hover:text-amber-300"
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
                      <span className="w-2.5 text-slate-500">{bandLabel}</span>
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
                        className="h-1 flex-1 accent-amber-400"
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
                  <div className="flex h-3 items-center justify-between text-[8px] font-bold uppercase tracking-wider text-sky-300">
                    <span>FX SEND</span>
                    {hasSendChange && (
                      <button
                        type="button"
                        onClick={() =>
                          onChannelSend(trackId, { reverbSend: 0, delaySend: 0 }, true)
                        }
                        className="text-amber-400 hover:text-amber-300"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1 font-mono text-[8px]">
                    <span className="w-5 text-sky-400">REV</span>
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
                      className="h-1 flex-1 accent-sky-400"
                    />
                    <span className="w-6 text-right tabular-nums text-slate-300">{revPct}%</span>
                  </div>
                  <div className="flex items-center gap-1 font-mono text-[8px]">
                    <span className="w-5 text-violet-400">DLY</span>
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
                      className="h-1 flex-1 accent-violet-400"
                    />
                    <span className="w-6 text-right tabular-nums text-slate-300">{dlyPct}%</span>
                  </div>
                </div>
              )}

              {/* Pan Control */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between font-mono text-[9px] text-slate-400">
                  <span>PAN</span>
                  <span className="text-slate-200">
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
                  className="w-full accent-cyan-400"
                />
              </div>
            </div>

            {/* Vertical Fader + dB Scale + Real-Time VU Meter */}
            <div className="my-1 flex items-center justify-center gap-2 rounded-md border border-white/[0.06] bg-[#0a0c14] px-2 py-1">
              <div className="flex h-[60px] flex-col justify-between font-mono text-[8px] text-slate-500">
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
                title={transport.isPlaying ? `${chanDb.toFixed(1)} dBFS` : 'Idle'}
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
              <span className="text-slate-400">{approxDb}</span>
            </div>
          </div>
        );
      })}

      {/* Send FX Return Bus Strip (Bus A Reverb + Bus B Sync Delay) */}
      <div className="flex min-w-[152px] flex-1 flex-col justify-between rounded-lg border border-sky-500/30 bg-gradient-to-b from-sky-500/10 to-[#16191f] p-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-bold text-sky-300">
            <span>FX BUS</span>
            <button
              type="button"
              onClick={() => onFxBusChange({ bypassed: !fxBusUi.bypassed })}
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold transition ${
                fxBusUi.bypassed
                  ? 'bg-rose-500 text-white'
                  : 'bg-sky-500/20 text-sky-200 hover:bg-sky-500/30'
              }`}
            >
              {fxBusUi.bypassed ? 'BYPASSED' : 'ACTIVE'}
            </button>
          </div>

          <div className="space-y-1 rounded border border-sky-500/20 bg-[#0b0d11]/90 p-1.5">
            <div className="flex items-center justify-between text-[9px] font-bold text-sky-300">
              <span>BUS A · REVERB</span>
              <span className="font-mono text-slate-300">
                {Math.round(fxBusUi.reverbReturn * 100)}%
              </span>
            </div>
            <input
              id="fx-bus-reverb-return"
              name="fxBusReverbReturn"
              aria-label="Reverb Return Level"
              type="range"
              min={0}
              max={120}
              value={Math.round(fxBusUi.reverbReturn * 100)}
              onChange={(e) => onFxBusChange({ reverbReturn: Number(e.target.value) / 100 })}
              className="h-1 w-full accent-sky-400"
            />
            <p className="font-mono text-[8px] text-slate-400">
              Hall 1.45s · V:{vocalRev}% L:{leadRev}%
            </p>
          </div>

          <div className="space-y-1 rounded border border-violet-500/20 bg-[#0b0d11]/90 p-1.5">
            <div className="flex items-center justify-between text-[9px] font-bold text-violet-300">
              <span>BUS B · DELAY</span>
              <span className="font-mono text-slate-300">
                {Math.round(fxBusUi.delayReturn * 100)}%
              </span>
            </div>
            <input
              id="fx-bus-delay-return"
              name="fxBusDelayReturn"
              aria-label="Delay Return Level"
              type="range"
              min={0}
              max={120}
              value={Math.round(fxBusUi.delayReturn * 100)}
              onChange={(e) => onFxBusChange({ delayReturn: Number(e.target.value) / 100 })}
              className="h-1 w-full accent-violet-400"
            />
            <p className="font-mono text-[8px] text-slate-400">
              1/8D {syncDelayMs}ms · V:{vocalDly}% L:{leadDly}%
            </p>
          </div>
        </div>

        <div className="space-y-1 pt-1">
          <p className="text-[9px] text-slate-400">
            Chỉnh Send trên Vocal / Lead; Export WAV kèm FX.
          </p>
          <button
            type="button"
            onClick={() => onFxBusChange({ reverbReturn: 1.0, delayReturn: 1.0, bypassed: false })}
            className="w-full rounded border border-white/10 bg-[#0b0d11] px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-white/10 hover:text-white"
          >
            Mặc định FX Bus
          </button>
        </div>
      </div>

      {/* Master Bus Console Channel Strip */}
      <div className="flex min-w-[144px] flex-1 flex-col justify-between rounded-lg border border-emerald-500/35 bg-gradient-to-b from-emerald-500/15 to-[#16191f] p-2">
        <div className="space-y-0.5">
          <div className="flex items-center justify-between text-xs font-bold text-emerald-300">
            <span className="flex items-center gap-1.5">
              <Volume2 className="h-3.5 w-3.5" /> MASTER
            </span>
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px]">
              LIMIT
            </span>
          </div>
          <p className="text-[10px] text-slate-300 tabular-nums">
            Ceiling: {project.mastering.limiter_ceiling_db} dBFS
          </p>
        </div>

        <div className="my-1.5 flex items-center justify-center gap-3 rounded-md border border-emerald-500/20 bg-[#080a10] px-3 py-1.5">
          {[0, 1].map((ch) => (
            <div key={ch} className="flex h-[88px] flex-col-reverse justify-between gap-[1px]">
              {Array.from({ length: 12 }, (_, idx) => {
                const lit = idx < dbToSegmentCount(transport.masterPeakDb, 12);
                const segCls =
                  idx >= 10
                    ? 'bg-rose-500'
                    : idx >= 7
                      ? 'bg-amber-400'
                      : 'bg-emerald-400';
                return (
                  <span
                    key={idx}
                    className={`h-1 w-3 rounded-[1px] transition-colors duration-75 ${
                      lit ? segCls : 'bg-white/[0.08]'
                    }`}
                  />
                );
              })}
            </div>
          ))}
          <div className="font-mono text-[10px] tabular-nums text-emerald-200">
            <p className="font-bold">PEAK</p>
            <p>{transport.masterPeakDb.toFixed(1)}</p>
            <p className="text-[9px] text-slate-400">dBFS</p>
          </div>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="studio-automix-checkbox"
            className="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-200"
          >
            <input
              id="studio-automix-checkbox"
              name="autoMixEnabled"
              type="checkbox"
              checked={project.mastering.auto_mix_enabled}
              onChange={(e) =>
                onUpdateProject((p) => ({
                  ...p,
                  mastering: { ...p.mastering, auto_mix_enabled: e.target.checked },
                }))
              }
              className="accent-emerald-400"
            />
            <span>Anti-Clip Limiter</span>
          </label>
          <button
            type="button"
            disabled={autoMixBusy}
            onClick={onAutoMix}
            className="w-full rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {autoMixBusy ? 'Đang Mix...' : 'Chạy AI Auto-Mix'}
          </button>
        </div>
      </div>
    </div>
  );
}
