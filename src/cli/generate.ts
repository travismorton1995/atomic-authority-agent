import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { runPipeline } from '../content/pipeline.js';
import { startBot, waitForAction } from '../hitl/telegram.js';
import { getPendingPosts } from '../hitl/queue.js';

function isSchedulerRunning(): boolean {
  const lockFile = path.resolve('scheduler.lock');
  if (!existsSync(lockFile)) return false;
  const pid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);
  if (isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Poll pending_posts.json for status changes — used when the scheduler's bot handles approvals
function pollForAction(postId: string): Promise<'approved' | 'rejected' | 'cancelled'> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const posts = getPendingPosts();
      const post = posts.find(p => p.id === postId);
      if (!post) { clearInterval(interval); resolve('cancelled'); return; }
      if (post.status === 'approved' || post.status === 'published') { clearInterval(interval); resolve('approved'); return; }
      if (post.status === 'rejected') { clearInterval(interval); resolve('rejected'); return; }
    }, 3000);
  });
}

function parseArgs(): { url?: string; topic?: string } {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const topicIdx = args.indexOf('--topic');
  return {
    url: urlIdx !== -1 ? args[urlIdx + 1] : undefined,
    topic: topicIdx !== -1 ? args.slice(topicIdx + 1).join(' ') : undefined,
  };
}

async function main() {
  const options = parseArgs();
  const schedulerRunning = isSchedulerRunning();
  if (schedulerRunning) {
    console.log('Scheduler is running — it will handle Telegram notifications.');
  } else {
    startBot();
  }
  let action: 'approved' | 'rejected' | 'cancelled';
  do {
    const post = await runPipeline(options);
    console.log('Waiting for your approval in Telegram...');
    action = schedulerRunning ? await pollForAction(post.id) : await waitForAction(post.id);
    if (action === 'cancelled') {
      console.log('Post cancelled. Exiting.');
      process.exit(0);
    }
    if (action === 'rejected') {
      console.log('Post rejected — generating a replacement...');
      delete options.url;
      delete options.topic;
    }
  } while (action === 'rejected');
  console.log('Post approved. Exiting.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
