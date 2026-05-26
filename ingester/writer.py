from __future__ import annotations

from pathlib import Path
from typing import Iterable, List

from .models import CuratedNote


def _format_list(values: Iterable[str]) -> List[str]:
  return [f"  - {value}" for value in values if value]


def _to_yaml_list(values: Iterable[str], prefix: str = "") -> str:
  value_lines = _format_list(values)
  if not value_lines:
    return f"{prefix}[]"
  return prefix + "\n" + "\n".join(value_lines)


def render_curation_note(note: CuratedNote) -> str:
  lines = ["---"]
  lines.append(f'title: "{note.title}"')
  lines.append(f"status: {note.status}")
  lines.append(f"format: {note.format}")
  lines.append(f"confidence: {note.confidence}")
  lines.append(f"temporal_relevance: {note.temporal_relevance}")
  lines.append(f'source_url: "{note.source_url}"')
  lines.append(f'raw_source: "{note.raw_source}"')
  lines.append(f'captured_at: "{note.captured_at}"')
  lines.append(f'reviewed_at: "{note.reviewed_at}"')
  if note.related:
    lines.append(_to_yaml_list(note.related, "related:"))
  else:
    lines.append("related: []")
  if note.supersedes:
    lines.append(_to_yaml_list(note.supersedes, "supersedes:"))
  else:
    lines.append("supersedes: []")
  if note.contradicts:
    lines.append(_to_yaml_list(note.contradicts, "contradicts:"))
  else:
    lines.append("contradicts: []")
  lines.append(_to_yaml_list(note.tags, "tags:"))
  lines.append("---")
  lines.append("")
  lines.append(f"# {note.title}")
  lines.append("")
  if note.source_content:
    lines.append(note.source_content)

  return "\n".join(lines).rstrip() + "\n"


def _slugify(value: str) -> str:
  value = value.lower().replace(" ", "-")
  return "".join(
    ch if ch.isalnum() or ch in "-_" else "-"
    for ch in value
  ).strip("-")


def write_curation_note(vault_path: Path, note: CuratedNote) -> Path:
  date_key = note.reviewed_at.split("T")[0]
  if note.status == "curated":
    bucket = "curated"
  elif note.status == "rejected":
    bucket = "rejected"
  else:
    bucket = "needs-review"

  target_dir = vault_path / bucket / date_key
  target_dir.mkdir(parents=True, exist_ok=True)

  slug = _slugify(note.title) or "ingested-note"
  out_path = target_dir / f"{slug}.md"
  out_path = _ensure_unique_path(out_path)
  out_path.write_text(render_curation_note(note), encoding="utf-8")
  return out_path


def _ensure_unique_path(path: Path) -> Path:
  if not path.exists():
    return path

  counter = 1
  stem = path.stem
  for _ in range(0, 1000):
    candidate = path.with_name(f"{stem}-{counter}.md")
    if not candidate.exists():
      return candidate
    counter += 1
  return path
