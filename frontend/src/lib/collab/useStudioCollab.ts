import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  addStudioBarComment,
  buildCollabWsUrl,
  closeCollabSession,
  createProjectVersion,
  deleteProjectVersion,
  deleteStudioBarComment,
  enableCollabSession,
  getCollabSession,
  listProjectVersions,
  listStudioBarComments,
  restoreProjectVersion,
  toggleStudioBarCommentResolved,
} from '@/lib/api/client';
import type {
  CollabChatMessage,
  CollabPeerPresence,
  CollabTrackLock,
  ProjectState,
  ProjectVersionSummary,
  StudioBarComment,
} from '@/types/project';

interface UseStudioCollabOptions {
  project: ProjectState;
  displayName: string;
  collabCodeFromUrl: string | null;
  panelOpen: boolean;
  currentBar: number;
  activeTab: string;
  activeTrack: string;
  onRemoteState: (state: ProjectState, fromName?: string) => void;
}

export function useStudioCollab({
  project,
  displayName,
  collabCodeFromUrl,
  panelOpen,
  currentBar,
  activeTab,
  activeTrack,
  onRemoteState,
}: UseStudioCollabOptions) {
  const clientId = useMemo(
    () => `cli_${Math.random().toString(36).slice(2, 10)}`,
    []
  );
  const [wsConnected, setWsConnected] = useState(false);
  const [roomCode, setRoomCode] = useState<string | null>(collabCodeFromUrl);
  const [peers, setPeers] = useState<CollabPeerPresence[]>([]);
  const [trackLocks, setTrackLocks] = useState<Record<string, CollabTrackLock>>({});
  const [chatMessages, setChatMessages] = useState<CollabChatMessage[]>([]);
  const [barComments, setBarComments] = useState<StudioBarComment[]>([]);
  const [versions, setVersions] = useState<ProjectVersionSummary[]>([]);
  const [versionsBusy, setVersionsBusy] = useState(false);
  const [lastSyncNotice, setLastSyncNotice] = useState<string | null>(null);
  const [collabError, setCollabError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const applyingRemoteRef = useRef(false);
  const onRemoteStateRef = useRef(onRemoteState);
  onRemoteStateRef.current = onRemoteState;

  useEffect(() => {
    if (collabCodeFromUrl) {
      setRoomCode(collabCodeFromUrl);
    }
  }, [collabCodeFromUrl]);

  const refreshVersions = useCallback(async () => {
    if (!project.project_id) return;
    try {
      const res = await listProjectVersions(project.project_id, roomCode || collabCodeFromUrl);
      setVersions(res.items || []);
    } catch {
      // ignore if project not synced yet
    }
  }, [project.project_id, roomCode, collabCodeFromUrl]);

  // Load current collab session, bar comments & saved checkpoints on project switch
  useEffect(() => {
    let active = true;
    setCollabError(null);
    void getCollabSession(project.project_id, collabCodeFromUrl)
      .then((res) => {
        if (!active) return;
        setPeers(res.members || []);
        setTrackLocks(res.track_locks || {});
        if (res.active && res.room_code) {
          setRoomCode(res.room_code);
        } else if (!collabCodeFromUrl && !res.active) {
          setRoomCode(null);
        }
      })
      .catch(() => {});

    void listStudioBarComments(project.project_id, collabCodeFromUrl)
      .then((res) => {
        if (active) setBarComments(res.items || []);
      })
      .catch(() => {
        if (active) setBarComments([]);
      });

    void listProjectVersions(project.project_id, collabCodeFromUrl)
      .then((res) => {
        if (active) setVersions(res.items || []);
      })
      .catch(() => {
        if (active) setVersions([]);
      });

    return () => {
      active = false;
    };
  }, [project.project_id, collabCodeFromUrl]);

  const shouldConnectWs = panelOpen || Boolean(collabCodeFromUrl) || Boolean(roomCode);

  useEffect(() => {
    if (!shouldConnectWs || !project.project_id) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWsConnected(false);
      return;
    }

    let disposed = false;
    let keepAlive: number | null = null;

    const url = buildCollabWsUrl({
      projectId: project.project_id,
      clientId,
      roomCode: roomCode || collabCodeFromUrl,
      displayName,
    });

    const connectTimer = window.setTimeout(() => {
      if (disposed) return;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        if (wsRef.current === ws) {
          setWsConnected(true);
          setCollabError(null);
        }
      };

      ws.onmessage = (evt) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(String(evt.data || '{}')) as Record<string, unknown>;
          const type = String(msg.type || '');
          if (type === 'room_snapshot' || type === 'presence') {
            if (Array.isArray(msg.members)) {
              setPeers(msg.members as CollabPeerPresence[]);
            }
            if (msg.track_locks && typeof msg.track_locks === 'object') {
              setTrackLocks(msg.track_locks as Record<string, CollabTrackLock>);
            }
            if (Array.isArray(msg.chat_history)) {
              setChatMessages(msg.chat_history as CollabChatMessage[]);
            }
          } else if (type === 'track_locks') {
            if (msg.track_locks && typeof msg.track_locks === 'object') {
              setTrackLocks(msg.track_locks as Record<string, CollabTrackLock>);
            }
          } else if (type === 'room_chat' && msg.message) {
            const incomingMsg = msg.message as CollabChatMessage;
            setChatMessages((prev) =>
              prev.some((m) => m.id === incomingMsg.id)
                ? prev
                : [...prev.slice(-49), incomingMsg]
            );
          } else if (type === 'state_sync') {
            if (msg.client_id !== clientId && msg.state) {
              applyingRemoteRef.current = true;
              try {
                const incoming = msg.state as ProjectState;
                onRemoteStateRef.current(
                  incoming,
                  typeof msg.display_name === 'string' ? msg.display_name : undefined
                );
                setLastSyncNotice(
                  `Đã đồng bộ live từ ${typeof msg.display_name === 'string' ? msg.display_name : 'cộng tác viên'}`
                );
              } finally {
                window.setTimeout(() => {
                  applyingRemoteRef.current = false;
                }, 80);
              }
            }
          } else if (type === 'bar_comment_event') {
            const action = String(msg.action || '');
            if (action === 'added' && msg.comment) {
              const c = msg.comment as StudioBarComment;
              setBarComments((prev) =>
                prev.some((x) => x.id === c.id)
                  ? prev
                  : [...prev, c].sort((a, b) => a.bar_number - b.bar_number)
              );
            } else if (action === 'updated' && msg.comment) {
              const c = msg.comment as StudioBarComment;
              setBarComments((prev) => prev.map((x) => (x.id === c.id ? c : x)));
            } else if (action === 'deleted' && typeof msg.comment_id === 'string') {
              setBarComments((prev) => prev.filter((x) => x.id !== msg.comment_id));
            }
          } else if (type === 'transport_cue') {
            const who = typeof msg.display_name === 'string' ? msg.display_name : 'Peer';
            const bar = typeof msg.bar === 'number' ? msg.bar : 1;
            setLastSyncNotice(`${who} cue phát tại Bar ${bar}`);
          } else if (type === 'room_closed') {
            setRoomCode(null);
            setWsConnected(false);
            setTrackLocks({});
            setLastSyncNotice('Chủ phòng đã đóng phiên cộng tác.');
          } else if (type === 'error' && typeof msg.detail === 'string') {
            setCollabError(msg.detail);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
          setWsConnected(false);
        }
      };

      keepAlive = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    }, 30);

    return () => {
      disposed = true;
      window.clearTimeout(connectTimer);
      if (keepAlive !== null) {
        window.clearInterval(keepAlive);
      }
      if (syncTimerRef.current) {
        window.clearTimeout(syncTimerRef.current);
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [shouldConnectWs, project.project_id, roomCode, collabCodeFromUrl, clientId, displayName]);

  // Send cursor / active tab telemetry
  useEffect(() => {
    const ws = wsRef.current;
    if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'cursor',
        bar: currentBar,
        track_id: activeTrack,
        active_tab: activeTab,
      })
    );
  }, [wsConnected, currentBar, activeTrack, activeTab]);

  const queueBroadcastState = useCallback((state: ProjectState) => {
    if (applyingRemoteRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = window.setTimeout(() => {
      const currentWs = wsRef.current;
      if (currentWs && currentWs.readyState === WebSocket.OPEN && !applyingRemoteRef.current) {
        currentWs.send(JSON.stringify({ type: 'state_sync', state }));
      }
    }, 260);
  }, []);

  const broadcastCue = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'transport_cue', playing: true, bar: currentBar }));
    }
  }, [currentBar]);

  const toggleTrackLock = useCallback((trackId: string, locked: boolean) => {
    setCollabError(null);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'track_lock', track_id: trackId, locked }));
    } else {
      setCollabError('Cần kết nối WebSocket LIVE để khóa track.');
    }
  }, []);

  const sendRoomChat = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'room_chat', text: clean }));
    } else {
      setCollabError('WebSocket chưa kết nối LIVE để gửi tin nhắn.');
    }
  }, []);

  const enableInvite = useCallback(async () => {
    setCollabError(null);
    try {
      const res = await enableCollabSession(project.project_id);
      if (res.room_code) setRoomCode(res.room_code);
      setPeers(res.members || []);
      setTrackLocks(res.track_locks || {});
    } catch (err) {
      setCollabError(err instanceof ApiError ? err.detail : 'Không thể bật phòng cộng tác.');
    }
  }, [project.project_id]);

  const closeInvite = useCallback(async () => {
    setCollabError(null);
    try {
      await closeCollabSession(project.project_id);
      setRoomCode(null);
      setPeers([]);
      setTrackLocks({});
    } catch (err) {
      setCollabError(err instanceof ApiError ? err.detail : 'Không thể đóng phòng cộng tác.');
    }
  }, [project.project_id]);

  const addBarComment = useCallback(
    async (payload: { bar_number: number; track_id?: string; text: string }) => {
      setCollabError(null);
      try {
        const created = await addStudioBarComment(
          project.project_id,
          { ...payload, author_name: displayName },
          roomCode || collabCodeFromUrl
        );
        setBarComments((prev) =>
          prev.some((x) => x.id === created.id)
            ? prev
            : [...prev, created].sort((a, b) => a.bar_number - b.bar_number)
        );
      } catch (err) {
        setCollabError(err instanceof ApiError ? err.detail : 'Không thể thêm ghi chú.');
      }
    },
    [project.project_id, displayName, roomCode, collabCodeFromUrl]
  );

  const toggleResolved = useCallback(
    async (commentId: string, nextResolved: boolean) => {
      setCollabError(null);
      try {
        const updated = await toggleStudioBarCommentResolved(
          project.project_id,
          commentId,
          nextResolved,
          roomCode || collabCodeFromUrl
        );
        setBarComments((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      } catch (err) {
        setCollabError(err instanceof ApiError ? err.detail : 'Không thể cập nhật trạng thái ghi chú.');
      }
    },
    [project.project_id, roomCode, collabCodeFromUrl]
  );

  const deleteComment = useCallback(
    async (commentId: string) => {
      setCollabError(null);
      try {
        await deleteStudioBarComment(project.project_id, commentId, roomCode || collabCodeFromUrl);
        setBarComments((prev) => prev.filter((x) => x.id !== commentId));
      } catch (err) {
        setCollabError(err instanceof ApiError ? err.detail : 'Không có quyền xóa ghi chú này.');
      }
    },
    [project.project_id, roomCode, collabCodeFromUrl]
  );

  const saveCheckpoint = useCallback(
    async (label?: string, stateOverride?: ProjectState) => {
      setVersionsBusy(true);
      setCollabError(null);
      try {
        const created = await createProjectVersion(
          project.project_id,
          { label, state: stateOverride || project },
          roomCode || collabCodeFromUrl
        );
        setVersions((prev) => [created, ...prev]);
        setLastSyncNotice(`Đã lưu Checkpoint "${created.label}"`);
        return created;
      } catch (err) {
        setCollabError(err instanceof ApiError ? err.detail : 'Không thể lưu Checkpoint.');
        return null;
      } finally {
        setVersionsBusy(false);
      }
    },
    [project, roomCode, collabCodeFromUrl]
  );

  const restoreCheckpoint = useCallback(
    async (versionId: string) => {
      setVersionsBusy(true);
      setCollabError(null);
      try {
        const res = await restoreProjectVersion(
          project.project_id,
          versionId,
          roomCode || collabCodeFromUrl
        );
        if (res.project_state) {
          applyingRemoteRef.current = true;
          try {
            onRemoteStateRef.current(res.project_state, 'Checkpoint');
            setLastSyncNotice(`Đã khôi phục Checkpoint "${res.label}"`);
          } finally {
            window.setTimeout(() => {
              applyingRemoteRef.current = false;
            }, 80);
          }
        }
        return res.project_state;
      } catch (err) {
        setCollabError(err instanceof ApiError ? err.detail : 'Không thể khôi phục Checkpoint.');
        return null;
      } finally {
        setVersionsBusy(false);
      }
    },
    [project.project_id, roomCode, collabCodeFromUrl]
  );

  const removeCheckpoint = useCallback(
    async (versionId: string) => {
      setVersionsBusy(true);
      setCollabError(null);
      try {
        await deleteProjectVersion(project.project_id, versionId);
        setVersions((prev) => prev.filter((v) => v.id !== versionId));
      } catch (err) {
        setCollabError(err instanceof ApiError ? err.detail : 'Chỉ chủ sở hữu mới có quyền xóa Checkpoint.');
      } finally {
        setVersionsBusy(false);
      }
    },
    [project.project_id]
  );

  return {
    clientId,
    wsConnected,
    roomCode: roomCode || collabCodeFromUrl,
    peers,
    trackLocks,
    chatMessages,
    barComments,
    versions,
    versionsBusy,
    lastSyncNotice,
    collabError,
    isApplyingRemoteRef: applyingRemoteRef,
    queueBroadcastState,
    broadcastCue,
    toggleTrackLock,
    sendRoomChat,
    enableInvite,
    closeInvite,
    addBarComment,
    toggleResolved,
    deleteComment,
    refreshVersions,
    saveCheckpoint,
    restoreCheckpoint,
    removeCheckpoint,
  };
}
