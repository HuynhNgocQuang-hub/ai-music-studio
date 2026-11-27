import { useEffect, useState } from 'react';
import { History, Lock, Users, Wifi, WifiOff, X } from 'lucide-react';
import type {
  CollabChatMessage,
  CollabPeerPresence,
  CollabTrackLock,
  ProjectVersionSummary,
  StudioBarComment,
} from '@/types/project';
import CollabLockChatTab from './collab/CollabLockChatTab';
import CollabNotesTab from './collab/CollabNotesTab';
import CollabVersionsTab from './collab/CollabVersionsTab';

export type CollabDrawerTab = 'collab' | 'chat_lock' | 'versions';

interface StudioCollabPanelProps {
  open: boolean;
  initialTab?: CollabDrawerTab;
  onClose: () => void;
  projectId: string;
  clientId: string;
  currentBar: number;
  totalBars: number;
  trackNames: string[];
  wsConnected: boolean;
  roomCode: string | null;
  isRoomOwner: boolean;
  peers: CollabPeerPresence[];
  trackLocks: Record<string, CollabTrackLock>;
  chatMessages: CollabChatMessage[];
  lastSyncNotice: string | null;
  barComments: StudioBarComment[];
  versions: ProjectVersionSummary[];
  versionsBusy: boolean;
  collabError: string | null;
  onEnableInvite: () => Promise<void>;
  onCloseInvite: () => Promise<void>;
  onAddBarComment: (payload: { bar_number: number; track_id?: string; text: string }) => Promise<void>;
  onToggleResolved: (commentId: string, nextResolved: boolean) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
  onSeekToBar: (barNumber: number) => void;
  onBroadcastCue: () => void;
  onToggleTrackLock: (trackId: string, locked: boolean) => void;
  onSendRoomChat: (text: string) => void;
  onSaveCheckpoint: (label?: string) => Promise<unknown>;
  onRestoreCheckpoint: (versionId: string) => Promise<unknown>;
  onDeleteCheckpoint: (versionId: string) => Promise<void>;
}

export default function StudioCollabPanel({
  open,
  initialTab = 'collab',
  onClose,
  projectId,
  clientId,
  currentBar,
  totalBars,
  trackNames,
  wsConnected,
  roomCode,
  isRoomOwner,
  peers,
  trackLocks,
  chatMessages,
  lastSyncNotice,
  barComments,
  versions,
  versionsBusy,
  collabError,
  onEnableInvite,
  onCloseInvite,
  onAddBarComment,
  onToggleResolved,
  onDeleteComment,
  onSeekToBar,
  onBroadcastCue,
  onToggleTrackLock,
  onSendRoomChat,
  onSaveCheckpoint,
  onRestoreCheckpoint,
  onDeleteCheckpoint,
}: StudioCollabPanelProps) {
  const [drawerTab, setDrawerTab] = useState<CollabDrawerTab>(initialTab);

  useEffect(() => {
    setDrawerTab(initialTab);
  }, [initialTab]);

  if (!open) return null;

  const inviteUrl =
    typeof window !== 'undefined' && roomCode
      ? `${window.location.origin}/studio/${encodeURIComponent(projectId)}?collab=${encodeURIComponent(roomCode)}`
      : roomCode
      ? `/studio/${encodeURIComponent(projectId)}?collab=${encodeURIComponent(roomCode)}`
      : '';

  const activeLockCount = Object.keys(trackLocks).length;

  return (
    <aside
      aria-label="Phòng cộng tác Realtime & Lịch sử Phiên bản"
      className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-sky-400/25 bg-[#151922] shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-white/10 bg-[#1b202b] px-3 py-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-sky-400" />
          <span className="text-xs font-bold text-white">Studio Collab &amp; Versions</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
              wsConnected ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-600/40 text-slate-300'
            }`}
          >
            {wsConnected ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
            {wsConnected ? 'LIVE' : 'Offline'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng bảng Collab"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Sub-Tabs */}
      <div className="grid grid-cols-3 border-b border-white/10 bg-[#11151d] p-1 text-[10px] font-bold">
        <button
          type="button"
          onClick={() => setDrawerTab('collab')}
          data-testid="collab-tab-main"
          className={`flex items-center justify-center gap-1 rounded py-1.5 transition ${
            drawerTab === 'collab' ? 'bg-sky-500/20 text-sky-200' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Users className="h-3 w-3" />
          <span>Notes ({barComments.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setDrawerTab('chat_lock')}
          data-testid="collab-tab-lock-chat"
          className={`flex items-center justify-center gap-1 rounded py-1.5 transition ${
            drawerTab === 'chat_lock' ? 'bg-amber-500/20 text-amber-200' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Lock className="h-3 w-3" />
          <span>Lock ({activeLockCount}) · Chat</span>
        </button>
        <button
          type="button"
          onClick={() => setDrawerTab('versions')}
          data-testid="collab-tab-versions"
          className={`flex items-center justify-center gap-1 rounded py-1.5 transition ${
            drawerTab === 'versions' ? 'bg-emerald-500/20 text-emerald-200' : 'text-slate-400 hover:text-white'
          }`}
        >
          <History className="h-3 w-3" />
          <span>Versions ({versions.length})</span>
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {collabError && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200">
            {collabError}
          </div>
        )}

        {lastSyncNotice && (
          <p className="rounded bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">{lastSyncNotice}</p>
        )}

        {drawerTab === 'collab' && (
          <CollabNotesTab
            currentBar={currentBar}
            totalBars={totalBars}
            trackNames={trackNames}
            wsConnected={wsConnected}
            roomCode={roomCode}
            inviteUrl={inviteUrl}
            isRoomOwner={isRoomOwner}
            peers={peers}
            barComments={barComments}
            onEnableInvite={onEnableInvite}
            onCloseInvite={onCloseInvite}
            onAddBarComment={onAddBarComment}
            onToggleResolved={onToggleResolved}
            onDeleteComment={onDeleteComment}
            onSeekToBar={onSeekToBar}
            onBroadcastCue={onBroadcastCue}
          />
        )}

        {drawerTab === 'chat_lock' && (
          <CollabLockChatTab
            clientId={clientId}
            trackNames={trackNames}
            wsConnected={wsConnected}
            isRoomOwner={isRoomOwner}
            trackLocks={trackLocks}
            chatMessages={chatMessages}
            onToggleTrackLock={onToggleTrackLock}
            onSendRoomChat={onSendRoomChat}
          />
        )}

        {drawerTab === 'versions' && (
          <CollabVersionsTab
            versions={versions}
            versionsBusy={versionsBusy}
            isRoomOwner={isRoomOwner}
            onSaveCheckpoint={onSaveCheckpoint}
            onRestoreCheckpoint={onRestoreCheckpoint}
            onDeleteCheckpoint={onDeleteCheckpoint}
          />
        )}
      </div>
    </aside>
  );
}
