import React, { useState } from 'react';
import { RotateCcw, Save, Trash2 } from 'lucide-react';
import type { ProjectVersionSummary } from '@/types/project';

interface CollabVersionsTabProps {
  versions: ProjectVersionSummary[];
  versionsBusy: boolean;
  isRoomOwner: boolean;
  onSaveCheckpoint: (label?: string) => Promise<unknown>;
  onRestoreCheckpoint: (versionId: string) => Promise<unknown>;
  onDeleteCheckpoint: (versionId: string) => Promise<void>;
}

export default function CollabVersionsTab({
  versions,
  versionsBusy,
  isRoomOwner,
  onSaveCheckpoint,
  onRestoreCheckpoint,
  onDeleteCheckpoint,
}: CollabVersionsTabProps) {
  const [versionLabel, setVersionLabel] = useState<string>('');

  const handleSaveVersion = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveCheckpoint(versionLabel.trim() || undefined);
    setVersionLabel('');
  };

  return (
    <section className="space-y-2.5">
      <form onSubmit={(e) => void handleSaveVersion(e)} className="space-y-2 rounded-lg border border-white/10 bg-[#10131a] p-2.5">
        <label htmlFor="studio-version-label-input" className="block text-[10px] font-semibold text-slate-300">
          Đặt tên Checkpoint (Snapshot CloudDB)
        </label>
        <input
          id="studio-version-label-input"
          name="versionLabel"
          type="text"
          maxLength={120}
          value={versionLabel}
          onChange={(e) => setVersionLabel(e.target.value)}
          placeholder="VD: Pre-Chorus v1 / Mix -9 LUFS"
          className="w-full rounded border border-white/15 bg-[#0b0d11] px-2.5 py-1.5 text-[11px] text-white placeholder-slate-400 focus:border-emerald-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={versionsBusy}
          data-testid="studio-save-version-btn"
          className="flex w-full items-center justify-center gap-1.5 rounded bg-emerald-500 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          <span>{versionsBusy ? 'Đang lưu...' : 'Lưu Checkpoint hiện tại'}</span>
        </button>
      </form>

      {versions.length === 0 ? (
        <p className="py-5 text-center text-[11px] text-slate-400">
          Chưa có Checkpoint nào. Hãy lưu mốc an toàn trước khi thử phối mới!
        </p>
      ) : (
        <div className="space-y-1.5">
          {versions.map((v) => (
            <div
              key={v.id}
              className="rounded-lg border border-white/10 bg-[#10131a] p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-white">{v.label}</p>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    {Math.round(v.bpm)} BPM • {v.total_bars} bars • {v.author_name}
                  </p>
                  <p className="text-[9px] text-slate-400">
                    {new Date(v.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={versionsBusy}
                    onClick={() => void onRestoreCheckpoint(v.id)}
                    data-testid={`restore-version-${v.id}`}
                    className="inline-flex h-6 items-center gap-1 rounded bg-amber-500/20 px-2 text-[10px] font-bold text-amber-300 hover:bg-amber-500/35 disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" /> Khôi phục
                  </button>
                  {isRoomOwner && (
                    <button
                      type="button"
                      disabled={versionsBusy}
                      onClick={() => void onDeleteCheckpoint(v.id)}
                      aria-label={`Xóa Checkpoint ${v.label}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white/5 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
