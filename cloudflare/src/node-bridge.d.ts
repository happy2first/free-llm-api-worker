// Public runtime API, currently omitted from Wrangler's generated declarations.
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
declare module 'cloudflare:node' {
  export function handleAsNodeRequest(port: number, request: Request): Promise<Response>;
}
