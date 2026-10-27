import { env } from 'cloudflare:workers';
import { handlePlans } from '../../../lib/plans-api.js';

export const dynamic = 'force-dynamic';
function handle(request: Request) { return handlePlans(request, env.DB); }
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
