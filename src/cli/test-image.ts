import { fetchLatestItems } from '../content/rss.js';
import { fetchArticle } from '../content/fetch-article.js';
import { exec } from 'child_process';

const MAX_PER_FEED = 3;

console.log('\nTesting og:image extraction across RSS sources...\n');
console.log('='.repeat(70));

const items = await fetchLatestItems(MAX_PER_FEED);
console.log(`\nFetched ${items.length} articles. Extracting images...\n`);

let found = 0;
let missing = 0;
const imageUrls: Array<{ source: string; title: string; articleUrl: string; imageUrl: string }> = [];

for (const item of items) {
  if (!item.link) {
    console.log(`[${item.source}] No link — skipping`);
    missing++;
    continue;
  }

  try {
    const fetched = await fetchArticle(item.link);
    if (fetched.imageUrl) {
      found++;
      imageUrls.push({ source: item.source, title: item.title, articleUrl: item.link, imageUrl: fetched.imageUrl });
      console.log(`✓ [${item.source}]`);
      console.log(`  ${item.title.slice(0, 70)}`);
      console.log(`  ${fetched.imageUrl}\n`);
    } else {
      missing++;
      console.log(`✗ [${item.source}] No image found`);
      console.log(`  ${item.title.slice(0, 70)}\n`);
    }
  } catch (err: any) {
    missing++;
    console.log(`✗ [${item.source}] Fetch error: ${err.message}`);
    console.log(`  ${item.title.slice(0, 70)}\n`);
  }
}

console.log('='.repeat(70));
console.log(`\nResult: ${found}/${found + missing} articles had an extractable image (${Math.round(found / (found + missing) * 100)}%)\n`);

if (imageUrls.length > 0) {
  // Build a simple HTML page showing source, title, and image side by side
  const rows = imageUrls.map(({ source, title, articleUrl, imageUrl }) => `
    <tr>
      <td style="padding:12px;vertical-align:top;width:200px;font-family:sans-serif">
        <div style="font-weight:bold;font-size:13px;color:#555">${source}</div>
        <div style="margin-top:6px;font-size:13px"><a href="${articleUrl}" target="_blank">${title}</a></div>
      </td>
      <td style="padding:12px;vertical-align:top">
        <img src="${imageUrl}" style="max-width:480px;max-height:270px;object-fit:cover;border:1px solid #ddd" onerror="this.alt='Failed to load';this.style.border='1px solid red'"/>
        <div style="font-size:11px;color:#999;margin-top:4px;word-break:break-all">${imageUrl}</div>
      </td>
    </tr>
  `).join('<tr><td colspan="2"><hr style="border:none;border-top:1px solid #eee"/></td></tr>');

  const html = `<!DOCTYPE html>
<html><head><title>Image Extraction Test</title></head>
<body style="margin:24px;background:#fafafa">
<h2 style="font-family:sans-serif">og:image extraction — ${imageUrls.length} results</h2>
<table style="border-collapse:collapse;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.1)">${rows}</table>
</body></html>`;

  const tmpFile = 'image-test-preview.html';
  const { writeFileSync } = await import('fs');
  writeFileSync(tmpFile, html);
  exec(`start "" "${tmpFile}"`);
  console.log(`Preview saved to ${tmpFile} and opened in browser.\n`);
}
