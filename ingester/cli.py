from __future__ import annotations

import argparse
import os
from pathlib import Path

from .pipeline import curate_from_raw


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Ingest Evermind raw notes into curated/needs-review/rejected notes.")
  subparsers = parser.add_subparsers(dest="command", required=True)

  curate_parser = subparsers.add_parser("curate", help="Promote raw notes to curated buckets")
  curate_parser.add_argument("--vault", default="", help="Vault root directory")
  curate_parser.add_argument("--raw-subdir", default="inbox/raw", help="Raw notes source directory under vault (default: inbox/raw)")
  curate_parser.add_argument("--limit", type=int, default=None, help="Maximum number of raw notes to process")
  curate_parser.add_argument("--reextract", action="store_true", help="Re-run extraction through the evermind CLI for source URLs")
  curate_parser.add_argument(
    "--synthesize",
    action="store_true",
    help="Run optional LLM synthesis for accepted entries via PydanticAI"
  )
  curate_parser.set_defaults(command_handler="curate")

  parser.add_argument("--version", action="store_true", help="Print version and exit")
  return parser


def get_vault_path(cli_vault: str) -> Path:
  if cli_vault:
    return Path(cli_vault).expanduser()
  env_path = os.getenv("OBSIDIAN_VAULT_PATH", "")
  if env_path:
    return Path(env_path).expanduser()
  return Path.cwd()


def main() -> None:
  parser = build_parser()
  args = parser.parse_args()

  if args.version:
    print("evermind-ingester/0.1.0")
    return

  if getattr(args, "command", None) != "curate":
    parser.print_help()
    raise SystemExit(1)

  vault_path = get_vault_path(args.vault)
  written = curate_from_raw(
    vault_path=str(vault_path),
    raw_subdir=args.raw_subdir,
    limit=args.limit,
    reextract=args.reextract,
    synthesis=args.synthesize,
  )

  for path in written:
    print(path)

if __name__ == "__main__":
  main()
