from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, List

from .models import CuratedNote

try:
    import yaml  # type: ignore[import-untyped]
except Exception:  # pragma: no cover - fallback if PyYAML missing
    yaml = None  # type: ignore[assignment]


def _append_yaml_lines(lines: List[str], key: str, value: Any) -> None:
    if yaml is None:
        if isinstance(value, list):
            lines.append(f"{key}:")
            for item in value:
                item_value = str(item)
                if isinstance(item, str):
                    item_value = item_value.replace('"', '\\"')
                    lines.append(f"  - {item_value}")
                else:
                    lines.append(f"  - {item_value}")
            if not value:
                lines[-1] = f"{key}: []"
            return
        if isinstance(value, dict):
            lines.append(f"{key}:")
            if not value:
                lines[-1] = f"{key}: {{}}"
                return
            for item_key, item_value in value.items():
                safe_item_key = str(item_key).replace('"', '\\"')
                safe_item_value = str(item_value).replace('"', '\\"')
                if item_value in (None, ""):
                    lines.append(f'  "{safe_item_key}": ""')
                else:
                    lines.append(f'  "{safe_item_key}": "{safe_item_value}"')
            return
        safe_value = str(value).replace('"', '\\"')
        lines.append(f'{key}: "{safe_value}"')
        return

    dumped = yaml.safe_dump({key: value}, sort_keys=False, default_flow_style=False).strip().split("\n")
    if not dumped:
        return
    lines.append(dumped[0])
    for line in dumped[1:]:
        lines.append(f"  {line}")


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
  if note.why_it_matters:
      lines.append(f'why_it_matters: "{note.why_it_matters}"')
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
  for key, value in note.source_metadata.items():
      if key in {
          "title",
          "status",
          "confidence",
          "temporal_relevance",
          "source_url",
          "raw_source",
          "captured_at",
          "reviewed_at",
          "source_content",
          "related",
          "supersedes",
          "contradicts",
          "tags",
          "format",
      }:
          continue
      _append_yaml_lines(lines, f"source_{key}", value)
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
