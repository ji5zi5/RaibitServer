import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainRentals, domainRentalHostname } from './domain-rentals.ts';

/** Host-based routing precedes the /api prefix. Never proxy/fetch the target. */
export async function handleDomainRentalRedirect(
  rentals: DomainRentals, request: IncomingMessage, response: ServerResponse,
): Promise<boolean> {
  if (!domainRentalHostname(request.headers.host, rentals.config)) return false;
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const end = (status: number, message: string) => {
    response.statusCode = status;
    response.end(request.method === 'HEAD' ? undefined : message);
    return true;
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return end(405, 'This address only supports GET and HEAD.');
  }
  try {
    const destination = await rentals.resolve(request.headers.host);
    if (!destination) return end(404, 'This address is not available.');
    // Do not forward request query strings, paths, cookies or authorization.
    // The stored destination (including its own query and fragment) is exact.
    response.setHeader('Location', destination);
    return end(302, 'Redirecting.');
  } catch {
    return end(503, 'This address is temporarily unavailable.');
  }
}
