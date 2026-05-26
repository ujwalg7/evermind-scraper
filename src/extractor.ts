import axios from 'axios';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { chromium } from 'playwright';
import * as crypto from 'crypto';
import { CanonicalNote, ImageInfo, Config } from './types';

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

/**
 * Detects if the extracted text belongs to a paywall, cookie wall, or human validation page.
 */
function detectPaywallOrCookieWall(text: string): boolean {
  const lowercaseText = text.toLowerCase();
  const badPatterns = [
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
    'please solve the captcha'
  ];

  for (const pattern of badPatterns) {
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
 * Calculates a confidence score for the extraction quality.
 */
function calculateConfidence(title: string, textContent: string, hasMetadata: boolean): number {
  if (!title || title.trim() === '') return 0;
  if (!textContent || textContent.trim() === '') return 0;

  if (detectPaywallOrCookieWall(textContent)) {
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
    metaData.hasMetadata
  );

  const fingerprint = calculateFingerprint(contentMarkdown);
  const captureStatus = confidenceScore < fallbackThreshold ? 'partial' : 'complete';

  return {
    title: title.trim() || 'Untitled Article',
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
 * Tier 4 - Free Jina Reader API fallback (returns clean Markdown + Metadata via JSON)
 */
export async function extractTier4(url: string): Promise<CanonicalNote> {
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
  const parsed = parseMarkdownMetadata(markdown);
  const fingerprint = calculateFingerprint(markdown);

  return {
    title: title || 'Untitled Article',
    sourceUrl: url,
    contentMarkdown: markdown,
    headings: parsed.headings,
    images: parsed.images,
    confidenceScore: 0.95, // Jina is highly reliable
    captureStatus: 'complete',
    fingerprint
  };
}

/**
 * Tier 5 - Exa Contents API fallback (Optional fallback if exaApiKey is provided)
 */
export async function extractTier5(url: string, apiKey: string): Promise<CanonicalNote> {
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
  const parsed = parseMarkdownMetadata(markdown);
  const fingerprint = calculateFingerprint(markdown);

  return {
    title: result.title || 'Untitled Article',
    sourceUrl: url,
    author: result.author || undefined,
    publishedDate: result.publishedDate || undefined,
    contentMarkdown: markdown,
    headings: parsed.headings,
    images: parsed.images,
    confidenceScore: 0.9, // Exa is highly reliable
    captureStatus: 'complete',
    fingerprint
  };
}

/**
 * Main orchestrator executing the fallback ladder
 */
export async function runExtractionPipeline(url: string, config: Config): Promise<{ note: CanonicalNote; tierUsed: number }> {
  console.log(`[Pipeline] Starting extraction for URL: ${url}`);
  
  // --- Tier 2: Deterministic HTML ---
  try {
    console.log('[Pipeline] Tier 2: Attempting raw HTML deterministic parsing...');
    const note = await extractTier2(url, config.fallbackThreshold);
    console.log(`[Pipeline] Tier 2 confidence score: ${note.confidenceScore.toFixed(2)}`);
    if (note.confidenceScore >= config.fallbackThreshold && note.captureStatus !== 'partial') {
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
    console.log(`[Pipeline] Tier 3 confidence score: ${tier3Note.confidenceScore.toFixed(2)}`);
    if (tier3Note && tier3Note.confidenceScore >= config.fallbackThreshold && tier3Note.captureStatus !== 'partial') {
      return { note: { ...tier3Note, tierUsed: 3 }, tierUsed: 3 };
    }
    console.log(`[Pipeline] Tier 3 confidence below threshold. Escalating to Tier 4.`);
  } catch (err: any) {
    console.warn(`[Pipeline] Tier 3 extraction failed: ${err.message}. Escalating to Tier 4.`);
  }

  // --- Tier 4: Jina Reader API (100% Free Fallback) ---
  try {
    console.log('[Pipeline] Tier 4: Querying Jina Reader proxy (Free Fallback)...');
    const note = await extractTier4(url);
    return { note: { ...note, tierUsed: 4 }, tierUsed: 4 };
  } catch (err: any) {
    console.error(`[Pipeline] Tier 4 Jina extraction failed: ${err.message}`);
  }

  // --- Tier 5: Exa Contents API (Optional Fallback) ---
  if (config.exaApiKey) {
    try {
      console.log('[Pipeline] Tier 5: Querying Exa Contents API...');
      const note = await extractTier5(url, config.exaApiKey);
      return { note: { ...note, tierUsed: 5 }, tierUsed: 5 };
    } catch (err: any) {
      console.error(`[Pipeline] Tier 5 Exa extraction failed: ${err.message}`);
    }
  } else {
    console.log('[Pipeline] Exa API key missing. Skipping Tier 5 fallback.');
  }

  // Return the best attempt we have, but explicitly marked as partial/needs_review
  if (tier3Note) {
    console.log('[Pipeline] Fallback ladder completed. Returning Tier 3 result (partial/needs_review).');
    const noteToReturn = tier3Note as CanonicalNote;
    return { 
      note: { 
        ...noteToReturn, 
        tierUsed: 3, 
        captureStatus: 'partial',
        extractionError: 'Escalated through all tiers. Playwright result was low confidence.'
      }, 
      tierUsed: 3 
    };
  }

  throw new Error('All stages of the extraction ladder failed.');
}
