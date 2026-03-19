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
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AtomicAuthorityBot/1.0)' },
  });

  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

  const html = await res.text();
  const title = extractTitle(html);
  const summary = extractDescription(html);

  if (!title) throw new Error(`Could not extract title from ${url}. Try using --topic instead.`);

  return {
    title,
    link: url,
    summary,
    source: domainSource(url),
    pubDate: new Date().toISOString(),
  };
}
