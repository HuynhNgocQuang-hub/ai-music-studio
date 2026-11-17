"""Multi-agent core package for AI Music Studio."""

from .arranger_agent import ArrangerAgent
from .coach_lyricist_agent import CoachLyricistAgent
from .composer_agent import ComposerAgent
from .llm_adapter import (
    LLMAdapter,
    LLMProvider,
    LLMResponse,
    get_llm_adapter,
)
from .orchestrator import (
    JobCancelledError,
    JobTimeoutError,
    Orchestrator,
    orchestrator,
)
from .qa_agent import QAAgent, QAReport

__all__ = [
    "ArrangerAgent",
    "CoachLyricistAgent",
    "ComposerAgent",
    "JobCancelledError",
    "JobTimeoutError",
    "LLMAdapter",
    "LLMProvider",
    "LLMResponse",
    "Orchestrator",
    "QAAgent",
    "QAReport",
    "get_llm_adapter",
    "orchestrator",
]
