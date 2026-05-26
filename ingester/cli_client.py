from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional


class EvermindCLIError(RuntimeError):
  pass


class EvermindCliClient:
  def __init__(self, cli_path: Optional[str] = None):
    self.cli_path = cli_path or self._discover_cli_path()

  def _discover_cli_path(self) -> str:
    configured = os.getenv("EVERMIND_CLI_PATH")
    if configured:
      return configured

    repo_root = Path(__file__).resolve().parents[1]
    bin_cli = repo_root / "bin/evermind"
    if bin_cli.exists():
      return str(bin_cli)

    dist_cli = repo_root / "dist" / "src" / "cli.js"
    if dist_cli.exists():
      return f"node {dist_cli}"

    fallback = repo_root / "bin" / "evermind"
    return str(fallback)

  def _normalize_command(self) -> list[str]:
    if self.cli_path.startswith("node "):
      return self.cli_path.split(" ")
    return [self.cli_path]

  def extract(self, url: str, tier: Optional[int] = None) -> Dict[str, Any]:
    cmd = self._normalize_command() + ["extract", url, "--json"]
    if tier:
      cmd.extend(["-t", str(tier)])

    try:
      result = subprocess.run(
        cmd,
        cwd=Path.cwd(),
        capture_output=True,
        text=True,
        env=None,
        check=False
      )
    except FileNotFoundError as exc:
      raise EvermindCLIError(f"Could not launch evermind CLI at '{self.cli_path}': {exc}") from exc

    if result.returncode != 0:
      raise EvermindCLIError(result.stderr.strip() or "evermind extract command failed")

    output = result.stdout.strip()
    if not output:
      raise EvermindCLIError("empty output from evermind extract")

    payload = json.loads(output)
    if not isinstance(payload, dict) or "note" not in payload:
      raise EvermindCLIError("unexpected extraction payload format")
    return payload
