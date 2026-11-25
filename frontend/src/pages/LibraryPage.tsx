import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
  Radio,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ApiError,
  deleteProject,
  getProject,
  importAimusic,
  listProjects,
  syncProject,
} from '@/lib/api/client';
import { buildProjectFromTemplate, DAW_TEMPLATES } from '@/lib/music/presets';
import {
  clearAllDrafts,
  deleteDraft,
  getStorageUsageBytes,
  listDrafts,
  type StoredDraft,
} from '@/lib/storage/indexeddb';
import { useProjectSession } from '@/components/providers/ProjectProvider';
import type { ProjectSummary } from '@/types/project';

const GENRES = ['', 'Pop', 'Ballad', 'Lo-fi', 'R&B', 'Hip-hop', 'EDM', 'Acoustic', 'Rock'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const { acceptRestoreDraft, loadProjectIntoSession } = useProjectSession();

  const [search, setSearch] = useState('');
  const [genre, setGenre] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'draft' | 'saved'>('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState<12 | 24 | 48>(12);

  const [remoteItems, setRemoteItems] = useState<ProjectSummary[]>([]);
  const [totalRemote, setTotalRemote] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<StoredDraft[]>([]);
  const [storageInfo, setStorageInfo] = useState<{ draftsCount: number; totalBytes: number }>({
    draftsCount: 0,
    totalBytes: 0,
  });
  const [importing, setImporting] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const refreshLocalDrafts = useCallback(async () => {
    try {
      const [all, usage] = await Promise.all([listDrafts(), getStorageUsageBytes()]);
      setDrafts(all);
      setStorageInfo(usage);
    } catch {
      // ignore IndexedDB error
    }
  }, []);

  const fetchRemoteProjects = useCallback(async () => {
    setLoadingRemote(true);
    setRemoteError(null);
    try {
      const res = await listProjects({ page, limit, search, genre });
      setRemoteItems(res.items || []);
      setTotalRemote(res.total || 0);
      setTotalPages(Math.max(1, res.total_pages || 1));
    } catch (err) {
      setRemoteItems([]);
      setRemoteError(
        err instanceof ApiError
          ? err.detail
          : 'Backend ngoại tuyến — đang hiển thị các session lưu cục bộ.'
      );
    } finally {
      setLoadingRemote(false);
    }
  }, [page, limit, search, genre]);

  useEffect(() => {
    void refreshLocalDrafts();
  }, [refreshLocalDrafts]);

  useEffect(() => {
    void fetchRemoteProjects();
  }, [fetchRemoteProjects]);

  const handleOpenRemoteProject = async (projectId: string) => {
    try {
      const state = await getProject(projectId);
      loadProjectIntoSession(state, { dirty: false });
      navigate(`/studio/${encodeURIComponent(projectId)}`);
    } catch {
      navigate(`/studio/${encodeURIComponent(projectId)}`);
    }
  };

  const handleImportAimusic = async (file: File) => {
    setImporting(true);
    setRemoteError(null);
    try {
      const state = await importAimusic(file);
      loadProjectIntoSession(state, { dirty: false });
      navigate(`/studio/${encodeURIComponent(state.project_id)}`);
    } catch (err) {
      setRemoteError(err instanceof ApiError ? err.detail : 'Không thể nạp file .aimusic');
    } finally {
      setImporting(false);
    }
  };

  const handleClearDrafts = async () => {
    await clearAllDrafts();
    await refreshLocalDrafts();
  };

  const handleNewBlankSession = () => {
    const blankTpl = DAW_TEMPLATES.find((t) => t.id === 'blank_session') ?? DAW_TEMPLATES[0];
    const fresh = buildProjectFromTemplate(blankTpl);
    loadProjectIntoSession(fresh, { dirty: true });
    navigate(`/studio/${encodeURIComponent(fresh.project_id)}`);
  };

  const handleDeleteRemoteProject = async (projectId: string) => {
    setConfirmDeleteKey(null);
    try {
      await deleteProject(projectId);
      await deleteDraft(projectId).catch(() => {});
      await Promise.all([fetchRemoteProjects(), refreshLocalDrafts()]);
    } catch (err) {
      setRemoteError(err instanceof ApiError ? err.detail : 'Không thể xóa session trên máy chủ.');
    }
  };

  const handleDuplicateRemoteProject = async (projectId: string) => {
    try {
      const src = await getProject(projectId);
      const copyId = `proj_${Date.now()}`;
      const copyTitle = `${src.title || src.project_id} (Copy)`;
      const dup = {
        ...src,
        project_id: copyId,
        title: copyTitle,
        version: 1,
        config: { ...src.config, title: copyTitle },
      };
      const saved = await syncProject(copyId, dup).catch(() => dup);
      loadProjectIntoSession(saved, { dirty: true });
      navigate(`/studio/${encodeURIComponent(saved.project_id)}`);
    } catch (err) {
      setRemoteError(err instanceof ApiError ? err.detail : 'Không thể nhân bản session.');
    }
  };

  const filteredDrafts = drafts.filter((d) => {
    if (sourceFilter === 'saved') return false;
    const matchesSearch =
      !search ||
      (d.state.title || '').toLowerCase().includes(search.toLowerCase()) ||
      d.project_id.toLowerCase().includes(search.toLowerCase());
    const matchesGenre = !genre || d.state.config.genre === genre;
    return matchesSearch && matchesGenre;
  });

  const visibleRemoteItems = sourceFilter === 'draft' ? [] : remoteItems;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Kho Session &amp; Dự án</h1>
          <p className="text-xs text-slate-400">
            Quản lý session cục bộ, bản phối đã đồng bộ và mở trực tiếp gói dự án{' '}
            <code>.aimusic</code> vào Phòng thu.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleNewBlankSession}
            className="flex items-center gap-1.5 rounded border border-white/15 bg-[#1b1e25] px-3.5 py-1.5 text-xs font-bold text-white transition hover:border-amber-400/60 hover:bg-[#232732]"
          >
            <Plus className="h-3.5 w-3.5 text-amber-400" />
            <span>Tạo Session mới</span>
          </button>

          <div className="flex items-center gap-2 rounded border border-white/10 bg-[#181b22] px-3 py-1.5 text-xs text-slate-300">
            <HardDrive className="h-3.5 w-3.5 text-amber-400" />
            <span>
              Local: <strong>{storageInfo.draftsCount}/5</strong> ({formatBytes(storageInfo.totalBytes)})
            </span>
            {storageInfo.draftsCount > 0 && (
              <button
                type="button"
                onClick={() => void handleClearDrafts()}
                aria-label="Xóa toàn bộ bản nháp cục bộ"
                title="Xóa toàn bộ bản nháp"
                className="ml-1 rounded p-1 text-rose-400 hover:bg-rose-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <label
            htmlFor="library-import-aimusic"
            className="flex cursor-pointer items-center gap-2 rounded bg-amber-500 px-4 py-1.5 text-xs font-bold text-slate-950 transition hover:bg-amber-400"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>{importing ? 'Đang mở...' : 'Import .aimusic'}</span>
            <input
              id="library-import-aimusic"
              name="aimusicFile"
              type="file"
              accept=".aimusic,.zip"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportAimusic(f);
              }}
            />
          </label>
        </div>
      </div>

      {/* Filters */}
      <section className="flex flex-wrap items-center gap-2.5 rounded-lg border border-white/10 bg-[#181b22] p-3">
        <div className="relative min-w-[220px] flex-1">
          <label htmlFor="library-search-input" className="sr-only">
            Tìm theo tên session
          </label>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <input
            id="library-search-input"
            name="search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Tìm tên session hoặc mã project..."
            className="w-full rounded border border-white/10 bg-[#111317] py-1.5 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
          />
        </div>

        <label htmlFor="library-genre-filter" className="sr-only">
          Thể loại
        </label>
        <select
          id="library-genre-filter"
          name="genreFilter"
          value={genre}
          onChange={(e) => {
            setGenre(e.target.value);
            setPage(1);
          }}
          className="rounded border border-white/10 bg-[#111317] px-3 py-1.5 text-xs text-white"
        >
          {GENRES.map((g) => (
            <option key={g || 'all'} value={g}>
              {g ? `Genre: ${g}` : 'Tất cả thể loại'}
            </option>
          ))}
        </select>

        <label htmlFor="library-source-filter" className="sr-only">
          Nguồn
        </label>
        <select
          id="library-source-filter"
          name="sourceFilter"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as 'all' | 'draft' | 'saved')}
          className="rounded border border-white/10 bg-[#111317] px-3 py-1.5 text-xs text-white"
        >
          <option value="all">Tất cả nguồn</option>
          <option value="draft">Nháp cục bộ</option>
          <option value="saved">Đã lưu máy chủ</option>
        </select>

        <label htmlFor="library-page-limit" className="sr-only">
          Số mục mỗi trang
        </label>
        <select
          id="library-page-limit"
          name="pageLimit"
          aria-label="Số mục mỗi trang"
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value) as 12 | 24 | 48);
            setPage(1);
          }}
          className="rounded border border-white/10 bg-[#111317] px-3 py-1.5 text-xs text-white"
        >
          <option value={12}>12 mục / trang</option>
          <option value={24}>24 mục / trang</option>
          <option value={48}>48 mục / trang</option>
        </select>
      </section>

      {remoteError && (
        <div className="rounded border border-white/10 bg-[#181b22] px-3.5 py-2 text-xs text-slate-300">
          {remoteError}
        </div>
      )}

      {/* Local Drafts */}
      {filteredDrafts.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Local Sessions ({filteredDrafts.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredDrafts.map((d) => (
              <div
                key={d.project_id}
                className="flex flex-col justify-between rounded-lg border border-white/10 bg-[#181b22] p-3.5"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                      Local Draft
                    </span>
                    {confirmDeleteKey === `draft:${d.project_id}` ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteKey(null);
                            void deleteDraft(d.project_id).then(refreshLocalDrafts);
                          }}
                          className="rounded bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-rose-400"
                        >
                          Xóa
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteKey(null)}
                          className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"
                        >
                          Hủy
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteKey(`draft:${d.project_id}`)}
                        aria-label={`Xóa ${d.state.title || d.project_id}`}
                        className="text-slate-500 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <h3 className="mt-2 truncate text-sm font-bold text-white">
                    {d.state.title || d.project_id}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400 tabular-nums">
                    {d.state.config.genre} • {d.state.analysis.bpm} BPM • {d.state.analysis.detected_key}{' '}
                    {d.state.analysis.detected_scale}
                  </p>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5 text-xs">
                  <span className="text-[11px] text-slate-500">{formatBytes(d.size_bytes)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      acceptRestoreDraft(d);
                      navigate(`/studio/${encodeURIComponent(d.project_id)}`);
                    }}
                    className="inline-flex items-center gap-1 rounded bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-500 hover:text-slate-950"
                  >
                    <SlidersHorizontal className="h-3 w-3" /> Mở DAW
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Server Saved Projects */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Database className="h-3.5 w-3.5 text-sky-400" />
            <span>Saved Sessions ({totalRemote})</span>
          </h2>
          {loadingRemote && <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
        </div>

        {visibleRemoteItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-white/10 bg-[#16191f] py-10 text-center">
            <FolderOpen className="h-7 w-7 text-slate-600" />
            <p className="mt-2 text-xs text-slate-400">Chưa có session phù hợp bộ lọc.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleRemoteItems.map((item) => (
              <div
                key={item.project_id}
                className="flex flex-col justify-between rounded-lg border border-white/10 bg-[#181b22] p-3.5"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[10px] font-bold text-sky-300">
                        Saved
                      </span>
                      {item.visibility === 'public' && item.share_slug && (
                        <a
                          href={`/share/${encodeURIComponent(item.share_slug)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(`/share/${encodeURIComponent(item.share_slug!)}`);
                          }}
                          className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/25"
                          title="Mở trang Demo công khai"
                        >
                          <Radio className="h-2.5 w-2.5" /> Public
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleDuplicateRemoteProject(item.project_id)}
                        aria-label={`Nhân bản ${item.title || item.project_id}`}
                        title="Nhân bản thành session mới"
                        className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-sky-300"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      {confirmDeleteKey === `remote:${item.project_id}` ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleDeleteRemoteProject(item.project_id)}
                            className="rounded bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-rose-400"
                          >
                            Xóa
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteKey(null)}
                            className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"
                          >
                            Hủy
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteKey(`remote:${item.project_id}`)}
                          aria-label={`Xóa session ${item.title || item.project_id}`}
                          title="Xóa session khỏi máy chủ"
                          className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <h3 className="mt-2 truncate text-sm font-bold text-white">
                    {item.title || item.project_id}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400 tabular-nums">
                    {item.genre || 'Pop'} • {item.bpm || 100} BPM • {item.key || 'C'}{' '}
                    {item.scale || 'major'}
                  </p>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5 text-xs">
                  <span className="text-[11px] text-slate-500">
                    {item.updated_at ? new Date(item.updated_at).toLocaleDateString() : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleOpenRemoteProject(item.project_id)}
                    className="inline-flex items-center gap-1 rounded bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-500 hover:text-slate-950"
                  >
                    <SlidersHorizontal className="h-3 w-3" /> Mở DAW
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 text-xs text-slate-400">
          <span>
            Trang {page} / {totalPages}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-slate-200 hover:bg-white/10 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Trước
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-slate-200 hover:bg-white/10 disabled:opacity-40"
            >
              Sau <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
