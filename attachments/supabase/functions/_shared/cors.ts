// Shared CORS headers — every KYC Edge Function is called directly from
// the browser (a different origin than the function's own domain), so
// every response needs these or the browser silently reports "Failed to
// fetch" without ever showing the real error. Same pattern as
// dms-notifications/index.ts elsewhere in this project.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
