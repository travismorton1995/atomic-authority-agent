import 'dotenv/config';
import { runOutboundPoll } from '../hitl/outbound-poll.js';

await runOutboundPoll();
