from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import List, Optional

from .cli_client import EvermindCliClient
from .models import CuratedNote, QCDecision, RawCapture
from .qc import classify_capture_quality
from .reader import discover_raw_notes, read_raw_capture
from .writer import write_curation_note
from .llm import summarize_note_content


def _safe_text(value: Optional[str], fallback: str) -> str:
  if value is None:
    return fallback
  return value.strip()


def curate_from_raw(
  vault_path: str,
  raw_subdir: str = "inbox/raw",
  limit: Optional[int] = None,
  reextract: bool = False,
  synthesis: bool = False,
) -> List[Path]:
  vault_dir = Path(vault_path)
  raw_dir = vault_dir / raw_subdir

  raw_paths = discover_raw_notes(raw_dir)
  if limit is not None:
    raw_paths = raw_paths[:limit]

  client: Optional[EvermindCliClient] = EvermindCliClient() if reextract else None
  written_paths: List[Path] = []

  for path in raw_paths:
    raw = read_raw_capture(path)
    captured_text = raw.source_content
    source_url = raw.source_url

    if reextract and source_url and client is not None:
      try:
        payload = client.extract(source_url)
        cli_note = payload["note"]
        captured_text = _safe_text(cli_note.get("contentMarkdown"), captured_text)
      except Exception:
        # Keep deterministic classification based on the raw source when wrapper fails.
        pass

    qc = classify_capture_quality(
      raw.title,
      source_url,
      captured_text,
      raw.capture_status
    )

    note = _to_curated_note(raw, qc, captured_text)
    if synthesis:
      enrichments = summarize_note_content(note)
      if enrichments:
        if enrichments.get("related"):
          note.related = enrichments["related"]
        if enrichments.get("tags"):
          note.tags = enrichments["tags"]

    written = write_curation_note(vault_dir, note)
    written_paths.append(written)

  return written_paths


def _to_curated_note(raw: RawCapture, qc: QCDecision, source_content: str) -> CuratedNote:
  now = _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"
  status = qc.status
  captured_at = _safe_text(raw.captured_at, now)
  tags = ["evermind", status.replace("-", "_"), qc.capture_status]
  if qc.confidence == "high":
    tags.append("high-confidence")

  return CuratedNote(
    title=raw.title,
    status=status,
    confidence=qc.confidence,
    temporal_relevance=qc.temporal_relevance,
    source_url=raw.source_url,
    raw_source=raw.path,
    captured_at=captured_at,
    reviewed_at=now,
    related=[],
    supersedes=[],
    contradicts=[],
    tags=tags,
    source_content=source_content
  )
