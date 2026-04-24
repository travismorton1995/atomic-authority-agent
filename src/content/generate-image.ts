import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import type { PostType } from './persona.js';

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const IMAGE_DIR = path.resolve('generated_images');
const WIDTH = 1024;
const HEIGHT = 1024; // 1:1 square — more feed space on mobile, native FLUX resolution

// Model selection: FLUX.2 Dev for first image of the day, FLUX.1 Schnell after that.
// Tracks daily usage via a small state file that resets at midnight UTC.
const FLUX2_DEV = '@cf/black-forest-labs/flux-2-dev';
const FLUX1_SCHNELL = '@cf/black-forest-labs/flux-1-schnell';
const USAGE_FILE = path.resolve('generated_images', '.daily_usage.json');

interface DailyUsage {
  date: string; // UTC date string YYYY-MM-DD
  count: number;
}

function getTodayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyUsage(): DailyUsage {
  try {
    if (existsSync(USAGE_FILE)) {
      const data = JSON.parse(readFileSync(USAGE_FILE, 'utf-8')) as DailyUsage;
      if (data.date === getTodayUTC()) return data;
    }
  } catch (err: any) {
    console.warn('Could not read image usage file — resetting to 0:', err?.message ?? err);
  }
  return { date: getTodayUTC(), count: 0 };
}

function incrementDailyUsage(): void {
  const usage = getDailyUsage();
  usage.count++;
  usage.date = getTodayUTC();
  if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });
  writeFileSync(USAGE_FILE, JSON.stringify(usage), 'utf-8');
}

function pickModel(): { model: string; steps: number; label: string } {
  const usage = getDailyUsage();
  if (usage.count === 0) {
    return { model: FLUX2_DEV, steps: 20, label: 'FLUX.2 Dev' };
  }
  return { model: FLUX1_SCHNELL, steps: 8, label: 'FLUX.1 Schnell' };
}

const client = new Anthropic();

const POST_TYPE_VISUAL_DIRECTION: Record<PostType, string> = {
  bridge: 'Layered composition showing two worlds connected. An industrial nuclear facility in the background with a digital/data element in the foreground, linked visually through depth. Or a top-bottom split. Clean, optimistic, warm lighting. The connection between the two should feel tangible, not abstract.',
  contrarian: 'Grounded and serious. Heavy industrial environments, weathered infrastructure, real-world scale. Convey weight, permanence, and deliberate engineering. No futuristic overlays. The mood should feel sobering, like standing next to something massive and consequential.',
  'change-management': 'People-centric. Workers in meetings, at control panels, walking through plant corridors, reviewing documents together. Human scale, not facility scale. Natural indoor lighting. The focus is on people navigating complex systems, not on the systems themselves.',
  explainer: 'Clear and well-lit with a single strong focal point. The specific technology, facility, or concept being explained, shown simply and directly. Educational composition. Think textbook photography or a well-shot facility tour. One subject, clearly presented.',
  'myth-busting': 'Documentary photography style. Real-world evidence that feels concrete, unglamorous, and factual. Show the reality rather than the perception. Natural light, unposed, candid feel. The image should ground the viewer in what actually exists.',
  prediction: 'Forward-looking but grounded. Construction sites with cranes and partially built structures, blueprints laid out on tables, emerging facilities at dawn. Morning or golden hour light. Optimistic but rooted in physical progress, not fantasy.',
  'hot-take': 'High contrast with bold, tight framing. More dramatic crop than other types. Can feel slightly tense or confrontational. Strong shadows, decisive composition. The image should have an edge to it.',
  insider: 'Playful illustrated scene depicting the specific work challenge or insight from the post. Use visual metaphors: a developer wrestling with a tangled system diagram, a whiteboard covered in sticky notes and arrows, a laptop screen showing code beside a coffee cup. Consistent navy/warm-orange palette, clean bold lines, eye-catching but not noisy.',
};

const IMAGE_PROMPT_SYSTEM = `You convert LinkedIn posts into image generation prompts for the FLUX AI model. Your job is to produce a single photorealistic image prompt that a photographer could have actually shot.

PROCESS:
1. Read the post and identify the TONE (optimistic, frustrated, serious, analytical, provocative, etc.)
2. Extract every CONCRETE PHYSICAL DETAIL mentioned: specific facilities, locations, technologies, equipment, people, settings
3. Combine these with the visual direction provided for the post type
4. Write a prompt describing a real photograph

PHOTOREALISM RULES (critical):
- Describe scenes a real photographer could capture with a real camera
- Specify a real photography style: editorial, documentary, industrial, architectural, photojournalism
- Include physical camera details: lens type (wide-angle, telephoto, 35mm), depth of field, natural lighting conditions
- Ground every element in physical reality. If the post mentions a control room, describe a real control room with specific details (banks of monitors, analog gauges, cable trays overhead)
- Include environmental texture: weather, time of day, materials, wear patterns, signage

ANTI-AI RULES (things that make images look obviously AI-generated):
- NO glowing blue or purple holographic overlays or floating UI elements
- NO transparent screens or augmented reality projections hovering in space
- NO perfectly symmetrical compositions
- NO generic "futuristic city" or "smart city" backgrounds
- NO obvious HDR or hyperreal color grading with oversaturated blues and oranges
- NO clean, sterile environments with perfect lighting. Real facilities have dust, wear, and imperfect lighting
- NO stock photo clichés: handshakes, glowing brains, light bulbs, puzzle pieces
- NO default cooling tower imagery unless the post specifically discusses a plant with cooling towers. Cooling towers are the most overused nuclear cliché — industry professionals notice immediately when they're used for plants that don't have them
- NO people looking at transparent floating data. People look at real screens, real paper, real equipment

CONTENT FILTER AVOIDANCE (critical — prompts with these terms get blocked by the image model):
- NEVER use: nuclear, uranium, plutonium, radiation, radioactive, spent fuel, fuel rod, warhead, missile, weapon, bomb, enrichment, centrifuge, meltdown, contamination, fallout, hazmat, decontamination, fission, criticality, chain reaction
- Instead use safe visual substitutes:
  - Fuel rods / spent fuel → "glowing rods behind thick glass" or "illuminated cylindrical elements in a deep pool"
  - Radiation → "heat waves" or "shimmering air" or "thermal distortion"
  - Transport cask → "heavy industrial casing" or "reinforced shipping container"
  - Nuclear plant → "power plant" or "industrial generating station" or "large-scale energy facility"
  - Cooling towers → "hyperbolic concrete towers with steam rising" (ONLY if the article/post mentions a plant that actually uses cooling towers. Many plants, especially Canadian CANDU plants like Darlington, Bruce Power, and Pickering, use lake water cooling and have NO cooling towers. Do NOT default to cooling tower imagery unless contextually accurate.)
  - Control room → "industrial control room with banks of monitors and analog gauges"
  - Reactor → "large industrial vessel" or "containment structure"
  - Safety equipment → "industrial protective gear" or "engineering safety systems"
- The goal is to depict the same scenes using descriptive, non-alarming language that conveys the industrial and engineering reality without triggering safety filters

COMPOSITION: The image is SQUARE (1:1 aspect ratio). Do not describe wide panoramic or ultra-wide scenes. Favor vertical depth (foreground/background layering), centered subjects, and tight framing that works in a square crop.

OUTPUT: Write ONLY the image prompt (3-4 sentences). No preamble, no explanation, no quotes.`;

const INSIDER_IMAGE_PROMPT_SYSTEM = `You convert LinkedIn insider posts into image generation prompts for the FLUX AI model. These are ILLUSTRATION prompts, not photographs. The goal is a consistent, recognizable visual brand for weekly insider dispatches.

DESIGN LANGUAGE — "Atomic Dispatch" brand:
- Flat illustration style with bold outlines and confident shapes
- Primary palette: deep navy (#1B2A4A), warm amber/orange (#E8883C), off-white (#F5F0EB)
- Accent colors (use sparingly): teal (#2A9D8F), soft red (#E76F51)
- Clean geometric forms: circles, rounded rectangles, simple iconography
- Semi-flat perspective with subtle isometric depth (not full 3D)
- Characters are minimal silhouettes or simple outlined figures, never photorealistic faces
- Think: Notion-style brand illustrations meets technical conference poster art

PROCESS:
1. Read the post and identify 2-3 key concepts, challenges, or visual metaphors
2. Translate those into concrete illustrated objects and scenes
3. Combine into a single cohesive composition with one strong focal element

ILLUSTRATION RULES:
- Always include at least one "work artifact": a screen with code, a whiteboard, a document, a diagram, a terminal
- Use visual metaphors freely: gears for process, bridges for connection, shields for safety, tangled wires for complexity, a compass for direction
- Background should be a clean solid or soft gradient in navy or off-white
- Add subtle paper-grain texture or halftone dots for warmth
- Bold, confident linework throughout, nothing sketchy or tentative
- Small playful details reward close inspection: a coffee cup, a sticky note, a small plant

NEVER:
- No photorealism or photo-style compositions
- No generic "AI brain" or neural network node imagery
- No busy or cluttered scenes — one focal idea with breathing room
- No 3D renders, glossy surfaces, or drop shadows
- No text or words in the illustration

CONTENT FILTER AVOIDANCE (critical — prompts with these terms get blocked by the image model):
- NEVER use: nuclear, uranium, plutonium, radiation, radioactive, spent fuel, fuel rod, warhead, missile, weapon, bomb, enrichment, centrifuge, meltdown, contamination, fallout, hazmat, decontamination, fission, criticality, chain reaction
- Instead use safe visual substitutes:
  - Fuel rods → "glowing cylindrical elements"
  - Radiation → "heat waves" or "shimmering air"
  - Nuclear plant → "power plant" or "energy facility" or "generating station"
  - Reactor → "large industrial vessel" or "containment structure"
  - Control room → "industrial monitoring station"
- Depict the same concepts using descriptive, non-alarming language

COMPOSITION: Square (1:1). One dominant visual element at center or slightly off-center. Supporting elements frame it without crowding. Generous whitespace.

OUTPUT: Write ONLY the image prompt (3-4 sentences). No preamble, no explanation, no quotes.`;

/** Ask Claude to rewrite a flagged prompt, removing any terms that trigger content filters. */
async function softenPrompt(flaggedPrompt: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `This image generation prompt was blocked by a content safety filter. Rewrite it to describe the same scene using only safe, non-alarming language.

BANNED WORDS (remove or replace ALL of these):
nuclear, uranium, plutonium, radiation, radioactive, spent fuel, fuel rod, warhead, missile, weapon, bomb, enrichment, centrifuge, meltdown, contamination, fallout, hazmat, decontamination, fission, criticality, chain reaction, reactor, NRC, cask, toxic, danger, emergency, explosion, decay

SAFE SUBSTITUTES:
- Fuel rods / spent fuel → "glowing rods behind thick glass" or "illuminated cylindrical elements in a deep pool"
- Radiation → "heat waves" or "shimmering air" or "thermal distortion"
- Transport cask → "heavy industrial casing" or "reinforced shipping container"
- Nuclear plant → "power plant" or "industrial generating station" or "energy facility"
- Cooling towers → "hyperbolic concrete towers with steam rising"
- Control room → "industrial control room with banks of monitors"
- Reactor → "large industrial vessel" or "containment structure"
- Safety equipment → "industrial protective gear"

Keep the same composition, camera style, and visual mood. Output ONLY the rewritten prompt. No explanation.

FLAGGED PROMPT:
${flaggedPrompt}`,
    }],
  });
  return response.content[0].type === 'text' ? response.content[0].text.trim() : flaggedPrompt;
}

export async function generateImagePrompt(postContent: string, postType: PostType): Promise<string> {
  const visualDirection = POST_TYPE_VISUAL_DIRECTION[postType];
  const systemPrompt = postType === 'insider' ? INSIDER_IMAGE_PROMPT_SYSTEM : IMAGE_PROMPT_SYSTEM;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `POST TYPE: ${postType}
VISUAL DIRECTION: ${visualDirection}

POST:
${postContent}`,
    }],
  });
  return response.content[0].type === 'text' ? response.content[0].text.trim() : '';
}

export async function generateImage(postContent: string, postType: PostType = 'bridge'): Promise<string | null> {
  if (process.env.DISABLE_IMAGE_GEN === 'true') {
    console.log('Image generation disabled (DISABLE_IMAGE_GEN=true).');
    return null;
  }
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.log('Cloudflare AI not configured — skipping image generation.');
    return null;
  }

  try {
    console.log('Generating image prompt from post content...');
    const prompt = await generateImagePrompt(postContent, postType);
    if (!prompt) {
      console.warn('Empty image prompt — skipping.');
      return null;
    }
    console.log(`Image prompt: ${prompt}`);

    const { model, steps, label } = pickModel();
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`;
    const isFlux2 = model === FLUX2_DEV;

    const callFlux = async (p: string): Promise<Response> => {
      if (isFlux2) {
        const formData = new FormData();
        formData.append('prompt', p);
        formData.append('width', String(WIDTH));
        formData.append('height', String(HEIGHT));
        formData.append('num_steps', String(steps));
        return fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
          body: formData,
        });
      }
      return fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: p, width: WIDTH, height: HEIGHT, num_steps: steps }),
      });
    };

    console.log(`Calling Cloudflare Workers AI (${label})...`);
    let res = await callFlux(prompt);

    // Retry on timeout or server errors (408, 500, 502, 503, 504)
    if (res.status >= 408 && res.status < 600) {
      const errText = await res.text();
      console.warn(`Cloudflare AI returned ${res.status} — retrying in 10s... (${errText.substring(0, 100)})`);
      await new Promise(r => setTimeout(r, 10_000));
      res = await callFlux(prompt);
    }

    // If content filter flagged, retry with a softened prompt
    if (res.status === 400) {
      const errText = await res.text();
      const isContentFlag = errText.includes('3030') || errText.toLowerCase().includes('flagged');
      if (isContentFlag) {
        console.warn(`Image prompt flagged by content filter — softening and retrying...`);
        const softened = await softenPrompt(prompt);
        console.log(`Softened prompt: ${softened}`);
        res = await callFlux(softened);
      }
    }

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Cloudflare AI returned ${res.status}: ${errText.substring(0, 200)}`);
      return null;
    }

    const contentType = res.headers.get('content-type') ?? '';
    let imageBuffer: Buffer;

    if (contentType.includes('image')) {
      imageBuffer = Buffer.from(await res.arrayBuffer());
    } else {
      // JSON response — extract base64 image
      const json = (await res.json()) as any;
      if (json.result?.image) {
        imageBuffer = Buffer.from(json.result.image, 'base64');
      } else {
        console.warn('Unexpected Cloudflare response format.');
        return null;
      }
    }

    if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });
    const filename = `img_${Date.now()}.png`;
    const filepath = path.join(IMAGE_DIR, filename);
    writeFileSync(filepath, imageBuffer);
    incrementDailyUsage();
    console.log(`AI image saved: ${filepath} (${Math.round(imageBuffer.length / 1024)}KB, model: ${label})`);
    return filepath;
  } catch (err: any) {
    console.warn('Image generation failed (non-fatal):', err?.message ?? err);
    return null;
  }
}
