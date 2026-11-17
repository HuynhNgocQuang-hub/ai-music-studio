import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  FolderOpen,
  HardDrive,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ApiError,
  getProject,
  importAimusic,
  listProjects,
} from '@/lib/api/client';
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
          : 'Backend Redis chưa trực tuyến — đang hiển thị bản nháp IndexedDB cục bộ.'
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

  const filteredDrafts = drafts.filter((d) => {
    if (sourceFilter === 'saved') return false;
    const matchesSearch =
      !search ||
      (d.state.title || '').toLowerCase().includes(search.toLowerCase()) ||
      d.project_id.toLowerCase().includes(search.toLowerCase());
    const matchesGenre = !genre || d.state.config.genre === genre;
    return matchesSearch && matchesGenre;
  });

  const visibleRemoteItems =
    sourceFilter === 'draft' ? [] : remoteItems;

  const latestDraft = drafts[0] ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Thư viện Dự án & Bản nháp</h1>
          <p className="text-xs text-slate-400">
            Quản lý dự án Redis, khôi phục bản nháp Auto-Save (IndexedDB) và mở file `.aimusic`.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-[#121622] px-3 py-2 text-xs text-slate-300">
            <HardDrive className="h-4 w-4 text-amber-400" />
            <span>
              IndexedDB: <strong>{storageInfo.draftsCount}/5</strong> nháp (
              {formatBytes(storageInfo.totalBytes)})
            </span>
            {storageInfo.draftsCount > 0 && (
              <button
                type="button"
                onClick={() => void handleClearDrafts()}
                title="Dọn toàn bộ bản nháp cũ"
                className="ml-1 rounded p-1 text-rose-400 hover:bg-rose-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500">
            <Upload className="h-4 w-4" />
            <span>{importing ? 'Đang mở...' : 'Import .aimusic'}</span>
            <input
              type="file"
              accept=".aimusic,.zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportAimusic(f);
              }}
            />
          </label>
        </div>
      </div>

      {/* Pinned Latest Draft Recovery Card */}
      {latestDraft && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-center gap-3">
            <RotateCcw className="h-5 w-5 text-amber-400" />
            <div>
              <p className="text-sm font-semibold text-white">
                Khôi phục phiên làm việc gần nhất:{' '}
                <span className="text-amber-300">
                  {latestDraft.state.title || latestDraft.project_id}
                </span>
              </p>
              <p className="text-xs text-amber-200/80">
                {latestDraft.state.config.genre} • {latestDraft.state.analysis.bpm} BPM • Cập nhật{' '}
                {new Date(latestDraft.updated_at).toLocaleString()}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              acceptRestoreDraft(latestDraft);
              navigate(`/studio/${encodeURIComponent(latestDraft.project_id)}`);
            }}
            className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
          >
            Khôi phục vào Studio
          </button>
        </section>
      )}

      {/* Search & Filters Bar */}
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800 bg-[#121622] p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Tìm theo tên dự án..."
            className="w-full rounded-xl border border-slate-700 bg-[#0b0d14] py-2 pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <select
          value={genre}
          onChange={(e) => {
            setGenre(e.target.value);
            setPage(1);
          }}
          className="rounded-xl border border-slate-700 bg-[#0b0d14] px-3 py-2 text-sm text-white"
        >
          {GENRES.map((g) => (
            <option key={g || 'all'} value={g}>
              {g ? `Genre: ${g}` : 'Tất cả Thể loại'}
            </option>
          ))}
        </select>

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as 'all' | 'draft' | 'saved')}
          className="rounded-xl border border-slate-700 bg-[#0b0d14] px-3 py-2 text-sm text-white"
        >
          <option value="all">Tất cả nguồn</option>
          <option value="draft">Bản nháp Auto-Save (IndexedDB)</option>
          <option value="saved">Đã lưu (Redis)</option>
        </select>

        <select
          aria-label="Số mục mỗi trang"
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value) as 12 | 24 | 48);
            setPage(1);
          }}
          className="rounded-xl border border-slate-700 bg-[#0b0d14] px-3 py-2 text-sm text-white"
        >
          <option value={12}>12 mục / trang</option>
          <option value={24}>24 mục / trang</option>
          <option value={48}>48 mục / trang</option>
        </select>
      </section>

      {remoteError && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-xs text-slate-300">
          {remoteError}
        </div>
      )}

      {/* Local IndexedDB Drafts */}
      {filteredDrafts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300">
            Bản nháp Auto-Save trong IndexedDB ({filteredDrafts.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredDrafts.map((d) => (
              <div
                key={d.project_id}
                className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-[#121622] p-4"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                      Auto-Save Draft
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteDraft(d.project_id).then(refreshLocalDrafts)}
                      className="text-slate-500 hover:text-rose-400"
                      title="Xóa bản nháp"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <h3 className="mt-2 truncate text-base font-semibold text-white">
                    {d.state.title || d.project_id}
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {d.state.config.genre} • {d.state.analysis.bpm} BPM • {d.state.analysis.detected_key}{' '}
                    {d.state.analysis.detected_scale}
                  </p>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3 text-xs">
                  <span className="text-slate-500">{formatBytes(d.size_bytes)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      acceptRestoreDraft(d);
                      navigate(`/studio/${encodeURIComponent(d.project_id)}`);
                    }}
                    className="rounded-lg bg-indigo-600/20 px-3 py-1 font-medium text-indigo-300 hover:bg-indigo-600/30"
                  >
                    Mở trong Studio
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Remote Redis Projects with Pagination */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-300">
            <Database className="h-4 w-4 text-indigo-400" />
            <span>Dự án trên Redis ({totalRemote})</span>
          </h2>
          {loadingRemote && <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />}
        </div>

        {visibleRemoteItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-800 bg-[#121622] py-12 text-center">
            <FolderOpen className="h-8 w-8 text-slate-600" />
            <p className="mt-2 text-sm text-slate-400">Chưa có dự án nào phù hợp bộ lọc trên Redis.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleRemoteItems.map((item) => (
              <div
                key={item.project_id}
                className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-[#121622] p-4"
              >
                <div>
                  <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
                    Redis Saved
                  </span>
                  <h3 className="mt-2 truncate text-base font-semibold text-white">
                    {item.title || item.project_id}
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {item.genre || 'Pop'} • {item.bpm || 100} BPM • {item.key || 'C'}{' '}
                    {item.scale || 'major'}
                  </p>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3 text-xs">
                  <span className="text-slate-500">
                    {item.updated_at ? new Date(item.updated_at).toLocaleDateString() : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleOpenRemoteProject(item.project_id)}
                    className="rounded-lg bg-emerald-600/20 px-3 py-1 font-medium text-emerald-300 hover:bg-emerald-600/30"
                  >
                    Mở Studio
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination Controls */}
        <div className="flex items-center justify-between pt-2 text-xs text-slate-400">
          <span>
            Trang {page} / {totalPages}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Trước
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              Sau <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
