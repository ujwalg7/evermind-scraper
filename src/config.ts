import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Config } from './types';

// Load .env from workspace or user home dir
dotenv.config();

const DEFAULT_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const DEFAULT_INBOX_SUBDIR = process.env.EVERMIND_INBOX_SUBDIR || 'inbox/raw';
const DEFAULT_ATTACHMENTS_SUBDIR = process.env.EVERMIND_ATTACHMENTS_SUBDIR || 'attachments/evermind';
const DEFAULT_THRESHOLD = parseFloat(process.env.EVERMIND_THRESHOLD || '0.6');

export function loadConfig(): Config {
  let vaultPath = DEFAULT_VAULT_PATH;
  
  if (!vaultPath) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const potentialPaths = [
      path.join(homeDir, 'Documents', 'Obsidian Vault'),
      path.join(homeDir, 'Obsidian'),
      path.join(process.cwd(), 'vault')
    ];
    for (const p of potentialPaths) {
      if (fs.existsSync(p)) {
        vaultPath = p;
        break;
      }
    }
  }

  if (!vaultPath) {
    vaultPath = process.cwd();
  }

  return {
    vaultPath: path.resolve(vaultPath),
    inboxSubdir: DEFAULT_INBOX_SUBDIR,
    attachmentsSubdir: DEFAULT_ATTACHMENTS_SUBDIR,
    exaApiKey: process.env.EXA_API_KEY,
    fallbackThreshold: isNaN(DEFAULT_THRESHOLD) ? 0.6 : DEFAULT_THRESHOLD
  };
}
