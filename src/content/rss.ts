import Parser from 'rss-parser';

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  source: string;
  pubDate: string;
}

const FEEDS = [
  { url: 'https://www.world-nuclear-news.org/rss', source: 'World Nuclear News' },
  { url: 'https://cna.ca/feed/', source: 'Canadian Nuclear Association' },
  { url: 'https://api.io.canada.ca/io-server/gc/news/en/v2?dept=canadiannuclearsafetycommission&sort=publishedDate&orderBy=desc&publishedDate%3E=2021-07-23&pick=5&format=atom&atomtitle=Canadian%20Nuclear%20Safety%20Commission', source: 'CNSC' },
  { url: 'https://www.ans.org/news/feed/', source: 'ANS Newswire' },
  { url: 'https://www.iaea.org/feeds/topnews', source: 'IAEA' },
  { url: 'https://www.brucepower.com/feed/', source: 'Bruce Power' },
];

const parser = new Parser();

export async function fetchLatestItems(maxPerFeed = 5): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const recent = parsed.items.slice(0, maxPerFeed);
      for (const item of recent) {
        items.push({
          title: item.title ?? '',
          link: item.link ?? '',
          summary: item.contentSnippet ?? item.content ?? '',
          source: feed.source,
          pubDate: item.pubDate ?? '',
        });
      }
    } catch (err) {
      console.error(`Failed to fetch feed: ${feed.source}`, err);
    }
  }

  return items;
}
