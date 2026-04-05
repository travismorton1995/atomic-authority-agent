import { FeedItem } from './rss.js';

const API_BASE = 'https://newsdata.io/api/1/latest';

// Blocked domains — low-quality sources that produce noise in ranking.
// Add new domains here as they're discovered.
const BLOCKED_DOMAINS = [
  'insightsonindia.com',    // UPSC exam prep aggregator
  'defenseworld.net',       // stock roundups
  'bitcoinworld.co.in',     // crypto spam
  'fool.com',               // investment advice
  'marketsdaily.com',       // stock tickers
  'dailyadvance.com',       // press release syndication
  'postregister.com',       // press release syndication
  'rutlandherald.com',      // press release syndication
  'webpronews.com',         // clickbait tech aggregator
  'sedaily.com',            // Korean financial news
  'menafn.com',             // Middle East press release wire
];

// Queries tuned for the nuclear/AI intersection niche.
// Each query uses 1 credit (10 results). Free tier: 200 credits/day.
const QUERIES = [
  { q: 'nuclear energy AI', label: 'nuclear+AI' },
  { q: 'nuclear reactor SMR', label: 'nuclear+SMR' },
  { q: 'nuclear regulatory safety', label: 'nuclear+regulation' },
  { q: 'Canada nuclear energy reactor', label: 'Canada+nuclear' },
  { q: 'NRC nuclear licensing', label: 'NRC+licensing' },
];

interface NewsDataArticle {
  article_id: string;
  title: string;
  link: string;
  description: string | null;
  content: string | null;
  pubDate: string | null;
  image_url: string | null;
  source_name: string | null;
  source_id: string | null;
}

interface NewsDataResponse {
  status: string;
  totalResults: number;
  results: NewsDataArticle[];
  nextPage?: string;
}

export async function fetchNewsDataItems(): Promise<FeedItem[]> {
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) {
    console.log('NewsData: NEWSDATA_API_KEY not set — skipping.');
    return [];
  }

  const seen = new Set<string>();
  const items: FeedItem[] = [];
  const ok: string[] = [];
  const failed: string[] = [];

  for (const query of QUERIES) {
    try {
      const params = new URLSearchParams({
        apikey: apiKey,
        q: query.q,
        language: 'en',
        excludecategory: 'sports,entertainment,lifestyle,crime,food',
        size: '10',
      });

      const res = await fetch(`${API_BASE}?${params}`);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json() as NewsDataResponse;
      if (data.status !== 'success') {
        throw new Error(`API error: ${JSON.stringify(data).slice(0, 200)}`);
      }

      // Title patterns that indicate stock/investment/legal noise
      const JUNK_TITLE_RE = /\bstocks?\b.*\b(follow|buy|watch|research)\b|\bstocks? to\b|\bticker\b|\bdividend\b|\bsells?\s+[\d,]+\s+shares\b|\bclass action\b|\bstockholder|\bNYSE:|NASDAQ:/i;

      let added = 0;
      for (const article of data.results ?? []) {
        if (!article.title || !article.link) continue;
        if (JUNK_TITLE_RE.test(article.title)) continue;
        // Block known junk domains — exam prep aggregators, stock sites, crypto spam, etc.
        try {
          const domain = new URL(article.link).hostname.replace(/^www\./, '');
          if (BLOCKED_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`))) continue;
        } catch {}
        // Deduplicate by URL across queries
        const normalizedUrl = article.link.replace(/\/$/, '').toLowerCase();
        if (seen.has(normalizedUrl)) continue;
        seen.add(normalizedUrl);

        items.push({
          title: article.title,
          link: article.link,
          summary: article.description ?? article.content?.slice(0, 500) ?? '',
          source: `NewsData: ${article.source_name ?? article.source_id ?? 'unknown'}`,
          pubDate: article.pubDate ? new Date(article.pubDate).toISOString() : '',
          imageUrl: article.image_url ?? undefined,
        });
        added++;
      }

      ok.push(`${query.label} (${added})`);
    } catch (err) {
      failed.push(query.label);
      console.error(`NewsData query "${query.label}" failed:`, (err as Error).message);
    }
  }

  if (ok.length > 0) console.log(`NewsData fetched — OK: ${ok.join(', ')}`);
  if (failed.length > 0) console.warn(`NewsData failed: ${failed.join(', ')}`);

  return items;
}
