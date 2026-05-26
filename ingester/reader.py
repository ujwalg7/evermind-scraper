from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .models import RawCapture

try:
    import yaml  # type: ignore[import-untyped]
except Exception:  # pragma: no cover - fallback for environments without PyYAML
    yaml = None  # type: ignore[assignment]


def _coerce_frontmatter_value(value: Any) -> Any:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "on"}:
            return True
        if normalized in {"false", "no", "off"}:
            return False
        try:
            if normalized.isdigit():
                return int(normalized)
            return float(normalized)
        except ValueError:
            return value
        return value
    if isinstance(value, (int, float, bool, list, dict)) or value is None:
        return value
    return str(value)


def parse_frontmatter_and_body(md_text: str) -> Tuple[Dict[str, Any], str]:
  if not md_text.startswith("---"):
    return {}, md_text

  lines = md_text.split("\n")
  if len(lines) < 2:
    return {}, md_text

  end_idx = None
  for i in range(1, len(lines)):
    if lines[i].strip() == "---":
      end_idx = i
      break
  if end_idx is None:
    return {}, md_text

  frontmatter = {}
  frontmatter_text = "\n".join(lines[1:end_idx])
  if yaml is not None:
      try:
          parsed = yaml.safe_load(frontmatter_text)
          if isinstance(parsed, dict):
              frontmatter = {str(key): _coerce_frontmatter_value(value) for key, value in parsed.items()}
          else:
              frontmatter = {}
      except Exception:
          frontmatter = {}

  if not frontmatter:
      current_list_key: Optional[str] = None
      for raw_line in lines[1:end_idx]:
          if not raw_line.strip():
              continue

          line = raw_line.rstrip()
          stripped_line = line.strip()
          if stripped_line.startswith("#"):
              continue

          if current_list_key is not None:
              if stripped_line.startswith("- "):
                  item = stripped_line[2:].strip()
              elif stripped_line.startswith("-"):
                  item = stripped_line[1:].strip()
              else:
                  item = None

              if item is not None:
                  if item.startswith(("'", '"')) and item.endswith(item[0]) and len(item) >= 2:
                      item = item[1:-1]
                  existing = frontmatter.get(current_list_key)
                  if isinstance(existing, list):
                      existing.append(_coerce_frontmatter_value(item))
                  continue

          if ":" not in line:
              continue

          key, value = line.split(":", 1)
          key = key.strip()
          value = value.strip()
          if not value:
              frontmatter[key] = []
              current_list_key = key
              continue
          if value.startswith(("'", '"')) and value.endswith(value[0]) and len(value) >= 2:
              value = value[1:-1]
          current_list_key = None
          frontmatter[key] = _coerce_frontmatter_value(value)

  body = "\n".join(lines[end_idx + 1:])
  return frontmatter, body


def read_raw_capture(path: Path) -> RawCapture:
  text = path.read_text(encoding="utf-8")
  frontmatter, body = parse_frontmatter_and_body(text)
  source_url = (
    frontmatter.get("source_url")
    or frontmatter.get("source")
    or frontmatter.get("url")
    or frontmatter.get("link")
    or ""
  )
  title = frontmatter.get("title") or path.stem
  capture_status = frontmatter.get("capture_status") or frontmatter.get("status") or "partial"
  if capture_status not in {"complete", "partial", "needs_review"}:
    capture_status = "partial"

  fingerprint = frontmatter.get("fingerprint")

  return RawCapture(
    path=str(path),
    title=title,
    source_url=source_url.strip(),
    source_content=body.strip(),
    captured_at=frontmatter.get("captured_at", ""),
    capture_status=capture_status,  # type: ignore[arg-type]
    fingerprint=fingerprint,
    raw_frontmatter=frontmatter
  )


def discover_raw_notes(raw_dir: Path):
  if not raw_dir.exists():
    return []
  return sorted(raw_dir.glob("*.md"))
