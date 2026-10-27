import { env } from 'cloudflare:workers';
import { handleRecordDeletions } from '../../../lib/record-deletions-api.js';
import archiveContext from '../../../lib/archive-context.json';

export const dynamic = 'force-dynamic';
function handle(request: Request) { return handleRecordDeletions(request, env.DB, archiveContext); }
export { handle as GET, handle as POST, handle as DELETE };
