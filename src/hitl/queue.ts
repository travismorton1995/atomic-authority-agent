import { readFileSync, writeFileSync, existsSync } from 'fs';
import { DraftPost } from '../content/synthesize.js';
import { ScreeningResult } from '../content/screen.js';

const PENDING_FILE = 'pending_posts.json';
const HISTORY_FILE = 'posted_history.json';

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
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
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

  const post: PendingPost = {
    id: `post_${Date.now()}`,
    draft,
    screening,
    finalContent,
    status: 'pending',
    createdAt: new Date().toISOString(),
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
  rejectedSources: Array<{ title: string; usedPostType: string }>;
}

export function getSourceHistory(): SourceHistory {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const excludedTitles = posts
    .filter(p => p.status === 'pending' || p.status === 'approved')
    .map(p => p.draft.sourceTitle)
    .filter(Boolean);
  const rejectedSources = posts
    .filter(p => p.status === 'rejected')
    .map(p => ({ title: p.draft.sourceTitle, usedPostType: p.draft.postType }))
    .filter(s => s.title);
  return { excludedTitles, rejectedSources };
}

export function approvePost(id: string, scheduledFor: string): PendingPost | null {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return null;

  post.status = 'approved';
  post.actedAt = new Date().toISOString();
  post.scheduledFor = scheduledFor;
  writeFile(PENDING_FILE, posts);

  const history = readFile<PendingPost[]>(HISTORY_FILE, []);
  history.push(post);
  writeFile(HISTORY_FILE, history);

  return post;
}

export function getPostsDueForPublishing(): PendingPost[] {
  const now = new Date().toISOString();
  return readFile<PendingPost[]>(PENDING_FILE, []).filter(
    p => p.status === 'approved' && p.scheduledFor != null && p.scheduledFor <= now
  );
}

export function markPublished(id: string): PendingPost | null {
  const publishedAt = new Date().toISOString();

  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return null;

  post.status = 'published';
  post.publishedAt = publishedAt;
  writeFile(PENDING_FILE, posts);

  // Sync updated status back into history
  const history = readFile<PendingPost[]>(HISTORY_FILE, []);
  const historyEntry = history.find(p => p.id === id);
  if (historyEntry) {
    historyEntry.status = 'published';
    historyEntry.publishedAt = publishedAt;
    writeFile(HISTORY_FILE, history);
  }

  return post;
}

export function rejectPost(id: string): PendingPost | null {
  const posts = readFile<PendingPost[]>(PENDING_FILE, []);
  const post = posts.find(p => p.id === id);
  if (!post) return null;

  post.status = 'rejected';
  post.actedAt = new Date().toISOString();
  writeFile(PENDING_FILE, posts);
  return post;
}
