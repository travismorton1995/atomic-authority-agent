import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const client = new Anthropic();

const USED_IMAGES_FILE = 'used_stock_images.json';

// Stock photo clichés to filter out — matched against alt_description/description
const CLICHE_PATTERNS = [
  /handshake/i,
  /thumbs?\s*up/i,
  /pointing at (?:screen|monitor|laptop|computer)/i,
  /smiling at camera/i,
  /fist bump/i,
  /high five/i,
  /arms? crossed/i,
  /holding blank/i,
  /woman.*holding.*phone.*smiling/i,
  /group.*cheering/i,
  /celebration.*office/i,
  /jumping.*joy/i,
];

export interface UnsplashPhoto {
  url: string;        // regular size (~1080px wide)
  downloadUrl: string; // trigger download endpoint (required by Unsplash API terms)
  photographer: string;
  description: string;
  searchQuery: string; // the query that found this image
}

interface RawUnsplashResult {
  id: string;
  width: number;
  height: number;
  urls: { regular: string };
  links: { download_location: string };
  user: { name: string };
  description: string | null;
  alt_description: string | null;
}

// --- Deduplication ---

function loadUsedImageIds(): Set<string> {
  if (!existsSync(USED_IMAGES_FILE)) return new Set();
  try {
    const data = JSON.parse(readFileSync(USED_IMAGES_FILE, 'utf-8')) as string[];
    return new Set(data);
  } catch {
    return new Set();
  }
}

export function markImageUsed(imageUrl: string): void {
  const used = loadUsedImageIds();
  // Extract the photo ID from the URL (the path segment after /photo-)
  const idMatch = imageUrl.match(/photo-([a-zA-Z0-9_-]+)/);
  if (idMatch) used.add(idMatch[1]);
  writeFileSync(USED_IMAGES_FILE, JSON.stringify([...used], null, 2), 'utf-8');
}

function isImageUsed(result: RawUnsplashResult): boolean {
  const used = loadUsedImageIds();
  const idMatch = result.urls.regular.match(/photo-([a-zA-Z0-9_-]+)/);
  return idMatch ? used.has(idMatch[1]) : false;
}

// --- Cliché filter ---

function isCliche(result: RawUnsplashResult): boolean {
  const text = `${result.description ?? ''} ${result.alt_description ?? ''}`.toLowerCase();
  return CLICHE_PATTERNS.some(p => p.test(text));
}

// --- Main search ---

/**
 * Search Unsplash for stock photos matching the post content.
 * Returns up to 3 diverse photos — one per independent search query,
 * each LLM-ranked from its own result set for maximum variety.
 *
 * Pipeline per query: Unsplash search → cliché/dedup/ratio filter →
 * LLM picks best from top 5 → one winner per query
 */
export async function searchStockImages(postContent: string, count = 3): Promise<UnsplashPhoto[]> {
  if (!UNSPLASH_ACCESS_KEY) {
    console.log('[stock-image] UNSPLASH_ACCESS_KEY not set — skipping.');
    return [];
  }

  // Generate 3 intentionally DIFFERENT search angles
  let queries: string[];
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `You are picking stock photos from Unsplash to accompany a LinkedIn post. You need 3 DIFFERENT visual angles — each should find a completely different type of image.

Think about:
- The LITERAL setting (where does this work happen?)
- The HUMAN element (who is involved, what are they doing?)
- The METAPHOR (what visual represents the core idea?)

Provide exactly 3 search queries, one per line. Each must target a DIFFERENT visual concept:
1. The setting or environment
2. The people or activity
3. A visual metaphor or abstract concept

Rules:
- Each query is a SINGLE short phrase (3-5 words)
- Each must produce VISUALLY DIFFERENT results from the others
- Use everyday scenes a stock photo site would have
- Never use niche technical terms (no "reactor", "uranium", "nuclear", "SMR")
- Output ONLY the 3 lines, no numbering, no explanation

Post:
"${postContent.slice(0, 500)}"`,
      }],
    });
    const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '';
    queries = raw.split('\n').map(l => l.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean).slice(0, count);
  } catch (err) {
    console.warn('[stock-image] Keyword extraction failed:', (err as Error).message);
    return [];
  }

  if (queries.length === 0) {
    console.warn('[stock-image] No keywords extracted.');
    return [];
  }

  console.log(`[stock-image] Search angles: ${queries.map(q => `"${q}"`).join(' | ')}`);

  // Run each query independently — one winner per search
  const winners: UnsplashPhoto[] = [];
  const usedPhotoIds = new Set<string>(); // prevent same image across queries

  for (let i = 0; i < queries.length; i++) {
    console.log(`[stock-image] Search ${i + 1}/${queries.length}: "${queries[i]}"`);
    const winner = await searchAndPickBest(queries[i], postContent, usedPhotoIds);
    if (winner) {
      winners.push(winner);
      console.log(`[stock-image] Search ${i + 1} result: "${winner.description.slice(0, 60)}" by ${winner.photographer}`);
      const idMatch = winner.url.match(/photo-([a-zA-Z0-9_-]+)/);
      if (idMatch) usedPhotoIds.add(idMatch[1]);
    } else {
      console.log(`[stock-image] Search ${i + 1} returned no eligible results.`);
    }
  }

  console.log(`[stock-image] Complete: ${winners.length} stock photo(s) found from ${queries.length} searches.`);
  return winners;
}

/**
 * Search Unsplash for a single query, filter, then LLM-pick the best
 * from the top 5 candidates. Returns the single best photo or null.
 */
async function searchAndPickBest(
  query: string,
  postContent: string,
  excludeIds: Set<string>,
): Promise<UnsplashPhoto | null> {
  const results = await fetchUnsplash(query);
  if (results.length === 0) return null;

  const MIN_RATIO = 4 / 5;
  const MAX_RATIO = 16 / 9;

  const filtered = results.filter(r => {
    const ratio = r.width / r.height;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) return false;
    if (isCliche(r)) return false;
    if (isImageUsed(r)) return false;
    // Exclude photos already picked by a previous query in this batch
    const idMatch = r.urls.regular.match(/photo-([a-zA-Z0-9_-]+)/);
    if (idMatch && excludeIds.has(idMatch[1])) return false;
    return true;
  });

  if (filtered.length === 0) {
    console.log(`[stock-image] "${query}" — no candidates after filtering.`);
    return null;
  }

  const top5 = filtered.slice(0, 5);

  // LLM picks the single best from top 5
  let bestIdx = 0;
  try {
    const descriptions = top5.map((r, i) =>
      `${i + 1}. "${r.alt_description ?? r.description ?? 'no description'}"`
    ).join('\n');

    const rankMsg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Pick the ONE image that best matches the mood of this LinkedIn post. Consider visual impact and professionalism.

Post: "${postContent.slice(0, 300)}"

Images:
${descriptions}

Output ONLY the number (e.g. 3). Nothing else.`,
      }],
    });

    const rankRaw = rankMsg.content[0].type === 'text' ? rankMsg.content[0].text.trim() : '';
    const parsed = parseInt(rankRaw.match(/\d+/)?.[0] ?? '1') - 1;
    if (parsed >= 0 && parsed < top5.length) bestIdx = parsed;
    console.log(`[stock-image] "${query}" — LLM picked #${bestIdx + 1} of ${top5.length}: "${top5[bestIdx].alt_description ?? top5[bestIdx].description}"`);
  } catch (err) {
    console.warn(`[stock-image] "${query}" — LLM pick failed, using #1.`);
  }

  const photo = top5[bestIdx];
  const ratio = (photo.width / photo.height).toFixed(2);
  console.log(`[stock-image] Winner: "${photo.alt_description ?? photo.description ?? 'no desc'}" by ${photo.user.name} (${ratio}) [query: "${query}"]`);

  return {
    url: photo.urls.regular,
    downloadUrl: photo.links.download_location,
    photographer: photo.user.name,
    description: photo.alt_description ?? photo.description ?? '',
    searchQuery: query,
  };
}

// Backward-compatible single-image wrapper
export async function searchStockImage(postContent: string): Promise<UnsplashPhoto | null> {
  const results = await searchStockImages(postContent, 1);
  return results[0] ?? null;
}

// --- Unsplash API ---

async function fetchUnsplash(query: string): Promise<RawUnsplashResult[]> {
  console.log(`[stock-image] Searching Unsplash for: "${query}"`);

  try {
    const params = new URLSearchParams({
      query,
      per_page: '15',
      content_filter: 'high',
    });

    const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
      headers: {
        'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`,
        'Accept-Version': 'v1',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[stock-image] Unsplash API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json() as { results: RawUnsplashResult[] };
    console.log(`[stock-image] "${query}" returned ${data.results?.length ?? 0} results.`);
    return data.results ?? [];
  } catch (err) {
    console.warn('[stock-image] Unsplash search failed:', (err as Error).message);
    return [];
  }
}

/**
 * Trigger Unsplash download tracking (required by API terms).
 * Call this when the image is actually used in a post.
 */
export async function trackUnsplashDownload(downloadUrl: string): Promise<void> {
  if (!UNSPLASH_ACCESS_KEY) return;
  try {
    await fetch(`${downloadUrl}?client_id=${UNSPLASH_ACCESS_KEY}`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-fatal — best effort tracking
  }
}
