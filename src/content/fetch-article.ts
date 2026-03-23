import { FeedItem } from './rss.js';

function extractMeta(html: string, property: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return match[1].trim();
  }
  return '';
}

function extractName(html: string, name: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return match[1].trim();
  }
  return '';
}

function extractTitle(html: string): string {
  const og = extractMeta(html, 'og:title');
  if (og) return og;
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

function extractDescription(html: string): string {
  return extractMeta(html, 'og:description') || extractName(html, 'description') || '';
}

function extractBodyText(html: string, maxWords = 2500): string {
  // Remove non-content blocks entirely
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Prefer semantic content containers — try progressively broader selectors
  const contentBlock =
    cleaned.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    cleaned.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
    // Common WordPress/CMS content div patterns
    cleaned.match(/<div[^>]+class="[^"]*(?:entry-content|post-content|article-content|article-body|post-body|td-post-content|single-content)[^"]*"[\s\S]*?<\/div>/i)?.[0] ||
    cleaned;

  // Extract text from paragraph tags, filtering out very short ones (captions, labels)
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(contentBlock)) !== null) {
    const text = match[1]
      .replace(/<[^>]+>/g, '')          // strip inner tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 40) {             // skip captions, nav labels, etc.
      paragraphs.push(text);
    }
  }

  const body = paragraphs.join('\n\n');
  if (!body) return '';

  // Truncate to maxWords to keep token costs reasonable
  const words = body.split(/\s+/);
  if (words.length > maxWords) {
    return words.slice(0, maxWords).join(' ') + ' [truncated]';
  }
  return body;
}

function domainSource(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return 'Web';
  }
}

export async function fetchArticle(url: string): Promise<FeedItem> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });

  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

  const html = await res.text();
  const title = extractTitle(html);
  const summary = extractDescription(html);
  const fullText = extractBodyText(html);

  if (!title) throw new Error(`Could not extract title from ${url}. Try using --topic instead.`);

  if (fullText) {
    console.log(`Article body extracted: ~${fullText.split(/\s+/).length} words`);
  } else {
    console.warn(`Could not extract article body from ${url} — will use summary only.`);
  }

  return {
    title,
    link: url,
    summary,
    fullText: fullText || undefined,
    source: domainSource(url),
    pubDate: new Date().toISOString(),
  };
}
