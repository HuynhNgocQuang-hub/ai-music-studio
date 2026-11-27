interface MixerFxBusPanelProps {
  fxBusUi: { reverbReturn: number; delayReturn: number; bypassed: boolean };
  syncDelayMs: number;
  vocalRev: number;
  leadRev: number;
  vocalDly: number;
  leadDly: number;
  onFxBusChange: (patch: Partial<{ reverbReturn: number; delayReturn: number; bypassed: boolean }>) => void;
}

export default function MixerFxBusPanel({
  fxBusUi,
  syncDelayMs,
  vocalRev,
  leadRev,
  vocalDly,
  leadDly,
  onFxBusChange,
}: MixerFxBusPanelProps) {
  return (
    <div className="flex min-w-[152px] flex-1 flex-col justify-between rounded-lg border border-sky-500/30 bg-gradient-to-b from-sky-500/10 to-[#16191f] p-2">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs font-bold text-sky-300">
          <span>FX BUS</span>
          <button
            type="button"
            onClick={() => onFxBusChange({ bypassed: !fxBusUi.bypassed })}
            className={`min-h-[24px] rounded px-2 py-0.5 font-mono text-[9px] font-bold transition ${
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
            className="min-h-[24px] w-full cursor-pointer accent-sky-400"
          />
          <p className="font-mono text-[8px] text-slate-300">
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
            className="min-h-[24px] w-full cursor-pointer accent-violet-400"
          />
          <p className="font-mono text-[8px] text-slate-300">
            1/8D {syncDelayMs}ms · V:{vocalDly}% L:{leadDly}%
          </p>
        </div>
      </div>

      <div className="space-y-1 pt-1">
        <p className="text-[9px] text-slate-300">
          Chỉnh Send trên Vocal / Lead; Export WAV kèm FX.
        </p>
        <button
          type="button"
          onClick={() => onFxBusChange({ reverbReturn: 1.0, delayReturn: 1.0, bypassed: false })}
          className="min-h-[24px] w-full rounded border border-white/10 bg-[#0b0d11] px-2 py-1 text-[10px] font-semibold text-slate-200 hover:bg-white/10 hover:text-white"
        >
          Mặc định FX Bus
        </button>
      </div>
    </div>
  );
}
