import { Volume2 } from 'lucide-react';
import type { ProjectState } from '@/types/project';
import { dbToSegmentCount } from './meterUtils';

interface MixerMasterStripProps {
  project: ProjectState;
  masterPeakDb: number;
  autoMixBusy: boolean;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onUpdateProject: (updater: (prev: ProjectState) => ProjectState) => void;
  onAutoMix: () => void;
}

export default function MixerMasterStrip({
  project,
  masterPeakDb,
  autoMixBusy,
  onMutateWithUndo,
  onUpdateProject,
  onAutoMix,
}: MixerMasterStripProps) {
  return (
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
        <p className="text-[10px] tabular-nums text-slate-200">
          Ceiling: {project.mastering.limiter_ceiling_db} dBFS
        </p>
        <div className="pt-0.5">
          <label htmlFor="mixer-master-lufs" className="sr-only">
            Target Loudness LUFS
          </label>
          <select
            id="mixer-master-lufs"
            name="masterTargetLufs"
            value={String(project.mastering.target_lufs ?? -14)}
            onChange={(e) => {
              const nextLufs = Number(e.target.value);
              onMutateWithUndo((p) => ({
                ...p,
                mastering: { ...p.mastering, target_lufs: nextLufs },
              }));
            }}
            className="w-full rounded border border-emerald-400/25 bg-[#0b0d11] px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-200"
          >
            <option value="-9">-9 LUFS (Club / EDM)</option>
            <option value="-14">-14 LUFS (Streaming Chuẩn)</option>
            <option value="-16">-16 LUFS (Apple / Dynamic)</option>
          </select>
        </div>
      </div>

      <div className="my-1.5 flex items-center justify-center gap-3 rounded-md border border-emerald-500/20 bg-[#080a10] px-3 py-1.5">
        {[0, 1].map((ch) => (
          <div key={ch} className="flex h-[88px] flex-col-reverse justify-between gap-[1px]">
            {Array.from({ length: 12 }, (_, idx) => {
              const lit = idx < dbToSegmentCount(masterPeakDb, 12);
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
          <p>{masterPeakDb.toFixed(1)}</p>
          <p className="text-[9px] text-slate-300">dBFS</p>
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
          className="min-h-[24px] w-full rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {autoMixBusy ? 'Đang Mix...' : 'Chạy AI Auto-Mix'}
        </button>
      </div>
    </div>
  );
}
