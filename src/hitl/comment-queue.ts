import { readFileSync, writeFileSync, existsSync } from 'fs';

const STATE_FILE = 'comment_state.json';

export interface PendingReply {
  id: string;
  postUrl: string;
  postType: string;
  postSnippet: string;       // first line of the published post
  commentId: string;
  commentAuthor: string;
  commentText: string;
  commentType: string;
  isReply: boolean;          // true if this is a reply-to-reply
  replyOptions: [string, string, string];
  status: 'pending' | 'replied' | 'skipped';
  selectedOption?: 1 | 2 | 3;
  createdAt: string;
  repliedAt?: string;
}

interface CommentState {
  lastPollAt: string | null;
  seenCommentIds: string[];
  pendingReplies: PendingReply[];
}

function load(): CommentState {
  if (!existsSync(STATE_FILE)) {
    return { lastPollAt: null, seenCommentIds: [], pendingReplies: [] };
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}

function save(state: CommentState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isCommentSeen(id: string): boolean {
  return load().seenCommentIds.includes(id);
}

export function markCommentSeen(id: string): void {
  const state = load();
  if (!state.seenCommentIds.includes(id)) {
    state.seenCommentIds.push(id);
    // Cap at 1000 to avoid unbounded growth
    if (state.seenCommentIds.length > 1000) {
      state.seenCommentIds = state.seenCommentIds.slice(-1000);
    }
    save(state);
  }
}

export function addPendingReply(reply: PendingReply): void {
  const state = load();
  state.pendingReplies.push(reply);
  save(state);
}

export function getPendingReply(id: string): PendingReply | null {
  return load().pendingReplies.find(r => r.id === id) ?? null;
}

export function updateReplyStatus(id: string, updates: Partial<PendingReply>): void {
  const state = load();
  const idx = state.pendingReplies.findIndex(r => r.id === id);
  if (idx !== -1) {
    state.pendingReplies[idx] = { ...state.pendingReplies[idx], ...updates };
    save(state);
  }
}

export function recordPoll(): void {
  const state = load();
  state.lastPollAt = new Date().toISOString();
  save(state);
}

export function getLastPollAt(): Date | null {
  const s = load();
  return s.lastPollAt ? new Date(s.lastPollAt) : null;
}
