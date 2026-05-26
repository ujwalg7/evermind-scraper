from __future__ import annotations

from pathlib import Path

from ingester.models import CuratedNote
from ingester.pipeline import curate_from_raw
from ingester.qc import classify_capture_quality
from ingester.reader import parse_frontmatter_and_body
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


def test_parse_frontmatter_keeps_yaml_lists_and_rich_values():
    frontmatter, body = parse_frontmatter_and_body(
        "---\n"
        "title: Meta Test\n"
        "source_url: https://example.com/source\n"
        "tags:\n"
        "  - alpha\n"
        "  - beta\n"
        "published: true\n"
        "ratings:\n"
        "  - 1\n"
        "  - 2\n"
        "---\n"
        "Body text here.\n"
    )

    assert body == "Body text here.\n"
    assert frontmatter["title"] == "Meta Test"
    assert frontmatter["tags"] == ["alpha", "beta"]
    assert frontmatter["published"] is True
    assert frontmatter["ratings"] == [1, 2]


def test_parse_frontmatter_handles_alternative_list_indent_styles():
    frontmatter, _ = parse_frontmatter_and_body(
        "---\n"
        "title: Meta List\n"
        "tags:\n"
        "- first\n"
        "- second\n"
        "topics:\n"
        "    - alpha\n"
        "    - beta\n"
        "---\n"
        "Body remains.\n"
    )

    assert frontmatter["tags"] == ["first", "second"]
    assert frontmatter["topics"] == ["alpha", "beta"]


def test_curate_from_raw_moves_processed_notes_and_survives_missing_source_url(tmp_path: Path):
    raw_dir = tmp_path / "inbox" / "raw"
    raw_dir.mkdir(parents=True)
    (raw_dir / "missing-url.md").write_text("---\ntitle: Missing Source\n---\nSome captured article body.\n" * 3,
                                            encoding="utf-8")

    written = curate_from_raw(str(tmp_path), limit=1)

    assert len(written) == 1
    assert (tmp_path / "inbox" / "raw").exists()
    assert not any((raw_dir).iterdir()), "raw file should be moved after ingestion"
    processed = tmp_path / "inbox" / "processed-ok"
    processed_files = list(processed.glob("*.md"))
    assert len(processed_files) == 1
    assert "source_url: \"file://" in written[0].read_text(encoding="utf-8")


def test_render_curation_note_includes_source_metadata_and_why_it_matters():
    note = CuratedNote(
        title="Metadata Note",
        status="curated",
        confidence="high",
        temporal_relevance="current",
        source_url="https://example.com/article",
        source_metadata={
            "author": "Test Author",
            "publishedDate": "2026-05-25",
            "topics": ["one", "two"],
        },
        raw_source="/inbox/raw/example.md",
        captured_at="2026-05-26T12:34:56Z",
        reviewed_at="2026-05-26T12:40:00Z",
        why_it_matters="Retention note for downstream synthesis.",
        source_content="Meaningful content.",
    )

    markdown = render_curation_note(note)
    assert 'source_author: "Test Author"' in markdown
    assert "source_topics:" in markdown
    assert "- one" in markdown
    assert "why_it_matters: \"Retention note for downstream synthesis.\"" in markdown
