from __future__ import annotations

from typing import Dict, Optional
import os

from pydantic import BaseModel, Field

from .models import CuratedNote


class SynthesisOutput(BaseModel):
  why_it_matters: str = Field(description="One-line rationale for why this note should be retained.")
  related: list[str] = Field(default_factory=list, description="Related names or entities.")
  tags: list[str] = Field(default_factory=list, description="Compact topic tags.")


def _resolve_model_reference() -> str:
  """Return a PydanticAI model reference.

  Preferred config:
    EVERMIND_INGESTER_LLM_MODEL=openai:gpt-4o-mini
    EVERMIND_INGESTER_LLM_MODEL=anthropic:claude-3-5-haiku-latest
    EVERMIND_INGESTER_LLM_MODEL=openrouter:google/gemini-3-pro-preview

  Backward-compatible config:
    EVERMIND_INGESTER_LLM_PROVIDER=openai
    EVERMIND_INGESTER_LLM_MODEL=gpt-4o-mini
  """
  provider = os.getenv("EVERMIND_INGESTER_LLM_PROVIDER", "openai").lower()
  model = os.getenv("EVERMIND_INGESTER_LLM_MODEL", "openai:gpt-4o-mini")

  if ":" in model:
    return model
  return f"{provider}:{model}"


def summarize_note_content(note: CuratedNote) -> Optional[Dict[str, object]]:
  try:
    from pydantic_ai import Agent
    from pydantic_ai.exceptions import ModelHTTPError
  except Exception:
    return None

  model = _resolve_model_reference()
  agent = Agent(
    model=model,
    output_type=SynthesisOutput,
    system_prompt="Produce concise notes for an article summary with few claims."
  )

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
  except ModelHTTPError:
    return None
  except Exception:
    return None
