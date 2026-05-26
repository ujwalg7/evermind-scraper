#!/usr/bin/env ts-node
import { Command } from 'commander';
import { loadConfig } from './config';
import { runExtractionPipeline, extractTier2, extractTier3, extractTier4, extractTier5 } from './extractor';
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

program
  .command('clip')
  .description('Clip an article URL into your Obsidian inbox via the fallback ladder')
  .argument('<url>', 'URL of the article to clip')
  .option('-v, --vault <path>', 'Override target Obsidian vault path')
  .option('-i, --inbox <subdir>', 'Override target inbox subdirectory (default: inbox/raw)')
  .option('-a, --attachments <subdir>', 'Override attachments subdirectory (default: attachments/evermind)')
  .option('-t, --tier <number>', 'Force a specific extraction tier (2: Raw HTML, 3: Playwright, 4: Jina Reader, 5: Exa)')
  .action(async (url, options) => {
    try {
      const config = loadConfig();

      // CLI overrides
      if (options.vault) config.vaultPath = options.vault;
      if (options.inbox) config.inboxSubdir = options.inbox;
      if (options.attachments) config.attachmentsSubdir = options.attachments;

      console.log('--- Evermind Clip Start ---');
      console.log(`Vault Path: ${config.vaultPath}`);
      console.log(`Inbox Directory: ${config.inboxSubdir}`);
      console.log(`Attachments Subdir: ${config.attachmentsSubdir}`);

      let note: CanonicalNote;
      let tierUsed = 0;

      // Extract based on tier choice
      if (options.tier) {
        const tier = parseInt(options.tier);
        console.log(`[CLI] Forcing Tier ${tier} extraction...`);
        if (tier === 2) {
          note = await extractTier2(url, config.fallbackThreshold);
          tierUsed = 2;
        } else if (tier === 3) {
          note = await extractTier3(url, config.fallbackThreshold);
          tierUsed = 3;
        } else if (tier === 4) {
          note = await extractTier4(url);
          tierUsed = 4;
        } else if (tier === 5) {
          if (!config.exaApiKey) {
            throw new Error('Exa API key is required to force Tier 5');
          }
          note = await extractTier5(url, config.exaApiKey);
          tierUsed = 5;
        } else {
          throw new Error(`Invalid tier forced: ${options.tier}`);
        }
        note.tierUsed = tierUsed;
      } else {
        const result = await runExtractionPipeline(url, config);
        note = result.note;
        tierUsed = result.tierUsed;
      }

      console.log(`[CLI] Content extracted (Tier ${tierUsed}). Confidence: ${note.confidenceScore.toFixed(2)}, Status: ${note.captureStatus}`);

      // Localize Images
      note = await localizeImages(note, config.vaultPath, config.attachmentsSubdir);

      // Write to vault inbox
      const finalPath = await writeNoteToVault(note, config.vaultPath, config.inboxSubdir);
      
      const localCount = note.images.filter(img => img.status === 'downloaded').length;
      const failedCount = note.images.filter(img => img.status === 'failed').length;
      const skippedCount = note.images.filter(img => img.status === 'skipped').length;

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
    } catch (err: any) {
      console.error(`[CLI Error] Clip failed: ${err.message}`);
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
