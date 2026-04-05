import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';

const USER_DATA_DIR = path.resolve('user_data');

// Candidate hashtags to research — organized by category
const CANDIDATES = [
  // Nuclear industry
  'NuclearEnergy', 'NuclearPower', 'NuclearIndustry', 'NuclearSafety', 'NuclearInnovation',
  'SMR', 'AdvancedReactors', 'Fusion', 'FusionEnergy', 'CANDU',
  'NuclearFuel', 'Uranium', 'Thorium', 'Decommissioning',
  'MedicalIsotopes', 'NuclearMedicine',
  // Nuclear orgs / regulation
  'IAEA', 'NRC', 'CNSC',
  // AI / tech
  'ArtificialIntelligence', 'MachineLearning', 'DeepLearning', 'GenerativeAI', 'GenAI',
  'LLM', 'AI', 'AIGovernance', 'AISafety', 'ResponsibleAI',
  'DigitalTwin', 'DigitalTransformation', 'Automation',
  // Energy
  'EnergyTransition', 'CleanEnergy', 'NetZero', 'Decarbonization',
  'EnergyPolicy', 'EnergySecurity', 'Electricity', 'PowerGeneration',
  'RenewableEnergy', 'GridReliability',
  // Intersection / applied
  'AIinEnergy', 'NuclearAI', 'CriticalInfrastructure', 'CyberSecurity',
  'RiskManagement', 'SafetyCulture', 'ChangeManagement',
  'WorkforceDevelopment', 'STEM',
  // Geography
  'CanadianEnergy', 'OntarioEnergy',
];

async function scrapeHashtagFollowers(): Promise<void> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: process.env.LINKEDIN_HEADLESS === 'true',
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? await context.newPage();
  const results: Array<{ hashtag: string; followers: string | null; url: string }> = [];

  console.log(`Researching ${CANDIDATES.length} hashtags...\n`);

  for (const tag of CANDIDATES) {
    const url = `https://www.linkedin.com/feed/hashtag/${tag.toLowerCase()}/`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);

      // LinkedIn shows follower count in various places — try multiple selectors
      const followerText = await page.evaluate(() => {
        // Look for text containing "follower" anywhere on the page
        const allText = document.body.innerText;
        const match = allText.match(/([\d,\.]+[KMB]?)\s*followers?/i);
        return match ? match[1] : null;
      });

      results.push({ hashtag: `#${tag}`, followers: followerText, url });
      const display = followerText ?? 'not found';
      console.log(`  #${tag.padEnd(25)} ${display} followers`);
    } catch (err) {
      console.warn(`  #${tag.padEnd(25)} ERROR: ${(err as Error).message.slice(0, 60)}`);
      results.push({ hashtag: `#${tag}`, followers: null, url });
    }
  }

  await context.close();

  // Summary table sorted by follower count
  console.log('\n--- SUMMARY (sorted by followers) ---\n');

  const parsed = results.map(r => {
    let count = 0;
    if (r.followers) {
      const clean = r.followers.replace(/,/g, '');
      const multiplierMatch = clean.match(/([\d.]+)\s*([KMB])?/i);
      if (multiplierMatch) {
        count = parseFloat(multiplierMatch[1]);
        const suffix = (multiplierMatch[2] ?? '').toUpperCase();
        if (suffix === 'K') count *= 1000;
        else if (suffix === 'M') count *= 1000000;
        else if (suffix === 'B') count *= 1000000000;
      }
    }
    return { ...r, count };
  });

  parsed.sort((a, b) => b.count - a.count);

  console.log('Hashtag'.padEnd(30) + 'Followers');
  console.log('-'.repeat(50));
  for (const r of parsed) {
    const display = r.followers ?? 'N/A';
    console.log(`${r.hashtag.padEnd(30)}${display}`);
  }
}

scrapeHashtagFollowers().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
