import 'dotenv/config';
import { runCommentPoll } from '../hitl/comment-poll.js';

const url = process.argv[2];
await runCommentPoll(url);
