import Parser from 'rss-parser';

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  source: string;
  pubDate: string;
  fullText?: string;
  imageUrl?: string;
}

const FEEDS = [
  { url: 'https://www.world-nuclear-news.org/rss', source: 'World Nuclear News' },
  { url: 'https://cna.ca/feed/', source: 'Canadian Nuclear Association' },
  { url: 'https://api.io.canada.ca/io-server/gc/news/en/v2?dept=canadiannuclearsafetycommission&sort=publishedDate&orderBy=desc&publishedDate%3E=2021-07-23&pick=15&format=atom&atomtitle=Canadian%20Nuclear%20Safety%20Commission', source: 'CNSC' },
  { url: 'https://www.ans.org/news/feed/', source: 'ANS Newswire' },
  { url: 'https://www.iaea.org/feeds/topnews', source: 'IAEA' },
  { url: 'https://www.brucepower.com/feed/', source: 'Bruce Power' },
  { url: 'https://www.neimagazine.com/rss', source: 'NEI Magazine' },
  { url: 'https://www.powermag.com/category/nuclear/feed/', source: 'Power Magazine' },
  { url: 'https://www.cns-snc.ca/feed/', source: 'Canadian Nuclear Society' },
  { url: 'https://www.cnl.ca/feed/', source: 'Canadian Nuclear Laboratories' },
];

const parser = new Parser();

// Normalizes pubDate strings to ISO format.
// Handles standard RFC 2822/ISO dates as well as non-standard formats
// like the IAEA feed's "YY-MM-DD  HH:MM" (with leading/trailing whitespace).
function normalizeDate(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Try standard parse first
  const standard = new Date(trimmed);
  if (!isNaN(standard.getTime())) return standard.toISOString();

  // Fallback: YY-MM-DD HH:MM (IAEA feed format)
  const yymmdd = trimmed.match(/^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (yymmdd) {
    const [, yy, mm, dd, hh, min] = yymmdd;
    const fullYear = 2000 + parseInt(yy, 10);
    const d = new Date(Date.UTC(fullYear, parseInt(mm, 10) - 1, parseInt(dd, 10), parseInt(hh, 10), parseInt(min, 10)));
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return '';
}

export async function fetchLatestItems(maxPerFeed = 5): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const recent = parsed.items.slice(0, maxPerFeed);
      for (const item of recent) {
        items.push({
          title: item.title ?? '',
          link: (item.link ?? '').replace(/([^:])\/\/+/g, '$1/'),
          summary: item.contentSnippet ?? item.content ?? '',
          source: feed.source,
          pubDate: normalizeDate(item.pubDate),
        });
      }
    } catch (err) {
      console.error(`Failed to fetch feed: ${feed.source}`, err);
    }
  }

  return items;
}
