from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

from .models import QCDecision

LOW_QUALITY_PATTERNS = [
    "checking your browser before accessing",
    "please solve the captcha",
  "cookie wall",
  "accept all cookies",
  "subscribe to read",
    "register to read",
  "sign in to continue",
    "create an account to read",
    "continue reading with a digital subscription",
    "please verify you are human",
    "verifying your browser",
    "not authorized",
    "access denied",
]


def classify_capture_quality(
  title: str,
  source_url: str,
  content: str,
  capture_status: str,
) -> QCDecision:
  reason_list: List[str] = []

  if not source_url:
    return QCDecision(
      status="rejected",
      confidence="low",
      capture_status="needs_review",
      reasons=["Missing source URL."],
      temporal_relevance="current"
    )

  normalized_text = (title + " " + source_url + " " + content).lower()
  normalized_preview = normalized_text[:512]
  is_low_quality_shell = any(pattern in normalized_preview for pattern in LOW_QUALITY_PATTERNS)

  if not content.strip():
    return QCDecision(
      status="rejected",
      confidence="low",
      capture_status="needs_review",
      reasons=["No extracted body content."],
      temporal_relevance="current"
    )

  words = re.findall(r"\w+", content.lower())
  if is_low_quality_shell:
    reason_list.append(
        "Detected a potential paywall/cookie wall/captcha/security shell signal."
    )
  if len(words) < 60:
      reason_list.append("Article body is very short and may be incomplete.")
      is_low_quality_shell = True

  if is_low_quality_shell:
    return QCDecision(
      status="needs-review",
      confidence="low",
      capture_status=capture_status,
      reasons=reason_list,
      temporal_relevance="current"
    )

  if len(words) > 800 and not is_low_quality_shell:
    confidence = "high"
  elif len(words) > 240 and not is_low_quality_shell:
    confidence = "medium"
  else:
    confidence = "low"

  return QCDecision(
    status="curated",
    confidence=confidence,
    capture_status=capture_status,
    reasons=reason_list,
    temporal_relevance="current"
  )


def derive_review_tags(qc: QCDecision) -> List[str]:
  tags = ["evermind", qc.status.replace("-", "_")]
  if qc.confidence == "high":
    tags.append("high-confidence")
  if qc.temporal_relevance == "volatile":
    tags.append("volatile")
  return tags
