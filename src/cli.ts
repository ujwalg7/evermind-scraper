#!/usr/bin/env ts-node
import { Command } from 'commander';
import { loadConfig } from './config';
import {
  runExtractionPipeline,
  extractTier2,
  extractTier3,
  extractTier4,
  extractTier5,
  extractTier6,
  toCliExtractionOutput
} from './extractor';
import { localizeImages } from './images';
import { writeNoteToVault, postProcessVault } from './vault';
import { CanonicalNote } from './types';
import { getChromeTabs } from './tabs';
import { watchVault } from './watcher';
import { execSync } from 'child_process';

const program = new Command();

program
  .name('evermind')
  .description('Durable article-to-Obsidian capture engine with free fallback ladder')
  .version('1.0.0');

function formatExtractionOutput(url: string, note: CanonicalNote, tierUsed = note.tierUsed || 0) {
  return toCliExtractionOutput(url, { ...note, tierUsed });
}

async function runWithStdoutRedirect<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  if (!enabled) {
    return fn();
  }

  const originalLog = console.log;
  console.log = (...args: any[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

async function getNoteByTier(url: string, tier: number, config: any): Promise<{ note: CanonicalNote; tierUsed: number }> {
  switch (tier) {
    case 2: {
      const note = await extractTier2(url, config.fallbackThreshold);
      return { note, tierUsed: 2 };
    }
    case 3: {
      const note = await extractTier3(url, config.fallbackThreshold);
      return { note, tierUsed: 3 };
    }
    case 4: {
      const note = await extractTier4(url);
      return { note, tierUsed: 4 };
    }
    case 5: {
      const note = await extractTier5(url, config.fallbackThreshold);
      return { note, tierUsed: 5 };
    }
    case 6: {
      if (!config.exaApiKey) {
        throw new Error('Exa API key is required to force Tier 6');
      }
      const note = await extractTier6(url, config.exaApiKey, config.fallbackThreshold);
      return { note, tierUsed: 6 };
    }
    default:
      throw new Error(`Invalid tier forced: ${tier}`);
  }
}

program
  .command('clip')
  .description('Clip an article URL into your Obsidian inbox via the fallback ladder')
  .argument('<url>', 'URL of the article to clip')
  .option('-v, --vault <path>', 'Override target Obsidian vault path')
  .option('-i, --inbox <subdir>', 'Override target inbox subdirectory (default: inbox/raw)')
  .option('-a, --attachments <subdir>', 'Override attachments subdirectory (default: attachments/evermind)')
  .option('--json', 'Emit machine-readable JSON output')
  .option('-t, --tier <number>', 'Force a specific extraction tier (2: Raw HTML, 3: Playwright, 4: Crawl4AI, 5: Jina, 6: Exa)')
  .action(async (url, options) => {
    try {
      const config = loadConfig();

      // CLI overrides
      if (options.vault) config.vaultPath = options.vault;
      if (options.inbox) config.inboxSubdir = options.inbox;
      if (options.attachments) config.attachmentsSubdir = options.attachments;

      let note: CanonicalNote;
      let tierUsed = 0;
      const jsonMode = Boolean(options.json);

      const extraction = await runWithStdoutRedirect(jsonMode, async () => {
        let extractedNote: CanonicalNote;
        let extractedTier = 0;

        // Extract based on explicit tier request or ladder
        if (options.tier) {
          const tier = parseInt(options.tier);
          if (!jsonMode) {
            console.log(`[CLI] Forcing Tier ${tier} extraction...`);
          }
          const tierResult = await getNoteByTier(url, tier, config);
          extractedNote = tierResult.note;
          extractedTier = tierResult.tierUsed;
        } else {
          const result = await runExtractionPipeline(url, config);
          extractedNote = result.note;
          extractedTier = result.tierUsed;
        }

        // Localize Images
        extractedNote = await localizeImages(extractedNote, config.vaultPath, config.attachmentsSubdir);

        // Write to vault inbox
        const writtenPath = await writeNoteToVault(extractedNote, config.vaultPath, config.inboxSubdir);
        return { extractedNote, extractedTier, writtenPath };
      });

      note = extraction.extractedNote;
      tierUsed = extraction.extractedTier;
      const finalPath = extraction.writtenPath;
      
      const localCount = note.images.filter(img => img.status === 'downloaded').length;
      const failedCount = note.images.filter(img => img.status === 'failed').length;
      const skippedCount = note.images.filter(img => img.status === 'skipped').length;

      if (jsonMode) {
        const payload = formatExtractionOutput(url, note, tierUsed);
        (payload as any).inboxPath = finalPath;
        (payload as any).imageSummary = {
          downloaded: localCount,
          failed: failedCount,
          skipped: skippedCount
        };
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log('--- Evermind Clip Start ---');
        console.log(`Vault Path: ${config.vaultPath}`);
        console.log(`Inbox Directory: ${config.inboxSubdir}`);
        console.log(`Attachments Subdir: ${config.attachmentsSubdir}`);
        console.log(`[CLI] Content extracted (Tier ${tierUsed}). Confidence: ${note.confidenceScore.toFixed(2)}, Status: ${note.captureStatus}`);
        console.log('\n--- Capture Summary ---');
        console.log(`Saved Path:      ${finalPath}`);
        console.log(`Extraction Tier: Tier ${tierUsed}`);
        console.log(`Capture Status:  ${note.captureStatus.toUpperCase()}`);
        console.log(`Confidence:      ${note.confidenceScore.toFixed(2)}`);
        console.log(`Fingerprint:     ${note.fingerprint}`);
        console.log(`Images Localized: ${localCount} downloaded, ${failedCount} failed, ${skippedCount} skipped`);
        if (note.extractionError) {
          console.log(`Extraction Warning: ${note.extractionError}`);
        }
        console.log('------------------------\n');
        console.log('--- Evermind Clip Complete ---');
      }
    } catch (err: any) {
      console.error(`[CLI Error] Clip failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('extract')
  .description('Run extraction only and return machine-readable output')
  .argument('<url>', 'URL of the article to extract')
  .option('--json', 'Emit machine-readable JSON output (default)')
  .option('-t, --tier <number>', 'Force a specific extraction tier (2: Raw HTML, 3: Playwright, 4: Crawl4AI, 5: Jina, 6: Exa)')
  .action(async (url, options) => {
    try {
      const config = loadConfig();
      let note: CanonicalNote;
      let tierUsed = 0;

      const jsonMode = options.json !== false;
      const extraction = await runWithStdoutRedirect(jsonMode, async () => {
        if (options.tier) {
          const tier = parseInt(options.tier);
          return getNoteByTier(url, tier, config);
        }
        return runExtractionPipeline(url, config);
      });
      note = extraction.note;
      tierUsed = extraction.tierUsed;

      const payload = formatExtractionOutput(url, { ...note, tierUsed }, tierUsed);
      if (!jsonMode) {
        console.log(`Source URL: ${url}`);
        console.log(`Tier: ${payload.tierUsed}`);
        console.log(`Capture Status: ${note.captureStatus}`);
        console.log(`Confidence: ${note.confidenceScore.toFixed(2)}`);
        console.log(`Title: ${note.title}`);
        console.log(`Fingerprint: ${note.fingerprint}`);
        console.log('');
        console.log(note.contentMarkdown.slice(0, 600));
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
    } catch (err: any) {
      console.error(`[CLI Error] Extract failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('clip-tabs')
  .description('Clip all open tabs in Google Chrome (macOS only)')
  .option('-v, --vault <path>', 'Override target Obsidian vault path')
  .option('-i, --inbox <subdir>', 'Override target inbox subdirectory (default: inbox/raw)')
  .option('-a, --attachments <subdir>', 'Override attachments subdirectory')
  .option('-d, --domain-filter <domains>', 'Comma-separated domains to match (e.g. infoworld.com,medium.com)')
  .option('-l, --limit <number>', 'Maximum number of unpinned tabs to process', '10')
  .option('--include-pinned', 'Include pinned tabs in the batch')
  .action(async (options) => {
    try {
      const config = loadConfig();

      if (options.vault) config.vaultPath = options.vault;
      if (options.inbox) config.inboxSubdir = options.inbox;
      if (options.attachments) config.attachmentsSubdir = options.attachments;

      console.log('--- Evermind Ingest Chrome Tabs Start ---');
      const tabs = await getChromeTabs();
      console.log(`[CLI] Found ${tabs.length} open tab(s) in Chrome.`);

      let filteredTabs = tabs;
      if (options.domainFilter) {
        const allowedDomains = options.domainFilter.split(',').map((d: string) => d.trim().toLowerCase());
        filteredTabs = tabs.filter(tab => {
          try {
            const hostname = new URL(tab.url).hostname.toLowerCase();
            return allowedDomains.some((d: string) => hostname.includes(d));
          } catch {
            return false;
          }
        });
        console.log(`[CLI] Filtering by domains [${options.domainFilter}]: processing ${filteredTabs.length} matching tab(s).`);
      }

      if (!options.includePinned) {
        filteredTabs = filteredTabs.filter(tab => !tab.pinned);
        console.log(`[CLI] Skipping pinned tabs: processing ${filteredTabs.length} unpinned tab(s).`);
      }

      const limit = Math.max(1, parseInt(options.limit, 10) || 10);
      filteredTabs = filteredTabs.slice(0, limit);
      console.log(`[CLI] Limiting batch to first ${filteredTabs.length} tab(s).`);

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < filteredTabs.length; i++) {
        const tab = filteredTabs[i];
        console.log(`\n[Batch ${i + 1}/${filteredTabs.length}] Processing: "${tab.title}" (${tab.url})`);
        
        try {
          // 1. Core Extraction
          const result = await runExtractionPipeline(tab.url, config);
          let note = result.note;
          
          // 2. Localize Images
          note = await localizeImages(note, config.vaultPath, config.attachmentsSubdir);
          
          // 3. Write
          await writeNoteToVault(note, config.vaultPath, config.inboxSubdir);
          successCount++;
        } catch (err: any) {
          console.error(`[Batch Error] Failed to process tab "${tab.title}": ${err.message}`);
          failCount++;
        }
      }

      console.log('\n--- Ingestion Batch Complete ---');
      console.log(`Success: ${successCount} note(s) clipped.`);
      console.log(`Failed: ${failCount} note(s).`);
      console.log('---------------------------------');
    } catch (err: any) {
      console.error(`[CLI Error] Batch clip failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('post-process')
  .description('Scan the vault for external images, download them locally, and rewrite notes')
  .option('-v, --vault <path>', 'Override Obsidian vault path')
  .option('-a, --attachments <subdir>', 'Override attachments subdirectory')
  .action(async (options) => {
    try {
      const config = loadConfig();

      // CLI overrides
      if (options.vault) config.vaultPath = options.vault;
      if (options.attachments) config.attachmentsSubdir = options.attachments;

      console.log('--- Evermind Post-Process Start ---');
      await postProcessVault(config.vaultPath, config.attachmentsSubdir);
      console.log('--- Evermind Post-Process Complete ---');
    } catch (err: any) {
      console.error(`[CLI Error] Post-process failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Start a background watch daemon to automatically localize images in new notes')
  .option('-v, --vault <path>', 'Override Obsidian vault path')
  .option('-a, --attachments <subdir>', 'Override attachments subdirectory')
  .action(async (options) => {
    try {
      const config = loadConfig();

      if (options.vault) config.vaultPath = options.vault;
      if (options.attachments) config.attachmentsSubdir = options.attachments;

      console.log('--- Evermind Watch Daemon Start ---');
      watchVault(config.vaultPath, config.attachmentsSubdir);
    } catch (err: any) {
      console.error(`[CLI Error] Watch failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Verify browser dependencies and install Playwright Chromium')
  .action(() => {
    try {
      console.log('[Setup] Verifying and installing Chromium browser binary for Playwright...');
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      console.log('[Setup] Playwright Chromium setup completed successfully.');
    } catch (err: any) {
      console.error(`[Setup Error] Failed to configure browser binary: ${err.message}`);
      process.exit(1);
    }
  });

// Execute the command parser
program.parse(process.argv);
