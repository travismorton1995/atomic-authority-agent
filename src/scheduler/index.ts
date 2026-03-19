import 'dotenv/config';
import cron from 'node-cron';
import { pickPostTime } from './windows.js';

function scheduleTodayGeneration() {
  const day = new Date().getDay(); // 0=Sun, 6=Sat
  // Skip weekends (0, 6)
  if (day === 0 || day === 6) {
    console.log('Weekend — no post scheduled today.');
    return;
  }

  const { hour, minute } = pickPostTime();
  const cronExpr = `${minute} ${hour} * * *`;
  console.log(`Scheduled generation for today at ${hour}:${String(minute).padStart(2, '0')} ET (cron: ${cronExpr})`);

  cron.schedule(cronExpr, async () => {
    console.log('Scheduler triggered — running generate...');
    // Dynamically import to avoid loading dotenv twice
    const { default: { execSync } } = await import('child_process') as any;
    try {
      execSync('npm run generate', { stdio: 'inherit' });
    } catch (err) {
      console.error('Generate failed:', err);
    }
    // Reschedule for tomorrow
    scheduleTodayGeneration();
  }, { timezone: 'America/Toronto' });
}

console.log('Atomic Authority scheduler starting...');
scheduleTodayGeneration();

// Re-schedule at midnight each day
cron.schedule('0 0 * * *', () => {
  console.log('Midnight — recalculating post time for today...');
  scheduleTodayGeneration();
}, { timezone: 'America/Toronto' });
