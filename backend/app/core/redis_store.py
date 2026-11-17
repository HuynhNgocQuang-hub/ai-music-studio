"""Redis state store with automatic In-Memory TTL fallback."""

from __future__ import annotations

import json
import math
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.config import settings
from app.core.schemas import ProjectState

try:
    import redis  # type: ignore
except ImportError:  # pragma: no cover
    redis = None  # type: ignore


class _MemoryBackend:
    """Thread-safe in-memory key-value store with monotonic TTL eviction."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._data: dict[str, tuple[Any, Optional[float]]] = {}
        self._lists: dict[str, list[str]] = {}

    def _purge_if_expired(self, key: str) -> bool:
        entry = self._data.get(key)
        if entry is None:
            return True
        _, expires_at = entry
        if expires_at is not None and time.monotonic() >= expires_at:
            self._data.pop(key, None)
            return True
        return False

    def set(self, key: str, value: Any, ex: Optional[int] = None) -> None:
        with self._lock:
            expires_at = (time.monotonic() + ex) if ex and ex > 0 else None
            self._data[key] = (value, expires_at)

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if self._purge_if_expired(key):
                return None
            return self._data[key][0]

    def delete(self, key: str) -> bool:
        with self._lock:
            existed = key in self._data or key in self._lists
            self._data.pop(key, None)
            self._lists.pop(key, None)
            return existed

    def keys(self, prefix: str = "") -> list[str]:
        with self._lock:
            now = time.monotonic()
            expired = [k for k, (_, exp) in self._data.items() if exp is not None and now >= exp]
            for k in expired:
                self._data.pop(k, None)
            return [k for k in self._data if k.startswith(prefix)]

    def lpush_trim(self, key: str, value: str, max_len: int) -> None:
        with self._lock:
            lst = self._lists.setdefault(key, [])
            lst.insert(0, value)
            if len(lst) > max_len:
                del lst[max_len:]

    def lpop(self, key: str) -> Optional[str]:
        with self._lock:
            lst = self._lists.get(key)
            if not lst:
                return None
            return lst.pop(0)

    def clear_prefix(self, prefix: str) -> int:
        with self._lock:
            targets = [k for k in self._data if k.startswith(prefix)]
            for k in targets:
                self._data.pop(k, None)
            list_targets = [k for k in self._lists if k.startswith(prefix)]
            for k in list_targets:
                self._lists.pop(k, None)
            return len(targets) + len(list_targets)

    def stats(self) -> tuple[int, int]:
        with self._lock:
            keys = self.keys("")
            total_bytes = 0
            for k in keys:
                val = self._data[k][0]
                if isinstance(val, (bytes, bytearray)):
                    total_bytes += len(val)
                elif isinstance(val, str):
                    total_bytes += len(val.encode("utf-8"))
            return len(keys), total_bytes


class RedisStore:
    """Unified ProjectState, Audio Bytes, Undo Stack, and Job State store.

    Connects to Redis when reachable and transparently falls back to an
    in-memory TTL store when Redis is unavailable (e.g. standalone unit tests).
    """

    def __init__(
        self,
        redis_url: Optional[str] = None,
        project_ttl: Optional[int] = None,
        audio_ttl: Optional[int] = None,
        force_memory: bool = False,
    ) -> None:
        self.redis_url = redis_url if redis_url is not None else settings.REDIS_URL
        self.project_ttl = project_ttl if project_ttl is not None else settings.PROJECT_TTL_SECONDS
        self.audio_ttl = audio_ttl if audio_ttl is not None else settings.AUDIO_TTL_SECONDS
        self._memory = _MemoryBackend()
        self._client = None
        self._using_redis = False

        if not force_memory and redis is not None and self.redis_url:
            self._init_redis()

    def _init_redis(self) -> None:
        try:
            client = redis.from_url(
                self.redis_url,
                decode_responses=False,
                socket_connect_timeout=0.5,
                socket_timeout=0.5,
            )
            client.ping()
            self._client = client
            self._using_redis = True
        except Exception:
            self._client = None
            self._using_redis = False

    def _safe_redis(self) -> Any:
        if not self._using_redis or self._client is None:
            return None
        return self._client

    def _fallback(self) -> None:
        self._using_redis = False
        self._client = None

    # --- Project CRUD & Pagination ---

    def save_project(self, project: ProjectState, ttl: Optional[int] = None) -> ProjectState:
        """Persist ProjectState with TTL and update updated_at timestamp."""
        project.updated_at = datetime.now(timezone.utc).isoformat()
        payload = project.model_dump_json()
        key = f"project:{project.project_id}"
        exp = ttl if ttl is not None else self.project_ttl

        client = self._safe_redis()
        if client is not None:
            try:
                client.set(key, payload.encode("utf-8"), ex=exp)
                return project
            except Exception:
                self._fallback()

        self._memory.set(key, payload, ex=exp)
        return project

    def get_project(self, project_id: str) -> Optional[ProjectState]:
        """Load ProjectState by ID or return None."""
        key = f"project:{project_id}"
        client = self._safe_redis()
        raw: Optional[str | bytes] = None
        if client is not None:
            try:
                raw = client.get(key)
            except Exception:
                self._fallback()

        if raw is None:
            raw = self._memory.get(key)
        if raw is None:
            return None

        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return ProjectState.model_validate_json(raw)

    def delete_project(self, project_id: str) -> bool:
        """Delete a project and its undo stack."""
        key = f"project:{project_id}"
        undo_key = f"undo:{project_id}"
        deleted = self._memory.delete(key)
        self._memory.delete(undo_key)

        client = self._safe_redis()
        if client is not None:
            try:
                res = client.delete(key, undo_key)
                deleted = deleted or bool(res)
            except Exception:
                self._fallback()
        return deleted

    def list_projects(
        self,
        page: int = 1,
        limit: int = 12,
        search: str = "",
        genre: str = "",
        key: str = "",
    ) -> tuple[list[ProjectState], int]:
        """Return paginated, filtered list of ProjectState sorted newest first."""
        projects: list[ProjectState] = []
        client = self._safe_redis()
        raw_keys: list[str] = []

        if client is not None:
            try:
                for k in client.scan_iter(match="project:*", count=200):
                    raw_keys.append(k.decode("utf-8") if isinstance(k, bytes) else str(k))
            except Exception:
                self._fallback()
                raw_keys = []

        if not self._using_redis:
            raw_keys = self._memory.keys("project:")

        for k in raw_keys:
            pid = k.split("project:", 1)[-1]
            proj = self.get_project(pid)
            if proj is not None:
                projects.append(proj)

        q = search.strip().lower()
        g = genre.strip().lower()
        k_filter = key.strip().lower()

        filtered: list[ProjectState] = []
        for p in projects:
            if q and q not in p.config.title.lower() and q not in p.project_id.lower() and q not in p.config.genre.lower():
                continue
            if g and p.config.genre.lower() != g:
                continue
            if k_filter and p.analysis.detected_key.lower() != k_filter:
                continue
            filtered.append(p)

        filtered.sort(key=lambda item: item.updated_at, reverse=True)
        total = len(filtered)
        safe_limit = max(1, min(limit, 100))
        total_pages = max(1, math.ceil(total / safe_limit)) if total > 0 else 1
        safe_page = max(1, min(page, total_pages))
        start = (safe_page - 1) * safe_limit
        return filtered[start : start + safe_limit], total

    # --- Undo History ---

    def push_undo(self, project_id: str, project: ProjectState, max_history: int = 20) -> None:
        """Push snapshot onto project undo stack (capped at max_history)."""
        undo_key = f"undo:{project_id}"
        snapshot = project.model_dump_json()
        client = self._safe_redis()
        if client is not None:
            try:
                client.lpush(undo_key, snapshot.encode("utf-8"))
                client.ltrim(undo_key, 0, max_history - 1)
                client.expire(undo_key, self.project_ttl)
                return
            except Exception:
                self._fallback()

        self._memory.lpush_trim(undo_key, snapshot, max_history)

    def pop_undo(self, project_id: str) -> Optional[ProjectState]:
        """Pop most recent undo snapshot and save it as current project."""
        undo_key = f"undo:{project_id}"
        raw: Optional[str | bytes] = None
        client = self._safe_redis()
        if client is not None:
            try:
                raw = client.lpop(undo_key)
            except Exception:
                self._fallback()

        if raw is None:
            raw = self._memory.lpop(undo_key)
        if raw is None:
            return None

        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        restored = ProjectState.model_validate_json(raw)
        return self.save_project(restored)

    # --- Audio Asset Bytes (mem://...) ---

    def save_audio_bytes(self, ref: str, data: bytes, ttl: Optional[int] = None) -> str:
        """Store raw audio bytes in Redis or memory under ref."""
        key = f"audio:{ref}"
        exp = ttl if ttl is not None else self.audio_ttl
        client = self._safe_redis()
        if client is not None:
            try:
                client.set(key, data, ex=exp)
                return ref
            except Exception:
                self._fallback()

        self._memory.set(key, data, ex=exp)
        return ref

    def get_audio_bytes(self, ref: str) -> Optional[bytes]:
        """Retrieve audio bytes by ref."""
        key = f"audio:{ref}"
        client = self._safe_redis()
        if client is not None:
            try:
                data = client.get(key)
                if data is not None:
                    return bytes(data)
            except Exception:
                self._fallback()

        mem_data = self._memory.get(key)
        return bytes(mem_data) if mem_data is not None else None

    def delete_audio_bytes(self, ref: str) -> bool:
        """Remove transient audio bytes."""
        key = f"audio:{ref}"
        deleted = self._memory.delete(key)
        client = self._safe_redis()
        if client is not None:
            try:
                deleted = deleted or bool(client.delete(key))
            except Exception:
                self._fallback()
        return deleted

    # --- Multi-Agent Job State & Cancel Flags ---

    def set_job(self, job_id: str, data: dict[str, Any], ttl: int = 3600) -> None:
        key = f"job:{job_id}"
        payload = json.dumps(data)
        client = self._safe_redis()
        if client is not None:
            try:
                client.set(key, payload.encode("utf-8"), ex=ttl)
                return
            except Exception:
                self._fallback()
        self._memory.set(key, payload, ex=ttl)

    def get_job(self, job_id: str) -> Optional[dict[str, Any]]:
        key = f"job:{job_id}"
        raw: Optional[str | bytes] = None
        client = self._safe_redis()
        if client is not None:
            try:
                raw = client.get(key)
            except Exception:
                self._fallback()
        if raw is None:
            raw = self._memory.get(key)
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return json.loads(raw)

    def set_cancel_flag(self, job_id: str, ttl: int = 3600) -> None:
        key = f"job_cancel:{job_id}"
        client = self._safe_redis()
        if client is not None:
            try:
                client.set(key, b"1", ex=ttl)
                return
            except Exception:
                self._fallback()
        self._memory.set(key, "1", ex=ttl)

    def is_cancelled(self, job_id: str) -> bool:
        key = f"job_cancel:{job_id}"
        client = self._safe_redis()
        if client is not None:
            try:
                return bool(client.get(key))
            except Exception:
                self._fallback()
        return bool(self._memory.get(key))

    # --- Health & Cache Cleanup ---

    def ping(self) -> dict[str, Any]:
        """Return store health and backend mode."""
        client = self._safe_redis()
        if client is not None:
            try:
                client.ping()
                info = client.info("memory")
                db_size = client.dbsize()
                return {
                    "connected": True,
                    "backend": "redis",
                    "keys_count": int(db_size),
                    "memory_bytes": int(info.get("used_memory", 0)),
                }
            except Exception:
                self._fallback()

        keys_count, mem_bytes = self._memory.stats()
        return {
            "connected": True,
            "backend": "memory",
            "keys_count": keys_count,
            "memory_bytes": mem_bytes,
        }

    def clear_cache(self) -> dict[str, Any]:
        """Clear transient audio and job caches while preserving active projects."""
        cleared = 0
        cleared += self._memory.clear_prefix("audio:")
        cleared += self._memory.clear_prefix("job:")
        cleared += self._memory.clear_prefix("job_cancel:")

        client = self._safe_redis()
        if client is not None:
            try:
                for pattern in ("audio:*", "job:*", "job_cancel:*"):
                    keys = list(client.scan_iter(match=pattern, count=200))
                    if keys:
                        cleared += int(client.delete(*keys))
            except Exception:
                self._fallback()

        return {"cleared_keys": cleared}


store = RedisStore()


def get_store() -> RedisStore:
    """Return global RedisStore instance."""
    return store
