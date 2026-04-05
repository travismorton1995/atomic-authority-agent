import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import type { PostType } from './persona.js';

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const IMAGE_DIR = path.resolve('generated_images');
const MODEL = '@cf/black-forest-labs/flux-2-dev';
const WIDTH = 1200;
const HEIGHT = 672; // 16:9, divisible by 8 for FLUX models

const client = new Anthropic();

const POST_TYPE_VISUAL_DIRECTION: Record<PostType, string> = {
  bridge: 'Split or layered composition showing two worlds connected. An industrial nuclear facility on one side and a digital/data element on the other, linked visually. Clean, optimistic, warm lighting. The connection between the two should feel tangible, not abstract.',
  contrarian: 'Grounded and serious. Heavy industrial environments, weathered infrastructure, real-world scale. Convey weight, permanence, and deliberate engineering. No futuristic overlays. The mood should feel sobering, like standing next to something massive and consequential.',
  'change-management': 'People-centric. Workers in meetings, at control panels, walking through plant corridors, reviewing documents together. Human scale, not facility scale. Natural indoor lighting. The focus is on people navigating complex systems, not on the systems themselves.',
  explainer: 'Clear and well-lit with a single strong focal point. The specific technology, facility, or concept being explained, shown simply and directly. Educational composition. Think textbook photography or a well-shot facility tour. One subject, clearly presented.',
  'myth-busting': 'Documentary photography style. Real-world evidence that feels concrete, unglamorous, and factual. Show the reality rather than the perception. Natural light, unposed, candid feel. The image should ground the viewer in what actually exists.',
  prediction: 'Forward-looking but grounded. Construction sites with cranes and partially built structures, blueprints laid out on tables, emerging facilities at dawn. Morning or golden hour light. Optimistic but rooted in physical progress, not fantasy.',
  'hot-take': 'High contrast with bold, tight framing. More dramatic crop than other types. Can feel slightly tense or confrontational. Strong shadows, decisive composition. The image should have an edge to it.',
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
- NO people looking at transparent floating data. People look at real screens, real paper, real equipment

OUTPUT: Write ONLY the image prompt (3-4 sentences). No preamble, no explanation, no quotes.`;

export async function generateImagePrompt(postContent: string, postType: PostType): Promise<string> {
  const visualDirection = POST_TYPE_VISUAL_DIRECTION[postType];

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: IMAGE_PROMPT_SYSTEM,
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

    console.log('Calling Cloudflare Workers AI (FLUX.2 Dev)...');
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`;

    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('width', String(WIDTH));
    formData.append('height', String(HEIGHT));
    formData.append('num_steps', '20');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
      body: formData,
    });

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
    console.log(`AI image saved: ${filepath} (${Math.round(imageBuffer.length / 1024)}KB)`);
    return filepath;
  } catch (err: any) {
    console.warn('Image generation failed (non-fatal):', err?.message ?? err);
    return null;
  }
}
