import dashboardHtml from "../public/dashboard.html?raw";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(dashboardHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
