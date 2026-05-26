import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as extractor from '../src/extractor';
import { formatNoteMarkdown, writeNoteToVault } from '../src/vault';
import { localizeImages } from '../src/images';
import { CanonicalNote } from '../src/types';
import axios from 'axios';
import { chromium } from 'playwright';

const {
  parseHtml,
  isLikelyLowQualityCapture,
  parseMarkdownMetadata,
  extractTier5,
  extractTier6,
  toCliExtractionOutput,
  runExtractionPipeline
} = extractor;

describe('Article-to-Obsidian Pipeline Tests', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  // Test 1: Deterministic Article Parsing
  it('should parse a standard article fixture with high confidence and clean structure', () => {
    const htmlPath = path.join(fixturesDir, 'simple-article.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    
    const note = parseHtml(html, 'https://example.com/article.html', 0.6);

    // Metadata validation
    assert.strictEqual(note.title, 'Simple Mock Article');
    assert.strictEqual(note.author, 'John Doe');
    assert.strictEqual(note.publishedDate, '2026-05-26');
    assert.strictEqual(note.heroImageUrl, 'https://example.com/hero.jpg');
    assert.ok(note.confidenceScore > 0.6);
    assert.strictEqual(note.captureStatus, 'complete');
    assert.ok(note.fingerprint.length > 0);

    // Structure preservation validation
    // Code blocks with language
    assert.ok(note.contentMarkdown.includes('```js'));
    assert.ok(note.contentMarkdown.includes("const test = () => { console.log('hello'); };"));
    
    // Blockquotes
    assert.ok(note.contentMarkdown.includes('> "This is a blockquote that must be formatted correctly in Markdown."'));
    
    // Figcaptions
    assert.ok(note.contentMarkdown.includes('*Caption: Figure 1: Main block architecture*'));
    
    // Headings
    assert.ok(note.headings.includes('Test Subheading'));
  });

  // Test 2: Heuristic Paywall/Cookie Wall Quality Gate
  it('should flag paywalls/cookie walls and force confidence to 0 (partial capture)', () => {
    const htmlPath = path.join(fixturesDir, 'paywall-cookie.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    
    const note = parseHtml(html, 'https://example.com/paywall-page', 0.6);

    assert.strictEqual(note.confidenceScore, 0);
    assert.strictEqual(note.captureStatus, 'partial');
  });

  // Test 3: Provenance Metadata Formatting
  it('should serialize comprehensive YAML frontmatter provenance', () => {
    const mockNote: CanonicalNote = {
      title: 'Test Provenance Title',
      sourceUrl: 'https://example.com/source',
      author: 'Test Author',
      publishedDate: '2026-05-25',
      contentMarkdown: 'Mock Content Body.',
      headings: ['Test Header'],
      images: [
        { originalUrl: 'https://example.com/img1.jpg', localPath: 'attachments/evermind/img1.jpg', status: 'downloaded' },
        { originalUrl: 'https://example.com/img2.jpg', status: 'failed' }
      ],
      confidenceScore: 0.95,
      captureStatus: 'complete',
      fingerprint: 'sha256-mockhash123'
    };

    const formatted = formatNoteMarkdown(mockNote);
    
    // Ensure all metadata fields are present
    assert.ok(formatted.includes('title: "Test Provenance Title"'));
    assert.ok(formatted.includes('source: "https://example.com/source"'));
    assert.ok(formatted.includes('author: "Test Author"'));
    assert.ok(formatted.includes('published: "2026-05-25"'));
    assert.ok(formatted.includes('extraction_tier: 2'));
    assert.ok(formatted.includes('confidence: 0.95'));
    assert.ok(formatted.includes('capture_status: "complete"'));
    assert.ok(formatted.includes('fingerprint: "sha256-mockhash123"'));
    
    // Ensure images statuses are logged
    assert.ok(formatted.includes('  - url: "https://example.com/img1.jpg"'));
    assert.ok(formatted.includes('    path: "attachments/evermind/img1.jpg"'));
    assert.ok(formatted.includes('    status: "downloaded"'));
    assert.ok(formatted.includes('  - url: "https://example.com/img2.jpg"'));
    assert.ok(formatted.includes('    status: "failed"'));
  });

  // Test 4: Capture-oriented Image Localization Failure Path
  it('should preserve original image URL in markdown body if downloading fails', async () => {
    const mockNote: CanonicalNote = {
      title: 'Note with Broken Image',
      sourceUrl: 'https://example.com/page',
      contentMarkdown: 'Broken image link here: ![Alt Image](https://invalid-domain.xyz/nonexistent.jpg)',
      headings: [],
      images: [{ originalUrl: 'https://invalid-domain.xyz/nonexistent.jpg', status: 'skipped' }],
      confidenceScore: 1.0,
      captureStatus: 'complete',
      fingerprint: 'mockfingerprint'
    };

    const localized = await localizeImages(
      mockNote,
      path.join(__dirname, 'mock_vault'),
      'attachments/evermind'
    );

    // Ensure status is marked as failed
    assert.strictEqual(localized.images[0].status, 'failed');
    
    // Ensure contentMarkdown was NOT broken and still contains original remote URL
    assert.ok(localized.contentMarkdown.includes('![Alt Image](https://invalid-domain.xyz/nonexistent.jpg)'));
    
    // Cleanup mock folders if created
    const mockVaultPath = path.join(__dirname, 'mock_vault');
    if (fs.existsSync(mockVaultPath)) {
      fs.rmSync(mockVaultPath, { recursive: true, force: true });
    }
  });

  // Test 5: Jina Reader Parser and Fallback
  it('should parse Jina Reader JSON response correctly', async () => {
    const originalGet = axios.get;
    const mockUrl = 'https://example.com/blog-post';
    const mockMarkdown = `# My Blog Post\n\nThis is a great article about AI.\n\n![AI Image](https://example.com/ai.png)\n\n## Subheading 1\nSome more text.\n\nThe page includes durable, practical details about model selection and reliability engineering practices.\n\n### Section 3\nMore context and actionable evidence. More context and actionable evidence.\n\nThe same concept is repeated several times to ensure this payload has enough word-count for a confident extraction result in testing.\n`.repeat(2);
    
    // Stub axios.get
    axios.get = (async (url: string, config?: any): Promise<any> => {
      assert.strictEqual(url, `https://r.jina.ai/${mockUrl}`);
      assert.deepStrictEqual(config?.headers, {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      return {
        data: {
          data: {
            title: 'My Blog Post',
            content: mockMarkdown
          }
        }
      };
    }) as any;

    try {
      const note = await extractTier5(mockUrl);
      assert.strictEqual(note.title, 'My Blog Post');
      assert.strictEqual(note.sourceUrl, mockUrl);
      assert.strictEqual(note.contentMarkdown, mockMarkdown);
      assert.deepStrictEqual(note.headings.slice(0, 2), ['My Blog Post', 'Subheading 1']);
      assert.deepStrictEqual(note.images, [
        { originalUrl: 'https://example.com/ai.png', status: 'skipped' }
      ]);
      assert.ok(note.confidenceScore >= 0.6);
      assert.strictEqual(note.captureStatus, 'complete');
      assert.ok(note.fingerprint.length > 0);
    } finally {
      // Restore original get
      axios.get = originalGet;
    }
  });

  // Test 6: Markdown Metadata Parser
  it('should parse markdown headings and images correctly via helper', () => {
    const markdown = `# H1\n\n## H2\n\n![Image 1](https://example.com/1.jpg)\n![Image 2](https://example.com/2.jpg)`;
    const parsed = parseMarkdownMetadata(markdown);
    
    assert.deepStrictEqual(parsed.headings, ['H1', 'H2']);
    assert.deepStrictEqual(parsed.images, [
      { originalUrl: 'https://example.com/1.jpg', status: 'skipped' },
      { originalUrl: 'https://example.com/2.jpg', status: 'skipped' }
    ]);
  });

  // Test 7: Exa API Parser and Fallback
  it('should parse Exa API JSON response correctly', async () => {
    const originalPost = axios.post;
    const mockUrl = 'https://example.com/exa-post';
    const mockMarkdown = `# Exa Article\n\nSome body text.\n\n![Exa Image](https://example.com/exa.png)\n\nThe article continues with concrete notes about architecture, tradeoffs, and deployment details.\n\nIt repeats key claims to guarantee stable extraction scoring and avoid short-capture classification.\n\n`.repeat(4);
    const mockApiKey = 'mock-exa-key';

    // Stub axios.post
    axios.post = (async (url: string, data?: any, config?: any): Promise<any> => {
      assert.strictEqual(url, 'https://api.exa.ai/contents');
      assert.deepStrictEqual(data, { urls: [mockUrl], text: true });
      assert.deepStrictEqual(config?.headers, {
        'x-api-key': mockApiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      return {
        data: {
          results: [{
            title: 'Exa Article',
            author: 'Jane Exa',
            publishedDate: '2026-05-25',
            text: mockMarkdown
          }]
        }
      };
    }) as any;

    try {
      const note = await extractTier6(mockUrl, mockApiKey);
      assert.strictEqual(note.title, 'Exa Article');
      assert.strictEqual(note.sourceUrl, mockUrl);
      assert.strictEqual(note.author, 'Jane Exa');
      assert.strictEqual(note.publishedDate, '2026-05-25');
      assert.strictEqual(note.contentMarkdown, mockMarkdown);
      assert.strictEqual(note.headings[0], 'Exa Article');
      assert.deepStrictEqual(note.images, [
        { originalUrl: 'https://example.com/exa.png', status: 'skipped' }
      ]);
      assert.ok(note.confidenceScore >= 0.6);
      assert.strictEqual(note.captureStatus, 'complete');
      assert.ok(note.fingerprint.length > 0);
    } finally {
      // Restore original post
      axios.post = originalPost;
    }
  });

  // Test 7b: Empty Jina captures should fail closed
  it('should reject empty Jina Reader captures instead of writing empty notes', async () => {
    const originalGet = axios.get;
    const mockUrl = 'https://example.com/empty-jina';

    axios.get = (async (): Promise<any> => {
      return {
        data: {
          data: {
            title: '',
            content: ''
          }
        }
      };
    }) as any;

    try {
    await assert.rejects(() => extractTier5(mockUrl), /empty article content/i);
    } finally {
      axios.get = originalGet;
    }
  });

  // Test 8: Fallback Escalation to Tier 3
  it('should escalate to Tier 3 when Tier 2 confidence is below threshold', async () => {
    const originalGet = axios.get;
    const originalLaunch = chromium.launch;

    // Tier 2 returns low confidence HTML (very short content)
    axios.get = (async (): Promise<any> => {
      return {
        data: `<html><head><title>Short Article</title></head><body><p>Too short</p></body></html>`
      };
    }) as any;

    // Tier 3 is mocked to return high confidence HTML via Playwright mock
    chromium.launch = (async (): Promise<any> => {
      const longText = 'This is a long test paragraph that will repeat multiple times to satisfy the readability and word count requirements of the confidence score checker. '.repeat(40);
      return {
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => {},
            waitForTimeout: async () => {},
            content: async () => `<html><head><title>Mock Tier 3 High Confidence</title></head><body><p>${longText}</p></body></html>`
          })
        }),
        close: async () => {}
      };
    }) as any;

    try {
      const config = {
        vaultPath: '/mock/vault',
        inboxSubdir: 'inbox',
        attachmentsSubdir: 'attachments',
        fallbackThreshold: 0.6
      };
      
      const { note, tierUsed } = await runExtractionPipeline('https://example.com/escalate', config);
      
      assert.strictEqual(tierUsed, 3);
      assert.strictEqual(note.title, 'Mock Tier 3 High Confidence');
      assert.ok(note.confidenceScore >= 0.6);
      assert.strictEqual(note.captureStatus, 'complete');
    } finally {
      axios.get = originalGet;
      chromium.launch = originalLaunch;
    }
  });

  it('should attempt Tier 4 Crawl4AI when earlier tiers are insufficient', async () => {
    const originalGet = axios.get;
    const originalLaunch = chromium.launch;
    const originalExecFile = extractor.__crawl4AITools.execFileAsync;
    const crawl4Payload = JSON.stringify({
      title: 'Crawl4AI Title',
      content: 'This is a robust crawl4ai capture with enough content and enough words to pass confidence checks. '.repeat(12),
      author: 'Crawler Bot',
      publishedDate: '2026-05-25',
      images: []
    });

    axios.get = (async (): Promise<any> => {
      return {
        data: `<html><head><title>Short Article</title></head><body><p>Too short</p></body></html>`
      };
    }) as any;

    chromium.launch = (async (): Promise<any> => {
      throw new Error('playwright unavailable');
    }) as any;

    extractor.__crawl4AITools.execFileAsync = (async () => {
      return {
        stdout: `${extractor.__crawl4AITools.jsonMarkerStart}\n${crawl4Payload}\n${extractor.__crawl4AITools.jsonMarkerEnd}\n`
      } as any;
    }) as any;

    try {
      const config = {
        vaultPath: '/mock/vault',
        inboxSubdir: 'inbox',
        attachmentsSubdir: 'attachments',
        fallbackThreshold: 0.6
      };

      const { note, tierUsed } = await runExtractionPipeline('https://example.com/crawl4a', config);

      assert.strictEqual(tierUsed, 4);
      assert.strictEqual(note.title, 'Crawl4AI Title');
      assert.strictEqual(note.author, 'Crawler Bot');
      assert.strictEqual(note.publishedDate, '2026-05-25');
    } finally {
      axios.get = originalGet;
      chromium.launch = originalLaunch;
      extractor.__crawl4AITools.execFileAsync = originalExecFile;
    }
  });

  it('should report extraction outputs as JSON-ready payloads', () => {
    const mockNote: CanonicalNote = {
      title: 'Machine JSON Note',
      sourceUrl: 'https://example.com/json-note',
      contentMarkdown: '# Machine JSON Note\n\nUseful paragraph for JSON output testing.',
      headings: ['Machine JSON Note'],
      images: [],
      confidenceScore: 0.91,
      captureStatus: 'complete',
      fingerprint: 'hash-123',
      tierUsed: 5
    };

    const payload = toCliExtractionOutput(mockNote.sourceUrl, mockNote);
    assert.strictEqual(payload.sourceUrl, mockNote.sourceUrl);
    assert.strictEqual(payload.tierUsed, 5);
    assert.deepStrictEqual(payload.note.title, mockNote.title);
    assert.strictEqual(payload.note.captureStatus, mockNote.captureStatus);
    assert.ok(payload.capturedAt);
  });

  it('should classify blocked/short captures as low quality', () => {
    const blockedText = 'Please accept all cookies to continue reading this article.';
    const shortText = 'just a moment';

    assert.strictEqual(isLikelyLowQualityCapture(blockedText, 'Some title', 'https://example.com/cookie'), true);
    assert.strictEqual(isLikelyLowQualityCapture(shortText, 'Short Title', 'https://example.com/captcha'), true);
    assert.strictEqual(isLikelyLowQualityCapture('This is a long-form article with useful details and many paragraphs of durable evidence. '.repeat(8), 'Valid Article', 'https://example.com/valid'), false);
  });

  // Test 9: Metadata & Fingerprint Stability
  it('should generate identical fingerprints for identical content on multiple runs', () => {
    const html = `<html><head><title>Stable Article</title></head><body><p>This is stable content body.</p></body></html>`;
    const note1 = parseHtml(html, 'https://example.com/stable');
    const note2 = parseHtml(html, 'https://example.com/stable');
    
    assert.strictEqual(note1.fingerprint, note2.fingerprint);
    assert.ok(note1.fingerprint.length > 0);
  });

  // Test 10: Vault writer must reject empty-source or empty-body captures
  it('should refuse to write captures with empty source or empty content', async () => {
    const vaultPath = path.join(__dirname, 'mock_vault_write_guard');

    await assert.rejects(
      () => writeNoteToVault({
        title: 'Untitled Article',
        sourceUrl: '',
        contentMarkdown: '',
        headings: [],
        images: [],
        confidenceScore: 0.95,
        captureStatus: 'complete',
        fingerprint: 'mockfingerprint'
      }, vaultPath, 'inbox/raw'),
      /sourceUrl is empty/i
    );

    await assert.rejects(
      () => writeNoteToVault({
        title: 'Untitled Article',
        sourceUrl: 'https://example.com/article',
        contentMarkdown: '   ',
        headings: [],
        images: [],
        confidenceScore: 0.95,
        captureStatus: 'complete',
        fingerprint: 'mockfingerprint'
      }, vaultPath, 'inbox/raw'),
      /contentMarkdown is empty/i
    );

    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
