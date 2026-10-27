import { env } from 'cloudflare:workers';
import { handleHangboardWorkouts } from '../../../lib/hangboard-api.js';

export const dynamic = 'force-dynamic';
function handle(request: Request) { return handleHangboardWorkouts(request, env.DB); }
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
