import { env } from 'cloudflare:workers';
import { handleWorkouts } from '../../../lib/workout-api.js';
import archiveContext from '../../../lib/archive-context.json';

export const dynamic = 'force-dynamic';

function handle(request: Request) {
  return handleWorkouts(request, env.DB, archiveContext);
}

export { handle as GET, handle as POST, handle as DELETE };
