import { env } from 'cloudflare:workers';
import { handleClimbingWorkouts } from '../../../lib/climbing-api.js';

export const dynamic = 'force-dynamic';
function handle(request: Request) { return handleClimbingWorkouts(request, env.DB); }
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
