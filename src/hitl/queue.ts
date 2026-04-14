import { readFileSync, writeFileSync, existsSync } from 'fs';
import { DraftPost } from '../content/synthesize.js';
import { ScreeningResult } from '../content/screen.js';
import { clearCandidateStore } from '../content/pipeline.js';

const PENDING_FILE = 'pending_posts.json';
const HISTORY_FILE = 'posted_history.json';
const REJECTED_FILE = 'rejected_posts.json';

export interface PendingPost {
  id: string;
  draft: DraftPost;
  screening: ScreeningResult;
  finalContent: string;
  status: 'pending' | 'approved' | 'rejected' | 'published';
  createdAt: string;
  actedAt?: string;
  scheduledFor?: string;  // ISO timestamp — when the scheduler will post this
  publishedAt?: string;   // ISO timestamp — set after successful LinkedIn post
  linkedInPostUrl?: string; // permalink to the live LinkedIn post (for metrics)
  publishFailures?: number; // consecutive publish attempt failures
  imageChoice?: 'ai' | 'og' | 'none' | 'custom'; // which image to use when posting
  wordCount?: number;        // word count of final post content
}

function readFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeFile(path: string, data: unknown): void {
  // Pretty-print but collapse short string arrays (like contentTags) to single lines
  const raw = JSON.stringify(data, null, 2);
  const collapsed = raw.replace(
    /\[\n(\s+)"([^"]+)"(,\n\s+"[^"]+")*\n\s+\]/g,
    (match) => {
      const items = [...match.matchAll(/"([^"]+)"/g)].map(m => `"${m[1]}"`);
      const oneLine = `[${items.join(', ')}]`;
      return oneLine.length <= 120 ? oneLine : match;
    },
  );
  writeFileSync(path, collapsed, 'utf-8');
}

function sanitize(text: string): string {
  return text.replace(/\s*—\s*/g, ' - ');
}

export function addPendingPost(draft: DraftPost, screening: ScreeningResult): PendingPost {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);

  const rawContent = screening.cringeScore > 3 && screening.revisedContent
    ? screening.revisedContent
    : draft.content;
  const finalContent = sanitize(rawContent);

  // Apply screening revision and em dash sanitization to firstComment
  if (draft.firstComment) {
    const rawComment = screening.revisedFirstComment ?? draft.firstComment;
    draft.firstComment = sanitize(rawComment);
  }

  const post: PendingPost = {
    id: `post_${Date.now()}`,
    draft,
    screening,
    finalContent,
    status: 'pending',
    createdAt: new Date().toISOString(),
    wordCount: finalContent.split(/\s+/).filter(Boolean).length,
  };

  posts.push(post);
  writeFile(PENDING_FILE, posts);
  return post;
}

export function getPendingPosts(): PendingPost[] {
  return readFile<PendingPost[]>(PENDING_FILE, []).filter(p => p.status === 'pending');
}

export interface SourceHistory {
  excludedTitles: string[];
  excludedUrls: string[];
  rejectedSources: Array<{ title: string; usedPostType: string }>;
}

export function getSourceHistory(): SourceHistory {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);

  // Hard-exclude: pending or approved posts (not yet published)
  const activePosts = posts.filter(p => p.status === 'pending' || p.status === 'approved');
  const excludedTitles = activePosts.map(p => p.draft.sourceTitle).filter(Boolean);
  const excludedUrls = activePosts.map(p => p.draft.sourceUrl).filter(Boolean);

  // Also hard-exclude all URLs from posted history (no lookback limit)
  const history = readFile<PendingPost[]>(HISTORY_FILE, []);
  const postedUrls = history.map(p => p.draft.sourceUrl).filter(Boolean);
  for (const url of postedUrls) {
    if (!excludedUrls.includes(url)) excludedUrls.push(url);
  }
  const postedTitles = history.map(p => p.draft.sourceTitle).filter(Boolean);
  for (const title of postedTitles) {
    if (!excludedTitles.includes(title)) excludedTitles.push(title);
  }

  const rejected = readFile<PendingPost[]>(REJECTED_FILE, []);

  // Temporarily hard-exclude articles rejected in the last 3 hours
  const cooldownCutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  for (const p of rejected) {
    if (p.actedAt && p.actedAt < cooldownCutoff) continue;
    if (p.draft.sourceUrl && !excludedUrls.includes(p.draft.sourceUrl)) excludedUrls.push(p.draft.sourceUrl);
    if (p.draft.sourceTitle && !excludedTitles.includes(p.draft.sourceTitle)) excludedTitles.push(p.draft.sourceTitle);
  }

  // All-time rejected sources still inform the ranker to try a different post type
  const rejectedSources = rejected
    .map(p => ({ title: p.draft.sourceTitle, usedPostType: p.draft.postType }))
    .filter(s => s.title);

  return { excludedTitles, excludedUrls, rejectedSources };
}

export function approvePost(id: string, scheduledFor: string): PendingPost | null {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return null;

  post.status = 'approved';
  post.actedAt = new Date().toISOString();
  post.scheduledFor = scheduledFor;
  writeFile(PENDING_FILE, posts);

  // Candidate batch is committed — clear so next generate starts fresh
  clearCandidateStore();

  return post;
}

export function getPostsDueForPublishing(): PendingPost[] {
  const now = new Date().toISOString();
  return readFile<PendingPost[]>(PENDING_FILE, []).filter(
    p => p.status === 'approved' && p.scheduledFor != null && p.scheduledFor <= now
  );
}

export function markPublished(id: string, linkedInPostUrl?: string | null): PendingPost | null {
  const publishedAt = new Date().toISOString();

  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return null;

  post.status = 'published';
  post.publishedAt = publishedAt;
  if (linkedInPostUrl) post.linkedInPostUrl = linkedInPostUrl;

  // Remove from pending and archive to history
  writeFile(PENDING_FILE, posts.filter(p => p.id !== id));

  const history = readFile<PendingPost[]>(HISTORY_FILE, []);
  history.push(post);
  writeFile(HISTORY_FILE, history);

  return post;
}

export function setImageChoice(id: string, choice: 'ai' | 'og' | 'none' | 'custom'): void {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return;
  post.imageChoice = choice;
  writeFile(PENDING_FILE, posts);
}

export function setGeneratedImagePath(id: string, imagePath: string): void {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return;
  post.draft.generatedImagePath = imagePath;
  writeFile(PENDING_FILE, posts);
}

export function clearPostImage(id: string): void {
  setImageChoice(id, 'none');
}

export function incrementPublishFailures(id: string): number {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return 0;
  post.publishFailures = (post.publishFailures ?? 0) + 1;
  writeFile(PENDING_FILE, posts);
  return post.publishFailures;
}

export function cleanupRejectedPosts(olderThanDays = 90): number {
  const rejected = readFile<PendingPost[]>(REJECTED_FILE, []);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const trimmed = rejected.filter(p => !(p.actedAt != null && p.actedAt < cutoff));
  const removed = rejected.length - trimmed.length;
  if (removed > 0) {
    writeFile(REJECTED_FILE, trimmed);
    console.log(`Cleaned up ${removed} rejected post(s) older than ${olderThanDays} days.`);
  }
  return removed;
}

export function cancelPost(id: string): PendingPost | null {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return null;
  writeFile(PENDING_FILE, posts.filter(p => p.id !== id));
  clearCandidateStore();
  return post;
}

export function rejectPost(id: string): PendingPost | null {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return null;

  post.status = 'rejected';
  post.actedAt = new Date().toISOString();

  // Remove from pending and archive to rejected_posts.json
  writeFile(PENDING_FILE, posts.filter(p => p.id !== id));
  const rejected = readFile<PendingPost[]>(REJECTED_FILE, []);
  rejected.push(post);
  writeFile(REJECTED_FILE, rejected);

  return post;
}
