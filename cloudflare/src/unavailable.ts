// Only optional native modules are mapped here, never a routing/provider module.
export default function unavailable(): never {
  throw new Error('This optional native module is unavailable on Cloudflare Workers');
}
export class ProxyAgent { constructor() { unavailable(); } }
export class SocksProxyAgent { constructor() { unavailable(); } }
