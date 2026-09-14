import { createRemoteJWKSet, jwtVerify } from 'jose';

interface AccessConfig { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// Only the explicit OpenAI API namespace is exempt. Encoded/ambiguous paths
// cannot use the exemption to reach Express's management routes.
export function applicationApi(path: string): boolean {
  return /^\/v1(?:\/|$)/.test(path) && !/[%\\]/.test(path);
}

export async function accessGuard(request: Request, env: AccessConfig): Promise<Response | null> {
  if (applicationApi(new URL(request.url).pathname)) return null;
  const failure = (status: number, message: string) => Response.json(
    { error: { type: 'access_required', message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
  const domain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !env.ACCESS_AUD?.trim()) {
    return failure(503, 'Configure ACCESS_TEAM_DOMAIN and ACCESS_AUD for dashboard Access');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return failure(403, 'Sign in through Cloudflare Access to use the dashboard');
  try {
    const issuer = `https://${domain}`;
    let keys = keySets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      keySets.set(issuer, keys);
    }
    await jwtVerify(token, keys, {
      issuer, audience: env.ACCESS_AUD.trim(), algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    return null;
  } catch {
    return failure(403, 'Cloudflare Access session is invalid or expired');
  }
}
