import 'dotenv/config';
import { runPipeline } from '../content/pipeline.js';
import { startBot, waitForAction } from '../hitl/telegram.js';

async function main() {
  startBot();
  let action: 'approved' | 'rejected';
  do {
    const post = await runPipeline();
    console.log('Waiting for your approval in Telegram...');
    action = await waitForAction(post.id);
    if (action === 'rejected') {
      console.log('Post rejected — generating a replacement...');
    }
  } while (action === 'rejected');
  console.log('Post approved. Exiting.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
