from __future__ import annotations

import logging
import os
from inspect import signature
from pydantic import BaseModel, Field
from typing import Any, Dict, Optional

log = logging.getLogger(__name__)
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


class SynthesisOutput(BaseModel):
    why_it_matters: str = Field(description="One-line rationale for why this note should be retained.")
    related: list[str] = Field(default_factory=list, description="Related names or entities.")
    tags: list[str] = Field(default_factory=list, description="Compact topic tags.")


def _resolve_model_reference() -> str:
    """Return a PydanticAI model reference."""
    provider = os.getenv("EVERMIND_INGESTER_LLM_PROVIDER", "openai").lower()
    model = os.getenv("EVERMIND_INGESTER_LLM_MODEL", "openai:gpt-4o-mini")

    if ":" in model:
        return model
    return f"{provider}:{model}"


def _resolve_openrouter_model(openrouter_model: str):
    """Attempt to build an OpenAI-compatible OpenRouter model adapter."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        log.warning(
            "OPENROUTER_API_KEY is not set; cannot use openrouter model %s. "
            "Set OPENROUTER_API_KEY or switch to an explicit provider prefix.",
            openrouter_model,
        )
        return None

    try:
        from pydantic_ai.models.openai import OpenAIModel
    except Exception:
        return None

    try:
        params = set(signature(OpenAIModel.__init__).parameters.keys())
        kwargs: Dict[str, Any] = {}

        for key in ("model", "model_name", "name"):
            if key in params:
                kwargs[key] = openrouter_model
                break
        else:
            kwargs["model"] = openrouter_model

        if "api_key" in params:
            kwargs["api_key"] = api_key
        elif "api_key_env_var" in params:
            kwargs["api_key_env_var"] = api_key
        elif "api_key_provider" in params:
            kwargs["api_key_provider"] = api_key

        if "base_url" in params:
            kwargs["base_url"] = OPENROUTER_BASE_URL
        elif "base_url_override" in params:
            kwargs["base_url_override"] = OPENROUTER_BASE_URL
        elif "api_base" in params:
            kwargs["api_base"] = OPENROUTER_BASE_URL
        elif "api_base_url" in params:
            kwargs["api_base_url"] = OPENROUTER_BASE_URL

        return OpenAIModel(**kwargs)
    except Exception as exc:
        log.warning(
            "OpenAI-compatible OpenRouter model initialization failed for %s: %s",
            openrouter_model,
            exc
        )
        return None


def _build_agent(model: str):
    try:
        from pydantic_ai import Agent
    except Exception:
        log.info("PydanticAI is unavailable; skipping synthesis.")
        return None

    if model.startswith("openrouter:"):
        openrouter_model = model.split(":", 1)[1].strip()
        adapter = _resolve_openrouter_model(openrouter_model)
        if adapter is not None:
            try:
                return Agent(
                    model=adapter,
                    output_type=SynthesisOutput,
                    system_prompt="Produce concise notes for an article summary with few claims."
                )
            except Exception as exc:
                log.warning("Failed to construct OpenRouter adapter agent for %s: %s", openrouter_model, exc)

        fallback = f"openai:{openrouter_model}"
        return Agent(
            model=fallback,
            output_type=SynthesisOutput,
            system_prompt="Produce concise notes for an article summary with few claims."
        )

    return Agent(
        model=model,
        output_type=SynthesisOutput,
        system_prompt="Produce concise notes for an article summary with few claims."
    )


def summarize_note_content(note: Any) -> Optional[Dict[str, object]]:
    try:
        from pydantic_ai.exceptions import ModelHTTPError
    except Exception:
        log.warning("PydanticAI exception type unavailable; skipping special-case error handling.")
        ModelHTTPError = Exception  # type: ignore[assignment]

    model = _resolve_model_reference()
    if not model:
        return None

    agent = _build_agent(model)
    if agent is None:
        return None

    prompt = (
        "Create a compact takeaway summary for the following capture.\n\n"
        f"Title: {note.title}\n"
        f"Source URL: {note.source_url}\n\n"
        f"Captured content:\n{note.source_content}\n"
    )

    try:
        result = agent.run_sync(prompt)
        payload = result.output
        return payload.model_dump()
    except ModelHTTPError as exc:
        log.warning("LLM HTTP error during synthesis for %s: %s", note.source_url, exc)
        return None
    except Exception as exc:
        log.warning("LLM synthesis failed for %s: %s", note.source_url, exc)
        return None
