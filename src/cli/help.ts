const commands = [
  {
    command: 'npm run scheduler',
    description: 'Start the full scheduler (recommended for daily operation)',
    detail: 'Runs continuously. Generates a draft at 7:00pm ET on Mon/Tue/Wed. Publishes approved posts automatically at a randomised time within the next optimal LinkedIn window.',
  },
  {
    command: 'npm run generate',
    description: 'Manually trigger a draft generation',
    detail: 'Fetches RSS feeds, picks the best article, synthesizes a post, and waits for your approval via Telegram.',
  },
  {
    command: 'npm run approve',
    description: 'List all pending posts awaiting approval',
    detail: 'Shows all posts with status "pending" and their IDs.',
  },
  {
    command: 'npm run approve -- --id <post_id>',
    description: 'Approve a specific post',
    detail: 'Schedules the post for publishing at the next optimal LinkedIn time window.',
  },
  {
    command: 'npm run reject -- --id <post_id>',
    description: 'Reject a specific post',
    detail: 'Marks the post as rejected. The source article will be avoided in future generation runs.',
  },
  {
    command: 'npm run post-now',
    description: 'Immediately publish the next approved post',
    detail: 'Bypasses the scheduled time and posts to LinkedIn right away. Useful for manual retries after a publish failure.',
  },
  {
    command: 'npm run build',
    description: 'Compile TypeScript',
    detail: 'Runs tsc. Use this to check for type errors.',
  },
  {
    command: 'npm run help',
    description: 'Show this help message',
    detail: '',
  },
];

console.log('\nAtomic Authority — available commands\n');
console.log('='.repeat(60));

for (const cmd of commands) {
  console.log(`\n  ${cmd.command}`);
  console.log(`  ${cmd.description}`);
  if (cmd.detail) {
    console.log(`  \x1b[2m${cmd.detail}\x1b[0m`);
  }
}

console.log('\n' + '='.repeat(60) + '\n');
