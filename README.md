# Evermind: Durable Article-to-Obsidian Pipeline

**Evermind** is a robust, low-maintenance, zero-cost-by-default capture engine designed to clip articles and save them to your Obsidian vault as rich Markdown notes with localized images. 

It implements a **fallback ladder** that prioritizes local or free public endpoints, escalating through multiple tiers before using paid APIs, with zero dependencies on LLMs.

---

## 🚀 Key Features

*   **Extraction Fallback Ladder**:
    *   **Tier 2 (Deterministic Raw HTML)**: Uses `@mozilla/readability` to extract clean layouts for free.
    *   **Tier 3 (Playwright Rendered DOM)**: Launches headless Chromium to render JavaScript-heavy or dynamic pages if Tier 2 fails.
    *   **Tier 4 (Crawl4AI)**: Optional Python fallback (`crawl4ai`) used when available.
    *   **Tier 5 (Jina Reader API)**: 100% free proxy fallback (`https://r.jina.ai`) that yields clean Markdown content.
    *   **Tier 6 (Exa Contents API)**: Optional fallback that queries the Exa Contents API if Tier 5 fails and an API key is configured.
*   **Image Localization & CDN Hardening**: Automatically downloads remote images, stores them locally, and rewrites markdown URLs. Features a rate-limit retry engine with exponential backoff, request pacing delays, referer setting, and date-aware `Retry-After` header parsing to bypass CDN rate limits.
*   **Clear Provenance & Confidence Logging**: Every capture logs extraction tier, confidence, fingerprint (SHA-256), and image statuses in YAML frontmatter. Low-confidence captures are labeled `"partial"` and prepended with a review callout banner.
*   **Obsidian Web Clipper Watcher**: Monitors your Obsidian vault recursively. When you clip a note using the browser extension, the watcher daemon automatically localizes all images instantly.
*   **Batch Ingest Chrome Tabs**: Ingests and processes all currently open tabs in Google Chrome (macOS only).
*   **Single-Binary CLI**: Standalone executables compiled for **macOS** and **Linux ARM64** (aarch64).
*   **Machine-readable extraction output**: New `extract` and `clip --json` command modes emit structured payloads for automation.

---

## 🛠️ Installation & Setup

### 1. Precompiled Binaries
You can download the compiled binaries directly from the Github Releases section:
*   `bin/evermind` for macOS.
*   `bin/evermind-linux-arm64` for Linux ARM64 (Ubuntu 24 slim).

### 2. Browser Setup
To initialize Playwright's local Chromium browser dependency for Tier 3:
```bash
./bin/evermind setup
```

### 3. Environment Variables
Add these keys to your shell profile or a `.env` file in your workspace:
```bash
# Required for Obsidian vault location
export OBSIDIAN_VAULT_PATH="/Users/yourname/Documents/Obsidian Vault"

# Optional: Required if you want to use Tier 6 Exa Contents API fallback
export EXA_API_KEY="your-exa-api-key"

# Optional: Customize path/env knobs used by the TS CLI and ingester
export EVERMIND_INBOX_SUBDIR="inbox/raw"
export EVERMIND_ATTACHMENTS_SUBDIR="attachments/evermind"
export EVERMIND_THRESHOLD="0.6"
export EVERMIND_CLI_PATH="/Users/yourname/Dev/evermind-scraper/bin/evermind"

# Optional: Python ingester + LLM settings.
# Prefer PydanticAI provider-prefixed model names.
export EVERMIND_INGESTER_LLM_MODEL="openai:gpt-4o-mini"
export OPENAI_API_KEY="your-openai-api-key"

# Other examples:
# export EVERMIND_INGESTER_LLM_MODEL="anthropic:claude-3-5-haiku-latest"
# export ANTHROPIC_API_KEY="your-anthropic-api-key"
# export EVERMIND_INGESTER_LLM_MODEL="openrouter:google/gemini-3-pro-preview"
# export OPENROUTER_API_KEY="your-openrouter-api-key"
```

---

## 💻 CLI Commands

### 1. Clip a Single URL
Clips an article using the fallback ladder and downloads images:
```bash
./bin/evermind clip https://example.com/article
```
*   Force a specific extraction tier: `-t <2|3|4|5|6>`
*   Customize target folders: `--vault <path>`, `--inbox <subdir>`, `--attachments <subdir>`
*   Return JSON payload: `--json`

### 1b. Extract Only
Run extraction only with machine-readable output:
```bash
./bin/evermind extract https://example.com/article --json
```

### 1c. Crawl4AI Setup (Optional)
Install `crawl4ai` if you want Tier 4 to run as a fallback:
```bash
python3 -m pip install crawl4ai
```

### 2. Ingest Open Chrome Tabs (macOS)
Clips all active tabs in Chrome. Catches single-tab failures gracefully:
```bash
./bin/evermind clip-tabs
```
*   Filter by domain: `clip-tabs -d infoworld.com,medium.com` (only clips tabs matching these domains).

### 3. Start the Vault Watcher Daemon
Starts a background folder watcher that automatically post-processes new files created by the browser extension:
```bash
./bin/evermind watch
```

### 4. Manual Vault Post-Processing
Scans existing notes in the vault, downloads all remote image URLs, and updates links:
```bash
./bin/evermind post-process
```

## 🧠 Python Ingester

Ingest raw notes from the vault and write structured output under `curated/`, `needs-review/`, or `rejected/` directories.

Run:
```bash
cd /Users/yourname/Dev/evermind-scraper
python3 -m ingester curate --vault "$OBSIDIAN_VAULT_PATH" --limit 10
```

Optional flags:
* `--raw-subdir` default `inbox/raw`
* `--reextract` to force `evermind extract --json` for each source URL
* `--synthesize` to run optional PydanticAI synthesis after deterministic QC

Install ingester dependencies:
```bash
python3 -m pip install -r ingester/requirements.txt
```

---

## 📁 Repository Structure
*   `src/cli.ts` — Command parser and controller.
*   `src/extractor.ts` — Multi-tier fallback ladder orchestrator.
*   `src/images.ts` — Image scraper, downloader, and link rewriter.
*   `src/tabs.ts` — macOS AppleScript Chrome tab scraper.
*   `src/watcher.ts` — Debounced vault filesystem watcher.
*   `src/vault.ts` — Vault I/O, formatting, and directory scanners.
*   `ingester/` — PydanticAI-backed ingestion pipeline that classifies raw captures into curated/needs-review/rejected notes.
*   `tests/pipeline.test.ts` — TypeScript extractor + pipeline tests.
*   `ingester/tests/test_qc_and_writer.py` — Deterministic Python QC/writer tests.

---

## 🤖 Automated CI/CD Releases
We use **GitHub Actions** to automate our build pipeline. When you push a new release tag (e.g. `v1.0.0`), a runner will automatically:
1. Set up the Node environment.
2. Install dependencies.
3. Execute the automated test suite.
4. Cross-compile binaries for both macOS and Linux ARM64.
5. Create a GitHub Release and upload `evermind` and `evermind-linux-arm64` assets.
