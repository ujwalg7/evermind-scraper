import axios from 'axios';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import { CanonicalNote, ImageInfo, Config } from './types';

export interface CliExtractionOutput {
  sourceUrl: string;
  tierUsed: number;
  note: CanonicalNote;
  capturedAt: string;
}

export function toCliExtractionOutput(url: string, note: CanonicalNote): CliExtractionOutput {
  return {
    sourceUrl: url,
    tierUsed: note.tierUsed || 0,
    note,
    capturedAt: new Date().toISOString()
  };
}

const execFileAsync = promisify(execFile);
const CRAWL4AI_JSON_MARKER_START = '__EVERMIND_CRAWL4AI_JSON_START__';
const CRAWL4AI_JSON_MARKER_END = '__EVERMIND_CRAWL4AI_JSON_END__';

const crawl4AIRuntime = {
  execFileAsync,
  jsonMarkerStart: CRAWL4AI_JSON_MARKER_START,
  jsonMarkerEnd: CRAWL4AI_JSON_MARKER_END
};

export const __crawl4AITools = crawl4AIRuntime;

const LOW_QUALITY_PATTERNS = [
  'enable javascript',
  'javascript is disabled',
  'cookies policy',
  'accept all cookies',
  'subscribe to read',
  'register to read',
  'sign in to continue',
  'create an account to read',
  'continue reading with a digital subscription',
  'exclusive content for subscribers',
  'verify you are a human',
  'checking your browser before accessing',
  'please solve the captcha',
  'just a moment',
  'page can\'t be found',
  'page cannot be found',
  'site not found',
  'cookie wall',
  'cookie policy',
  'captcha',
  'page not found',
  '404 error',
  '404 page not found'
];

// Configure Turndown for clean, structure-faithful Markdown conversion
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  hr: '---',
  bulletListMarker: '-'
});

// Rule 1: Keep links absolute
turndownService.addRule('absoluteLinks', {
  filter: ['a'],
  replacement: (content, node) => {
    const href = (node as HTMLAnchorElement).getAttribute('href');
    if (!href) return content;
    return `[${content}](${href})`;
  }
});

// Rule 2: Handle Figure and Figcaption to preserve image captions
turndownService.addRule('figure', {
  filter: 'figure',
  replacement: (content) => `\n\n${content.trim()}\n\n`
});

turndownService.addRule('figcaption', {
  filter: 'figcaption',
  replacement: (content) => `\n*Caption: ${content.trim()}*\n`
});

// Rule 3: Preserve code languages inside code blocks
turndownService.addRule('fencedCodeBlocks', {
  filter: 'pre',
  replacement: (content, node) => {
    const codeElement = (node as HTMLElement).querySelector('code');
    if (!codeElement) return `\n\n\`\`\`\n${content.trim()}\n\`\`\`\n\n`;
    const classAttribute = codeElement.getAttribute('class') || '';
    const langMatch = classAttribute.match(/language-(\S+)/);
    const language = langMatch ? langMatch[1] : '';
    const codeText = codeElement.textContent || '';
    return `\n\n\`\`\`${language}\n${codeText.trim()}\n\`\`\`\n\n`;
  }
});

/**
 * Calculates SHA-256 hash fingerprint of string
 */
function calculateFingerprint(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function deriveFallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const segments = parsed.pathname
      .split('/')
      .map(segment => segment.trim())
      .filter(Boolean)
      .map(segment => segment.replace(/[-_]+/g, ' '))
      .map(segment => segment.replace(/[^\w\s]/g, ''))
      .filter(Boolean);

    const tail = segments.length > 0 ? segments[segments.length - 1] : '';
    const head = segments.length > 1 ? segments[segments.length - 2] : '';
    const candidate = [head, tail].filter(Boolean).join(' ').trim() || tail || host;
    return candidate ? candidate.replace(/\s+/g, ' ').trim() : 'Captured Article';
  } catch {
    return 'Captured Article';
  }
}

function normalizeTitle(rawTitle: string, url: string): string {
  const title = (rawTitle || '').trim();
  if (!title || /^untitled article$/i.test(title) || /^untitled$/i.test(title)) {
    return deriveFallbackTitle(url);
  }
  return title;
}

/**
 * Detects if the extracted text belongs to a paywall, cookie wall, or human validation page.
 */
function detectPaywallOrCookieWall(text: string): boolean {
  const lowercaseText = text.toLowerCase();
  for (const pattern of LOW_QUALITY_PATTERNS) {
    if (lowercaseText.includes(pattern)) {
      return true;
    }
  }

  // If text is extremely short and contains paywall-adjacent words, suspect paywall
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < 150) {
    const paywallAdjacent = ['subscribe', 'subscription', 'premium', 'log in', 'sign in', 'cookie'];
    const matches = paywallAdjacent.filter(w => lowercaseText.includes(w));
    if (matches.length >= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Determines if a capture looks non-article-like or low quality.
 */
export function isLikelyLowQualityCapture(text: string, title: string = '', sourceUrl: string = ''): boolean {
  const normalizedText = (text || '').toLowerCase();
  const normalizedTitle = (title || '').toLowerCase();
  const normalizedUrl = (sourceUrl || '').toLowerCase();
  const combined = `${normalizedText} ${normalizedTitle} ${normalizedUrl}`.trim();

  if (!combined) {
    return true;
  }

  if (LOW_QUALITY_PATTERNS.some(pattern => combined.includes(pattern))) {
    return true;
  }

  const wordCount = normalizedText.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 120) {
    const blockers = ['subscribe', 'subscription', 'premium', 'log in', 'sign in', 'cookie', 'privacy policy', 'please'];
    const matches = blockers.filter(word => combined.includes(word));
    if (matches.length >= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Calculates a confidence score for the extraction quality.
 */
function calculateConfidence(title: string, textContent: string, hasMetadata: boolean, sourceUrl = ''): number {
  if (!title || title.trim() === '') return 0;
  if (!textContent || textContent.trim() === '') return 0;

  if (detectPaywallOrCookieWall(textContent) || isLikelyLowQualityCapture(textContent, title, sourceUrl)) {
    console.log('[Pipeline] Paywall or cookie wall detected in text. Forcing fallback.');
    return 0;
  }

  const wordCount = textContent.trim().split(/\s+/).length;
  if (wordCount < 100) return 0.2; // Too short, likely cookie wall or error page

  let score = 0.5;

  // Boost based on text length
  if (wordCount > 300) score += 0.2;
  if (wordCount > 800) score += 0.1;

  // Boost for metadata presence
  if (hasMetadata) score += 0.15;

  return Math.min(score, 1.0);
}

/**
 * Parse metadata from DOM
 */
function parseMetadata(doc: Document) {
  const meta: { [key: string]: string } = {};

  const metaTags = doc.querySelectorAll('meta');
  metaTags.forEach(tag => {
    const name = tag.getAttribute('name') || tag.getAttribute('property') || tag.getAttribute('itemprop');
    const content = tag.getAttribute('content');
    if (name && content) {
      meta[name.toLowerCase()] = content;
    }
  });

  const title = meta['og:title'] || meta['twitter:title'] || doc.title || '';
  const author = meta['author'] || meta['article:author'] || meta['og:article:author'] || meta['twitter:creator'] || '';
  const publishedDate = meta['article:published_time'] || meta['pubdate'] || meta['date'] || meta['og:article:published_time'] || '';
  const heroImageUrl = meta['og:image'] || meta['twitter:image'] || meta['image'] || '';

  let jsonLdAuthor = '';
  let jsonLdDate = '';
  let jsonLdTitle = '';
  try {
    const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
    jsonLdScripts.forEach(script => {
      if (!script.textContent) return;
      try {
        const data = JSON.parse(script.textContent);
        const searchJsonLd = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.headline && !jsonLdTitle) jsonLdTitle = obj.headline;
          if (obj.author) {
            if (typeof obj.author === 'string') {
              jsonLdAuthor = obj.author;
            } else if (Array.isArray(obj.author) && obj.author[0]) {
              jsonLdAuthor = obj.author[0].name || obj.author[0].fullName || '';
            } else if (obj.author.name) {
              jsonLdAuthor = obj.author.name;
            }
          }
          if (obj.datePublished && !jsonLdDate) jsonLdDate = obj.datePublished;
          if (obj['@graph'] && Array.isArray(obj['@graph'])) {
            obj['@graph'].forEach(searchJsonLd);
          }
        };
        searchJsonLd(data);
      } catch {
        // Skip invalid JSON-LD
      }
    });
  } catch {
    // Skip JSON-LD errors
  }

  return {
    title: jsonLdTitle || title,
    author: jsonLdAuthor || author,
    publishedDate: jsonLdDate || publishedDate,
    heroImageUrl,
    hasMetadata: Object.keys(meta).length > 0 || !!jsonLdAuthor
  };
}

/**
 * Extract image elements from the DOM
 */
function extractImages(doc: Document, contentElement: Element | null, baseUrl: string): ImageInfo[] {
  const images: ImageInfo[] = [];
  const seenUrls = new Set<string>();

  const addImage = (src: string) => {
    if (!src || src.startsWith('data:')) return;
    try {
      const absoluteUrl = new URL(src, baseUrl).toString();
      if (!seenUrls.has(absoluteUrl)) {
        seenUrls.add(absoluteUrl);
        images.push({ 
          originalUrl: absoluteUrl,
          status: 'skipped'
        });
      }
    } catch {
      // Ignore invalid URLs
    }
  };

  if (contentElement) {
    const imgElements = contentElement.querySelectorAll('img');
    imgElements.forEach(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original-src');
      if (src) addImage(src);
    });
  }

  if (images.length === 0) {
    const imgElements = doc.querySelectorAll('img');
    imgElements.forEach(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if (src) addImage(src);
    });
  }

  return images;
}

/**
 * Extract headings from the content elements
 */
function extractHeadings(contentElement: Element | null): string[] {
  if (!contentElement) return [];
  const headingElements = contentElement.querySelectorAll('h1, h2, h3, h4');
  const headings: string[] = [];
  headingElements.forEach(h => {
    const text = h.textContent?.trim();
    if (text) headings.push(text);
  });
  return headings;
}

/**
 * Normalizes HTML string to CanonicalNote
 */
export function parseHtml(html: string, url: string, fallbackThreshold = 0.6): CanonicalNote {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const metaData = parseMetadata(doc);

  const docClone = doc.cloneNode(true) as Document;
  const reader = new Readability(docClone, { keepClasses: true });
  const article = reader.parse();

  let contentMarkdown = '';
  let headings: string[] = [];
  let images: ImageInfo[] = [];
  let title = metaData.title || (article ? article.title : '');
  
  if (article && article.content) {
    contentMarkdown = turndownService.turndown(article.content);
    const contentDom = new JSDOM(article.content);
    headings = extractHeadings(contentDom.window.document.body);
    images = extractImages(doc, contentDom.window.document.body, url);
  } else {
    contentMarkdown = turndownService.turndown(doc.body.innerHTML);
    headings = extractHeadings(doc.body);
    images = extractImages(doc, doc.body, url);
  }

  if (metaData.heroImageUrl) {
    const exists = images.some(img => img.originalUrl === metaData.heroImageUrl);
    if (!exists) {
      images.unshift({ 
        originalUrl: metaData.heroImageUrl,
        status: 'skipped'
      });
    }
  }

  const confidenceScore = calculateConfidence(
    title, 
    article ? article.textContent : doc.body.textContent || '', 
    metaData.hasMetadata,
    url
  );

  const fingerprint = calculateFingerprint(contentMarkdown);
  const captureStatus = confidenceScore < fallbackThreshold ? 'partial' : 'complete';

  return {
    title: normalizeTitle(title, url),
    sourceUrl: url,
    author: metaData.author.trim() || undefined,
    publishedDate: metaData.publishedDate.trim() || undefined,
    heroImageUrl: metaData.heroImageUrl || undefined,
    contentMarkdown,
    headings,
    images,
    confidenceScore,
    captureStatus,
    fingerprint
  };
}

/**
 * Helper to parse headings and images from raw markdown (useful for fallbacks)
 */
export function parseMarkdownMetadata(markdown: string): { images: ImageInfo[]; headings: string[] } {
  const headings: string[] = [];
  const images: ImageInfo[] = [];
  
  const lines = markdown.split('\n');
  for (const line of lines) {
    const headingMatch = line.match(/^#+\s+(.+)$/);
    if (headingMatch) {
      headings.push(headingMatch[1].trim());
    }
  }

  const imageRegex = /!\[.*?\]\((https?:\/\/.*?)\)/g;
  let match;
  const seenUrls = new Set<string>();
  while ((match = imageRegex.exec(markdown)) !== null) {
    const src = match[1];
    if (src && !seenUrls.has(src)) {
      seenUrls.add(src);
      images.push({ 
        originalUrl: src,
        status: 'skipped'
      });
    }
  }

  return { headings, images };
}

function shouldReturnFromPipeline(note: CanonicalNote, threshold: number): boolean {
  return note.confidenceScore >= threshold && note.captureStatus !== 'partial';
}

function buildCanonicalFromMarkdown(
  url: string,
  title: string,
  markdown: string,
  threshold: number,
  author = '',
  publishedDate = '',
  parsedImages: ImageInfo[] = []
): CanonicalNote {
  const parsed = parseMarkdownMetadata(markdown);
  const resolvedTitle = normalizeTitle(title, url);
  const confidenceScore = calculateConfidence(
    resolvedTitle,
    markdown,
    parsed.images.length > 0 || parsedImages.length > 0,
    url
  );
  const fingerprint = calculateFingerprint(markdown);

  const mergedImages = parsed.images.length ? parsed.images : parsedImages;
  return {
    title: resolvedTitle,
    sourceUrl: url,
    author: author.trim() || undefined,
    publishedDate: publishedDate.trim() || undefined,
    contentMarkdown: markdown,
    headings: parsed.headings,
    images: mergedImages,
    confidenceScore,
    captureStatus: confidenceScore >= threshold && !isLikelyLowQualityCapture(markdown, resolvedTitle, url) ? 'complete' : 'partial',
    fingerprint
  };
}

async function isCrawl4AIAvailable(): Promise<boolean> {
  try {
    await crawl4AIRuntime.execFileAsync(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-c', 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("crawl4ai") else 1)']
    );
    return true;
  } catch {
    return false;
  }
}

class Crawl4AIDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Crawl4AIDependencyError';
  }
}

async function extractWithCrawl4AI(url: string): Promise<{ title: string; content: string; author: string; publishedDate: string; images: string[] }> {
  const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
  const script = `
import asyncio
import json

async def run():
  try:
    from crawl4ai import AsyncWebCrawler
  except Exception:
    from crawl4ai.async_webcrawler import AsyncWebCrawler

  async with AsyncWebCrawler() as crawler:
    result = await crawler.arun(url=${JSON.stringify(url)})

  images = []
  for media in getattr(result, 'media', []) or []:
    candidate = None
    if isinstance(media, dict):
      candidate = media.get('url') or media.get('src')
    elif isinstance(media, str):
      candidate = media
    if candidate:
      images.append(candidate)

  payload = {
    'title': getattr(result, 'title', '') or '',
    'content': getattr(result, 'markdown', '') or '',
    'author': getattr(result, 'author', '') or '',
    'publishedDate': getattr(result, 'published', '') or getattr(result, 'publishedDate', '') or '',
    'images': images
  }
  print('${CRAWL4AI_JSON_MARKER_START}')
  print(json.dumps(payload))
  print('${CRAWL4AI_JSON_MARKER_END}')

asyncio.run(run())
`.trim();

  const { stdout } = await crawl4AIRuntime.execFileAsync(pythonExecutable, ['-c', script], { timeout: 25000 });
  const start = stdout.indexOf(CRAWL4AI_JSON_MARKER_START);
  const end = stdout.lastIndexOf(CRAWL4AI_JSON_MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Crawl4AI did not return structured JSON');
  }

  const jsonText = stdout
    .slice(start + CRAWL4AI_JSON_MARKER_START.length, end)
    .trim();
  if (!jsonText) {
    throw new Error('Crawl4AI did not return structured JSON');
  }

  const parsed = JSON.parse(jsonText);
  const content = (parsed.content || '').trim();
  if (!content) {
    throw new Error('Crawl4AI returned empty article content');
  }

  return {
    title: parsed.title || '',
    content,
    author: parsed.author || '',
    publishedDate: parsed.publishedDate || '',
    images: Array.isArray(parsed.images) ? parsed.images.filter((entry: unknown) => typeof entry === 'string') : []
  };
}

/**
 * Tier 2 - Deterministic HTML parser
 */
export async function extractTier2(url: string, threshold = 0.6): Promise<CanonicalNote> {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    timeout: 10000
  });

  const html = response.data;
  if (typeof html !== 'string') {
    throw new Error('Response is not HTML string');
  }

  return parseHtml(html, url, threshold);
}

/**
 * Tier 3 - Rendered DOM parser using Playwright
 */
export async function extractTier3(url: string, threshold = 0.6): Promise<CanonicalNote> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    const html = await page.content();
    return parseHtml(html, url, threshold);
  } finally {
    await browser.close();
  }
}

/**
 * Tier 4 - Crawl4AI fallback (optional; requires python package)
 */
export async function extractTier4(url: string): Promise<CanonicalNote> {
  const crawl4AIAvailable = await isCrawl4AIAvailable();
  if (!crawl4AIAvailable) {
    throw new Crawl4AIDependencyError('Crawl4AI is not installed');
  }

  const result = await extractWithCrawl4AI(url);
  const note = buildCanonicalFromMarkdown(url, result.title, result.content, 0.6, result.author, result.publishedDate);
  const mergedUrls = new Set(note.images.map(image => image.originalUrl));
  for (const rawImage of result.images) {
    if (!mergedUrls.has(rawImage)) {
      note.images.push({
        originalUrl: rawImage,
        status: 'skipped'
      });
      mergedUrls.add(rawImage);
    }
  }

  return note;
}

/**
 * Tier 5 - Jina Reader API fallback (returns clean Markdown + Metadata via JSON)
 */
export async function extractTier5(url: string, threshold = 0.6): Promise<CanonicalNote> {
  const response = await axios.get(`https://r.jina.ai/${url}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 20000
  });

  const resData = response.data;
  if (!resData || !resData.data) {
    throw new Error('Jina Reader API returned invalid format');
  }

  const { title, content } = resData.data;
  const markdown = content || '';
  if (!markdown.trim()) {
    throw new Error('Jina Reader returned empty article content');
  }

  return buildCanonicalFromMarkdown(url, title || '', markdown, threshold);
}

/**
 * Tier 6 - Exa Contents API fallback (Optional fallback if exaApiKey is provided)
 */
export async function extractTier6(url: string, apiKey: string, threshold = 0.6): Promise<CanonicalNote> {
  const response = await axios.post('https://api.exa.ai/contents', {
    urls: [url],
    text: true
  }, {
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 20000
  });

  if (!response.data || !response.data.results || response.data.results.length === 0) {
    throw new Error('Exa API returned no results');
  }

  const result = response.data.results[0];
  const markdown = result.text || '';
  if (!markdown.trim()) {
    throw new Error('Exa API returned empty article content');
  }

  return buildCanonicalFromMarkdown(
    url,
    result.title || '',
    markdown,
    threshold,
    result.author || '',
    result.publishedDate || ''
  );
}

/**
 * Main orchestrator executing the fallback ladder
 */
export async function runExtractionPipeline(url: string, config: Config): Promise<{ note: CanonicalNote; tierUsed: number }> {
  console.log(`[Pipeline] Starting extraction for URL: ${url}`);
  let lastNote: CanonicalNote | null = null;
  let lastTier = 0;
  
  // --- Tier 2: Deterministic HTML ---
  try {
    console.log('[Pipeline] Tier 2: Attempting raw HTML deterministic parsing...');
    const note = await extractTier2(url, config.fallbackThreshold);
    lastNote = note;
    lastTier = 2;
    console.log(`[Pipeline] Tier 2 confidence score: ${note.confidenceScore.toFixed(2)}`);
    if (shouldReturnFromPipeline(note, config.fallbackThreshold)) {
      return { note: { ...note, tierUsed: 2 }, tierUsed: 2 };
    }
    console.log(`[Pipeline] Tier 2 confidence below threshold (${config.fallbackThreshold}). Escalating to Tier 3.`);
  } catch (err: any) {
    console.warn(`[Pipeline] Tier 2 extraction failed: ${err.message}. Escalating to Tier 3.`);
  }

  // --- Tier 3: Playwright Rendered DOM ---
  let tier3Note: CanonicalNote | null = null;
  try {
    console.log('[Pipeline] Tier 3: Rendering page with Playwright...');
    tier3Note = await extractTier3(url, config.fallbackThreshold);
    lastNote = tier3Note;
    lastTier = 3;
    console.log(`[Pipeline] Tier 3 confidence score: ${tier3Note.confidenceScore.toFixed(2)}`);
    if (shouldReturnFromPipeline(tier3Note, config.fallbackThreshold)) {
      return { note: { ...tier3Note, tierUsed: 3 }, tierUsed: 3 };
    }
    console.log(`[Pipeline] Tier 3 confidence below threshold. Escalating to Tier 4.`);
  } catch (err: any) {
    console.warn(`[Pipeline] Tier 3 extraction failed: ${err.message}. Escalating to Tier 4.`);
  }

  // --- Tier 4: Crawl4AI (optional fallback) ---
  try {
    console.log('[Pipeline] Tier 4: Querying Crawl4AI fallback...');
    const note = await extractTier4(url);
    lastNote = note;
    lastTier = 4;
    if (shouldReturnFromPipeline(note, config.fallbackThreshold)) {
      return { note: { ...note, tierUsed: 4 }, tierUsed: 4 };
    }
    console.log(`[Pipeline] Tier 4 capture low confidence. Escalating to Tier 5.`);
  } catch (err: any) {
    if (err instanceof Crawl4AIDependencyError) {
      console.log('[Pipeline] Crawl4AI unavailable. Skipping Tier 4.');
    } else {
      console.error(`[Pipeline] Tier 4 Crawl4AI extraction failed: ${err.message}`);
    }
  }

  // --- Tier 5: Jina Reader API (100% Free Fallback) ---
  try {
    console.log('[Pipeline] Tier 5: Querying Jina Reader proxy (Free Fallback)...');
    const note = await extractTier5(url, config.fallbackThreshold);
    lastNote = note;
    lastTier = 5;
    if (shouldReturnFromPipeline(note, config.fallbackThreshold)) {
      return { note: { ...note, tierUsed: 5 }, tierUsed: 5 };
    }
    console.log(`[Pipeline] Tier 5 capture low confidence. Escalating to Tier 6.`);
  } catch (err: any) {
    console.error(`[Pipeline] Tier 5 Jina extraction failed: ${err.message}`);
  }

  // --- Tier 6: Exa Contents API (Optional Fallback) ---
  if (config.exaApiKey) {
    try {
      console.log('[Pipeline] Tier 6: Querying Exa Contents API...');
      const note = await extractTier6(url, config.exaApiKey, config.fallbackThreshold);
      lastNote = note;
      lastTier = 6;
      if (shouldReturnFromPipeline(note, config.fallbackThreshold)) {
        return { note: { ...note, tierUsed: 6 }, tierUsed: 6 };
      }
      console.log('[Pipeline] Tier 6 capture low confidence. Falling back to best partial capture.');
    } catch (err: any) {
      console.error(`[Pipeline] Tier 6 Exa extraction failed: ${err.message}`);
    }
  } else {
    console.log('[Pipeline] Exa API key missing. Skipping Tier 6 fallback.');
  }

  // Return the best attempt we have, but explicitly marked as partial/needs_review
  if (lastNote) {
    console.log(`[Pipeline] Fallback ladder completed. Returning Tier ${lastTier} result (partial/needs_review).`);
    return { 
      note: { 
        ...lastNote,
        tierUsed: lastTier,
        captureStatus: 'partial',
        extractionError: 'Escalated through all tiers. No fully confident tier result found.'
      }, 
      tierUsed: lastTier
    };
  }

  throw new Error('All stages of the extraction ladder failed.');
}
