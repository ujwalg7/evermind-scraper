from __future__ import annotations

from pathlib import Path

from ingester.models import CuratedNote
from ingester.qc import classify_capture_quality
from ingester.writer import render_curation_note, write_curation_note


def test_qc_marks_blocked_content_for_review():
  decision = classify_capture_quality(
    title="Cookie Wall",
    source_url="https://example.com/article",
    content="Please accept all cookies to continue reading this article.",
    capture_status="partial",
  )
  assert decision.status == "needs-review"
  assert decision.confidence == "low"
  assert len(decision.reasons) >= 1


def test_qc_rejects_missing_source_url():
  decision = classify_capture_quality(
    title="No Source",
    source_url="",
    content="Some extracted text.",
    capture_status="partial",
  )
  assert decision.status == "rejected"
  assert "Missing source URL" in decision.reasons[0]


def test_writer_serializes_evermind_frontmatter(tmp_path: Path):
  note = CuratedNote(
    title="AI Research Notes",
    status="curated",
    confidence="high",
    temporal_relevance="current",
    source_url="https://example.com/research",
    raw_source="/inbox/raw/example.md",
    captured_at="2026-05-26T12:34:56Z",
    reviewed_at="2026-05-26T12:40:00Z",
    source_content="Meaningful content.",
  )

  written = write_curation_note(tmp_path, note)

  assert written.exists()
  markdown = written.read_text(encoding="utf-8")
  assert "title: \"AI Research Notes\"" in markdown
  assert "status: curated" in markdown
  assert "source_url: \"https://example.com/research\"" in markdown
  assert "raw_source: \"/inbox/raw/example.md\"" in markdown
  assert "tags:" in markdown
  assert "related: []" in markdown
  assert "# AI Research Notes" in markdown
