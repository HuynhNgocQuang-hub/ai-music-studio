import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Clock,
  Disc3,
  FolderOpen,
  Mic,
  Play,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import { deleteProject, getProject, listProjects } from '@/lib/api/client';
import { DAW_TEMPLATES, buildProjectFromTemplate, type DAWStarterTemplate } from '@/lib/music/presets';
import { deleteDraft, listDrafts, type StoredDraft } from '@/lib/storage/indexeddb';
import type { ProjectState, ProjectSummary } from '@/types/project';

interface SessionEntry {
  project_id: string;
  title: string;
  genre: string;
  bpm: number;
  key: string;
  scale: string;
  updated_at?: string;
  isDraft: boolean;
  fullState?: ProjectState;
}

export default function HomePage() {
  const navigate = useNavigate();
  const { project, loadProjectIntoSession, acceptRestoreDraft } = useProjectSession();

  const [recentDrafts, setRecentDrafts] = useState<StoredDraft[]>([]);
  const [remoteItems, setRemoteItems] = useState<ProjectSummary[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void listDrafts().then(setRecentDrafts).catch(() => { });
    void listProjects({ page: 1, limit: 8 })
      .then((res) => setRemoteItems(res.items || []))
      .catch(() => { });
  }, []);

  const sessions = useMemo<SessionEntry[]>(() => {
    const map = new Map<string, SessionEntry>();
    for (const d of recentDrafts) {
      map.set(d.project_id, {
        project_id: d.project_id,
        title: d.state.title || 'Untitled Session',
        genre: d.state.config.genre || 'Pop',
        bpm: d.state.analysis.bpm || 100,
        key: d.state.analysis.detected_key || 'C',
        scale: d.state.analysis.detected_scale || 'major',
        updated_at: d.updated_at,
        isDraft: true,
        fullState: d.state,
      });
    }
    for (const r of remoteItems) {
      if (!map.has(r.project_id)) {
        map.set(r.project_id, {
          project_id: r.project_id,
          title: r.title || r.project_id,
          genre: r.genre || 'Pop',
          bpm: r.bpm || 100,
          key: r.key || 'C',
          scale: r.scale || 'major',
          updated_at: r.updated_at,
          isDraft: r.source === 'draft',
        });
      }
    }
    return Array.from(map.values()).slice(0, 8);
  }, [recentDrafts, remoteItems]);

  const handleLaunchTemplate = (tpl: DAWStarterTemplate) => {
    const state = buildProjectFromTemplate(tpl);
    loadProjectIntoSession(state, { dirty: true });
    navigate(`/studio/${encodeURIComponent(state.project_id)}`);
  };

  const handleOpenSession = async (item: SessionEntry) => {
    if (item.fullState) {
      const draft = recentDrafts.find((d) => d.project_id === item.project_id);
      if (draft) {
        acceptRestoreDraft(draft);
      } else {
        loadProjectIntoSession(item.fullState, { dirty: false });
      }
      navigate(`/studio/${encodeURIComponent(item.project_id)}`);
      return;
    }
    try {
      const remote = await getProject(item.project_id);
      loadProjectIntoSession(remote, { dirty: false });
    } catch {
      // ignore if offline
    }
    navigate(`/studio/${encodeURIComponent(item.project_id)}`);
  };

  const handleDeleteSession = async (item: SessionEntry) => {
    setConfirmDeleteId(null);
    await deleteDraft(item.project_id).catch(() => {});
    await deleteProject(item.project_id).catch(() => {});
    setRecentDrafts((prev) => prev.filter((d) => d.project_id !== item.project_id));
    setRemoteItems((prev) => prev.filter((r) => r.project_id !== item.project_id));
  };

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      {/* Logic Pro / Ableton Project Chooser Header */}
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-[#181b22] p-6">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-amber-400">
            <Disc3 className="h-3.5 w-3.5" />
            <span>Production Workstation</span>
          </div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-white md:text-3xl">
            Bắt đầu Session Làm nhạc Mới
          </h1>
          <p className="max-w-2xl text-xs text-slate-400 md:text-sm">
            Chọn nhanh một bộ Starter Kit bên dưới để vào ngay Phòng thu DAW (Step Sequencer, Piano
            Roll, Console Mixer), hoặc thu âm giọng ngân nga để AI tự phối khí.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to="/create"
            className="inline-flex items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-500/15 px-4 py-2.5 text-xs font-bold text-sky-200 transition hover:bg-sky-500/25"
          >
            <Mic className="h-4 w-4" />
            <span>AI Hum-to-Music</span>
          </Link>
          <Link
            to={`/studio/${encodeURIComponent(project.project_id)}`}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-amber-400"
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span>Mở Studio hiện tại</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      {/* Instant 1-Click DAW Templates Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-slate-300">
            1. Starter Templates (Mở thẳng vào Studio với Drums, Bass &amp; Hợp âm sẵn)
          </h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DAW_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => handleLaunchTemplate(tpl)}
              className="group flex flex-col justify-between rounded-lg border border-white/10 bg-[#181b22] p-4 text-left transition hover:border-amber-400/60 hover:bg-[#1f232c]"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${tpl.accentColor}`}
                  >
                    {tpl.genre}
                  </span>
                  <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-400">
                    {tpl.bpm} BPM • {tpl.key} {tpl.scale}
                  </span>
                </div>
                <h3 className="mt-2.5 text-base font-bold text-white group-hover:text-amber-300">
                  {tpl.name}
                </h3>
                <p className="mt-1 text-xs text-slate-400">{tpl.subtitle}</p>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-2.5 text-[11px]">
                <span className="font-mono text-slate-400">{tpl.chords.join(' – ')}</span>
                <span className="inline-flex items-center gap-1 font-bold text-amber-400">
                  <Play className="h-3 w-3 fill-current" /> Khởi tạo
                </span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Recent Sessions Table */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-slate-300">
            2. Recent Sessions ({sessions.length})
          </h2>
          <Link
            to="/library"
            className="inline-flex items-center gap-1 text-xs font-semibold text-sky-400 hover:underline"
          >
            <FolderOpen className="h-3.5 w-3.5" /> Mở Kho Session (.aimusic)
          </Link>
        </div>

        {sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 bg-[#16191f] py-10 text-center text-xs text-slate-400">
            Chưa có session nào. Hãy chọn một Starter Template phía trên hoặc mở{' '}
            <Link to="/create" className="text-amber-400 underline">
              AI Hum-to-Music
            </Link>
            .
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/10 bg-[#16191f]">
            <div className="divide-y divide-white/[0.06]">
              {sessions.map((item) => (
                <div
                  key={item.project_id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-white/[0.04]"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Sparkles className="h-4 w-4 shrink-0 text-amber-400" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">{item.title}</p>
                      <p className="text-[11px] text-slate-400 tabular-nums">
                        {item.genre} • {item.bpm} BPM • {item.key} {item.scale}
                        {item.isDraft ? ' • Nháp cục bộ' : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {item.updated_at && (
                      <span className="hidden items-center gap-1 text-[11px] text-slate-500 sm:inline-flex">
                        <Clock className="h-3 w-3" />
                        {new Date(item.updated_at).toLocaleDateString()}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleOpenSession(item)}
                      className="rounded border border-white/15 bg-[#232730] px-3 py-1 text-xs font-semibold text-white transition hover:border-amber-400 hover:bg-amber-500 hover:text-slate-950"
                    >
                      Mở trong Studio
                    </button>
                    {confirmDeleteId === item.project_id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void handleDeleteSession(item)}
                          className="rounded bg-rose-500 px-2 py-0.5 text-[11px] font-bold text-white hover:bg-rose-400"
                        >
                          Xác nhận
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/10"
                        >
                          Hủy
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(item.project_id)}
                        aria-label={`Xóa session ${item.title}`}
                        title="Xóa session"
                        className="rounded p-1.5 text-slate-500 transition hover:bg-rose-500/20 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
