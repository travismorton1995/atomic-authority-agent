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
  { url: 'https://api.io.canada.ca/io-server/gc/news/en/v2?dept=canadiannuclearsafetycommission&sort=publishedDate&orderBy=desc&publishedDate%3E=2021-07-23&pick=15&format=atom&atomtitle=Canadian%20Nuclear%20Safety%20Commission', source: 'CNSC' },
  { url: 'https://www.world-nuclear-news.org/rss', source: 'World Nuclear News' },
  { url: 'https://cna.ca/feed/', source: 'Canadian Nuclear Association' },
  { url: 'https://www.ans.org/news/feed/', source: 'ANS Newswire' },
  { url: 'https://www.iaea.org/feeds/topnews', source: 'IAEA' },
  { url: 'https://www.brucepower.com/feed/', source: 'Bruce Power' },
  { url: 'https://www.powermag.com/category/nuclear/feed/', source: 'Power Magazine' },
  { url: 'https://www.cns-snc.ca/feed/', source: 'Canadian Nuclear Society' },
  { url: 'https://www.cnl.ca/feed/', source: 'Canadian Nuclear Laboratories' },
  { url: 'https://www.utilitydive.com/feeds/news/', source: 'Utility Dive' },
  { url: 'https://www.power-eng.com/feed/', source: 'Power Engineering' },
];

const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
    ],
  },
});

function extractFeedImage(item: any): string | undefined {
  return item.enclosure?.url
    ?? item.mediaContent?.$?.url
    ?? item.mediaThumbnail?.$?.url
    ?? undefined;
}

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

export async function fetchLatestItems(maxPerFeed = 7, maxAgeDays = 5): Promise<FeedItem[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const results = await Promise.allSettled(
    FEEDS.map(async feed => {
      const parsed = await parser.parseURL(feed.url);
      return parsed.items
        .map((item: any) => ({
          title: item.title ?? '',
          link: (item.link ?? '').replace(/([^:])\/\/+/g, '$1/'),
          summary: item.contentSnippet ?? item.content ?? '',
          source: feed.source,
          pubDate: normalizeDate(item.pubDate),
          imageUrl: extractFeedImage(item),
        }))
        .filter(item => {
          if (!item.pubDate) return true; // keep items with no date rather than discard
          const ms = new Date(item.pubDate).getTime();
          return isNaN(ms) || ms >= cutoff;
        })
        .slice(0, maxPerFeed);
    })
  );

  const items: FeedItem[] = [];
  const ok: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      ok.push(`${FEEDS[i].source} (${result.value.length})`);
    } else {
      failed.push(FEEDS[i].source);
      console.error(`Failed to fetch feed: ${FEEDS[i].source}`, result.reason);
    }
  }

  console.log(`RSS feeds fetched — OK: ${ok.join(', ')}`);
  if (failed.length > 0) console.warn(`RSS feeds failed: ${failed.join(', ')}`);

  return items;
}
