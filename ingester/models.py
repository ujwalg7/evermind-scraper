from __future__ import annotations

from dataclasses import dataclass
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Literal, Optional

IngestionStatus = Literal["curated", "needs-review", "rejected"]
CuratedFormat = Literal["atomic-takeaways", "structured-brief", "minimal-digest"]
ConfidenceLevel = Literal["low", "medium", "high"]
TemporalRelevance = Literal["stable", "current", "volatile"]


class ImageDecision(BaseModel):
  source_url: str = Field(..., min_length=1)
  action: Literal["keep", "skip", "downloaded"] = "keep"
  local_path: Optional[str] = None


class QCDecision(BaseModel):
  status: IngestionStatus
  reasons: List[str] = Field(default_factory=list)
  confidence: ConfidenceLevel = "medium"
  capture_status: Literal["complete", "partial", "needs_review"] = "partial"
  temporal_relevance: TemporalRelevance = "current"
  image_decisions: List[ImageDecision] = Field(default_factory=list)


class CuratedNote(BaseModel):
  title: str = Field(min_length=1)
  status: IngestionStatus
  format: CuratedFormat = "atomic-takeaways"
  confidence: ConfidenceLevel
  temporal_relevance: TemporalRelevance
  source_url: str = Field(min_length=1)
  source_metadata: Dict[str, Any] = Field(default_factory=dict)
  raw_source: str
  captured_at: str
  reviewed_at: str
  related: List[str] = Field(default_factory=list)
  supersedes: List[str] = Field(default_factory=list)
  contradicts: List[str] = Field(default_factory=list)
  tags: List[str] = Field(default_factory=list)
  source_content: str = ""
  why_it_matters: Optional[str] = None


@dataclass(frozen=True)
class RawCapture:
  path: str
  title: str
  source_url: str
  source_content: str
  capture_status: Literal["complete", "partial", "needs_review"]
  captured_at: str = ""
  fingerprint: Optional[str] = None
  raw_frontmatter: Optional[Dict[str, object]] = None
