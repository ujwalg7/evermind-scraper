from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional, Tuple

from .models import RawCapture


def parse_frontmatter_and_body(md_text: str) -> Tuple[Dict[str, str], str]:
  if not md_text.startswith("---"):
    return {}, md_text

  lines = md_text.splitlines()
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
  for raw_line in lines[1:end_idx]:
    line = raw_line.strip()
    if not line or line.startswith("#") or line.startswith("- "):
      continue
    if ":" not in line:
      continue
    key, value = line.split(":", 1)
    frontmatter[key.strip()] = value.strip().strip('"')

  body = "\n".join(lines[end_idx + 1 :]).lstrip("\n")
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
