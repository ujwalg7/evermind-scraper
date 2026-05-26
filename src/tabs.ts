import { spawn } from 'child_process';

export interface ChromeTab {
  url: string;
  title: string;
  pinned: boolean;
  windowIndex: number;
  tabIndex: number;
}

/**
 * Executes macOS AppleScript to retrieve all open Google Chrome tabs.
 */
export function getChromeTabs(): Promise<ChromeTab[]> {
  return new Promise((resolve, reject) => {
    // Only works on macOS
    if (process.platform !== 'darwin') {
      reject(new Error('Chrome tab ingestion is only supported on macOS (requires AppleScript).'));
      return;
    }

    const CHROME_TABS_APPLESCRIPT = `
tell application "Google Chrome"
    if not (exists window 1) then
        return ""
    end if
    set tabInfo to ""
    set winIndex to 1
    repeat with win in every window
        try
            set tabIndex to 1
            repeat with t in every tab of win
                set tabInfo to tabInfo & winIndex & "|||" & tabIndex & "|||false|||" & (URL of t) & "|||" & (title of t) & "\n"
                set tabIndex to tabIndex + 1
            end repeat
        end try
        set winIndex to winIndex + 1
    end repeat
    return tabInfo
end tell
`;

    const child = spawn('osascript');
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`AppleScript exited with code ${code}. Error: ${stderr.trim()}`));
        return;
      }

      const tabs: ChromeTab[] = [];
      const lines = stdout.split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('|||');
        if (parts.length >= 5) {
          const windowIndex = parseInt(parts[0].trim(), 10);
          const tabIndex = parseInt(parts[1].trim(), 10);
          const pinned = parts[2].trim().toLowerCase() === 'true';
          const url = parts[3].trim();
          const title = parts.slice(4).join('|||').trim();
          
          // Skip empty or browser internal urls
          if (
            url && 
            !url.startsWith('chrome://') && 
            !url.startsWith('chrome-extension://') &&
            url !== 'about:blank'
          ) {
            tabs.push({ url, title, pinned, windowIndex, tabIndex });
          }
        }
      }
      resolve(tabs);
    });

    child.stdin.write(CHROME_TABS_APPLESCRIPT);
    child.stdin.end();
  });
}

/**
 * Close a specific Chrome tab by URL and title inside a given window index.
 */
export function closeChromeTab(windowIndex: number, url: string, title: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new Error('Chrome tab closing is only supported on macOS (requires AppleScript).'));
      return;
    }

    const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
on run argv
    set targetWindowIndex to item 1 of argv as integer
    set targetURL to item 2 of argv
    set targetTitle to item 3 of argv
    tell application "Google Chrome"
        if not (exists window targetWindowIndex) then
            return "not_found"
        end if
        set win to window targetWindowIndex
        repeat with t in every tab of win
            if (URL of t as text) is targetURL then
                if targetTitle is "" or (title of t as text) is targetTitle then
                    close t
                    return "closed"
                end if
            end if
        end repeat
        return "not_found"
    end tell
end run
`;

    const child = spawn('osascript', ['-l', 'AppleScript', '-e', script, String(windowIndex), escapedUrl, escapedTitle]);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`AppleScript exited with code ${code}. Error: ${stderr.trim()}`));
        return;
      }

      resolve(stdout.trim() === 'closed');
    });
  });
}
