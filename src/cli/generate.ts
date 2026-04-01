import 'dotenv/config';
import { runPipeline } from '../content/pipeline.js';
import { startBot, waitForAction } from '../hitl/telegram.js';

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
  startBot();
  let action: 'approved' | 'rejected' | 'cancelled';
  do {
    const post = await runPipeline(options);
    console.log('Waiting for your approval in Telegram...');
    action = await waitForAction(post.id);
    if (action === 'cancelled') {
      console.log('Post cancelled. Exiting.');
      process.exit(0);
    }
    if (action === 'rejected') {
      console.log('Post rejected — generating a replacement...');
      // On retry, fall back to RSS so we don't regenerate the same custom input
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
