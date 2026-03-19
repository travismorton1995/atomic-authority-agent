import 'dotenv/config';
import { runPipeline } from '../content/pipeline.js';
import { startBot, waitForAction } from '../hitl/telegram.js';

async function main() {
  startBot();
  const post = await runPipeline();
  console.log('Waiting for your approval in Telegram...');
  await waitForAction(post.id);
  console.log('Post actioned. Exiting.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
