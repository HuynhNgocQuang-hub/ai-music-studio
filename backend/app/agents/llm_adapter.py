"""Dual LLM Adapter supporting Google Gemini, OpenAI, and deterministic Mock fallback."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

_PLACEHOLDER_PREFIXES = ("your_", "changeme", "replace_", "example_", "<")


class LLMProvider(str, Enum):
    GEMINI = "gemini"
    OPENAI = "openai"
    MOCK = "mock"


@dataclass
class LLMResponse:
    provider: LLMProvider
    model: str
    text: str
    data: Optional[Dict[str, Any]] = None
    is_mock: bool = False
    usage: Dict[str, Any] = field(default_factory=dict)


def _is_valid_key(value: Optional[str]) -> bool:
    if not value:
        return False
    cleaned = value.strip()
    if len(cleaned) < 8:
        return False
    lowered = cleaned.lower()
    return not any(lowered.startswith(prefix) for prefix in _PLACEHOLDER_PREFIXES)


def _extract_json_block(raw_text: str) -> Dict[str, Any]:
    """Extract JSON object from plain text or fenced markdown."""
    text = raw_text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
        return {"result": parsed}
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed
        raise


class LLMAdapter:
    """Unified async LLM adapter with Gemini, OpenAI, and deterministic Mock fallback."""

    DEFAULT_MODELS: Dict[LLMProvider, str] = {
        LLMProvider.GEMINI: "gemini-2.5-flash",
        LLMProvider.OPENAI: "gpt-4o-mini",
        LLMProvider.MOCK: "mock-music-v1",
    }

    DEFAULT_ROLE_PROVIDERS: Dict[str, LLMProvider] = {
        "composer": LLMProvider.GEMINI,
        "lyricist": LLMProvider.GEMINI,
        "coach": LLMProvider.GEMINI,
        "arranger": LLMProvider.OPENAI,
        "qa": LLMProvider.OPENAI,
    }

    def __init__(
        self,
        gemini_api_key: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        default_provider: Optional[str] = None,
        role_providers: Optional[Dict[str, str]] = None,
        models: Optional[Dict[str, str]] = None,
        mock_handler: Optional[Callable[[str, str, Optional[str]], str]] = None,
    ) -> None:
        self._gemini_api_key = gemini_api_key
        self._openai_api_key = openai_api_key
        self._default_provider_override = default_provider
        self._role_providers: Dict[str, LLMProvider] = dict(self.DEFAULT_ROLE_PROVIDERS)
        if role_providers:
            for role, prov in role_providers.items():
                self._role_providers[role.lower()] = LLMProvider(prov.lower())
        self._models: Dict[LLMProvider, str] = dict(self.DEFAULT_MODELS)
        if models:
            for prov_key, model_name in models.items():
                self._models[LLMProvider(prov_key.lower())] = model_name
        self._mock_handler = mock_handler

    def configure(
        self,
        gemini_api_key: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        default_provider: Optional[str] = None,
        role_providers: Optional[Dict[str, str]] = None,
        models: Optional[Dict[str, str]] = None,
    ) -> None:
        """Update runtime API keys or routing preferences without restarting."""
        if gemini_api_key is not None:
            self._gemini_api_key = gemini_api_key
        if openai_api_key is not None:
            self._openai_api_key = openai_api_key
        if default_provider is not None:
            self._default_provider_override = default_provider
        if role_providers:
            for role, prov in role_providers.items():
                self._role_providers[role.lower()] = LLMProvider(prov.lower())
        if models:
            for prov_key, model_name in models.items():
                self._models[LLMProvider(prov_key.lower())] = model_name

    @property
    def gemini_api_key(self) -> Optional[str]:
        if self._gemini_api_key is not None:
            return self._gemini_api_key
        return self._read_setting("GEMINI_API_KEY")

    @property
    def openai_api_key(self) -> Optional[str]:
        if self._openai_api_key is not None:
            return self._openai_api_key
        return self._read_setting("OPENAI_API_KEY")

    @property
    def default_provider(self) -> LLMProvider:
        raw = self._default_provider_override or self._read_setting("DEFAULT_LLM_PROVIDER") or "gemini"
        try:
            return LLMProvider(raw.strip().lower())
        except ValueError:
            return LLMProvider.GEMINI

    @staticmethod
    def _read_setting(env_name: str) -> Optional[str]:
        val = os.getenv(env_name)
        if val:
            return val
        try:
            from app.core.config import settings  # type: ignore

            return getattr(settings, env_name, None) or getattr(settings, env_name.lower(), None)
        except Exception:
            return None

    def has_key(self, provider: LLMProvider) -> bool:
        if provider == LLMProvider.GEMINI:
            return _is_valid_key(self.gemini_api_key)
        if provider == LLMProvider.OPENAI:
            return _is_valid_key(self.openai_api_key)
        return True

    def resolve_provider(
        self,
        role: Optional[str] = None,
        provider: Optional[str | LLMProvider] = None,
    ) -> LLMProvider:
        """Select active provider based on explicit override, role routing, and available keys."""
        candidates: list[LLMProvider] = []
        if provider is not None:
            prov = provider if isinstance(provider, LLMProvider) else LLMProvider(str(provider).lower())
            if prov == LLMProvider.MOCK:
                return LLMProvider.MOCK
            candidates.append(prov)

        if role and role.lower() in self._role_providers:
            candidates.append(self._role_providers[role.lower()])

        candidates.append(self.default_provider)
        candidates.extend([LLMProvider.GEMINI, LLMProvider.OPENAI])

        seen: set[LLMProvider] = set()
        for candidate in candidates:
            if candidate in seen or candidate == LLMProvider.MOCK:
                continue
            seen.add(candidate)
            if self.has_key(candidate):
                return candidate
        return LLMProvider.MOCK

    def status(self) -> Dict[str, Any]:
        return {
            "default_provider": self.default_provider.value,
            "gemini_configured": self.has_key(LLMProvider.GEMINI),
            "openai_configured": self.has_key(LLMProvider.OPENAI),
            "role_providers": {k: v.value for k, v in self._role_providers.items()},
            "resolved_roles": {
                role: self.resolve_provider(role=role).value
                for role in self._role_providers
            },
        }

    async def generate_text(
        self,
        prompt: str,
        system_prompt: str = "",
        role: Optional[str] = None,
        provider: Optional[str | LLMProvider] = None,
        temperature: float = 0.5,
        timeout_sec: float = 25.0,
    ) -> LLMResponse:
        selected = self.resolve_provider(role=role, provider=provider)
        if selected == LLMProvider.MOCK:
            return self._generate_mock(prompt=prompt, system_prompt=system_prompt, role=role, as_json=False)

        try:
            if selected == LLMProvider.GEMINI:
                return await asyncio.wait_for(
                    self._call_gemini(prompt, system_prompt, temperature, as_json=False),
                    timeout=timeout_sec,
                )
            if selected == LLMProvider.OPENAI:
                return await asyncio.wait_for(
                    self._call_openai(prompt, system_prompt, temperature, as_json=False),
                    timeout=timeout_sec,
                )
        except Exception as exc:
            logger.warning("LLM provider %s failed (%s); falling back to mock provider.", selected.value, exc)
        return self._generate_mock(prompt=prompt, system_prompt=system_prompt, role=role, as_json=False)

    async def generate_json(
        self,
        prompt: str,
        system_prompt: str = "",
        role: Optional[str] = None,
        provider: Optional[str | LLMProvider] = None,
        temperature: float = 0.3,
        timeout_sec: float = 25.0,
    ) -> LLMResponse:
        selected = self.resolve_provider(role=role, provider=provider)
        if selected == LLMProvider.MOCK:
            return self._generate_mock(prompt=prompt, system_prompt=system_prompt, role=role, as_json=True)

        try:
            if selected == LLMProvider.GEMINI:
                resp = await asyncio.wait_for(
                    self._call_gemini(prompt, system_prompt, temperature, as_json=True),
                    timeout=timeout_sec,
                )
                resp.data = _extract_json_block(resp.text)
                return resp
            if selected == LLMProvider.OPENAI:
                resp = await asyncio.wait_for(
                    self._call_openai(prompt, system_prompt, temperature, as_json=True),
                    timeout=timeout_sec,
                )
                resp.data = _extract_json_block(resp.text)
                return resp
        except Exception as exc:
            logger.warning("LLM JSON call via %s failed (%s); falling back to mock.", selected.value, exc)
        return self._generate_mock(prompt=prompt, system_prompt=system_prompt, role=role, as_json=True)

    async def _call_gemini(
        self,
        prompt: str,
        system_prompt: str,
        temperature: float,
        as_json: bool,
    ) -> LLMResponse:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore

        api_key = self.gemini_api_key
        model_name = self._read_setting("GEMINI_MODEL") or self._models[LLMProvider.GEMINI]

        def _invoke() -> str:
            client = genai.Client(api_key=api_key)
            config_kwargs: Dict[str, Any] = {"temperature": temperature}
            if system_prompt:
                config_kwargs["system_instruction"] = system_prompt
            if as_json:
                config_kwargs["response_mime_type"] = "application/json"
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(**config_kwargs),
            )
            return response.text or ""

        text = await asyncio.to_thread(_invoke)
        return LLMResponse(
            provider=LLMProvider.GEMINI,
            model=model_name,
            text=text,
            is_mock=False,
        )

    async def _call_openai(
        self,
        prompt: str,
        system_prompt: str,
        temperature: float,
        as_json: bool,
    ) -> LLMResponse:
        from openai import AsyncOpenAI  # type: ignore

        api_key = self.openai_api_key
        model_name = self._read_setting("OPENAI_MODEL") or self._models[LLMProvider.OPENAI]
        client = AsyncOpenAI(api_key=api_key)

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        kwargs: Dict[str, Any] = {
            "model": model_name,
            "messages": messages,
            "temperature": temperature,
        }
        if as_json:
            kwargs["response_format"] = {"type": "json_object"}

        response = await client.chat.completions.create(**kwargs)
        text = response.choices[0].message.content or ""
        usage = {}
        if getattr(response, "usage", None) is not None:
            usage = {
                "prompt_tokens": getattr(response.usage, "prompt_tokens", 0),
                "completion_tokens": getattr(response.usage, "completion_tokens", 0),
            }
        return LLMResponse(
            provider=LLMProvider.OPENAI,
            model=model_name,
            text=text,
            is_mock=False,
            usage=usage,
        )

    def _generate_mock(
        self,
        prompt: str,
        system_prompt: str,
        role: Optional[str],
        as_json: bool,
    ) -> LLMResponse:
        if self._mock_handler is not None:
            custom_text = self._mock_handler(prompt, system_prompt, role)
            data = None
            if as_json:
                try:
                    data = _extract_json_block(custom_text)
                except Exception:
                    data = {"text": custom_text}
            return LLMResponse(
                provider=LLMProvider.MOCK,
                model=self._models[LLMProvider.MOCK],
                text=custom_text,
                data=data,
                is_mock=True,
            )

        digest = hashlib.sha256(f"{role}:{prompt}".encode("utf-8")).hexdigest()[:12]
        role_name = (role or "assistant").lower()
        if as_json:
            payload: Dict[str, Any] = {
                "provider": "mock",
                "role": role_name,
                "seed": digest,
                "approved": True,
                "notes": [],
                "chords": [],
                "suggestions": [
                    "Keep bass in low register (C2-G3) and align chord tones with strong beats."
                ],
            }
            return LLMResponse(
                provider=LLMProvider.MOCK,
                model=self._models[LLMProvider.MOCK],
                text=json.dumps(payload, ensure_ascii=False),
                data=payload,
                is_mock=True,
            )

        summary = (
            f"[Mock {role_name} | seed={digest}] "
            "Maintain consistent BPM grid, keep chord tones aligned with melody strong beats, "
            "and preserve headroom below -1.0 dBFS."
        )
        return LLMResponse(
            provider=LLMProvider.MOCK,
            model=self._models[LLMProvider.MOCK],
            text=summary,
            is_mock=True,
        )


_default_adapter: Optional[LLMAdapter] = None


def get_llm_adapter() -> LLMAdapter:
    global _default_adapter
    if _default_adapter is None:
        _default_adapter = LLMAdapter()
    return _default_adapter
