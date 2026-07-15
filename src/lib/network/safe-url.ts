import 'server-only';

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

type LookupAddress = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  // IETF protocol/documentation and benchmarking ranges are not destinations
  // an external-browser feature needs to reach.
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith('ff')) return false;
  if (normalized.startsWith('2001:db8:')) return false;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);

  // IPv4-mapped IPv6 also has a legal hexadecimal spelling, e.g.
  // ::ffff:7f00:1 for 127.0.0.1. Expand the address before inspecting the
  // final 32 bits so alternate text forms cannot bypass the IPv4 policy.
  const halves = normalized.split('::');
  if (halves.length <= 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
    const words = [...left, ...Array(Math.max(0, zeros)).fill('0'), ...right];
    if (words.length === 8 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
      const values = words.map((word) => Number.parseInt(word, 16));
      if (values.slice(0, 5).every((word) => word === 0) && values[5] === 0xffff) {
        const ipv4 = [values[6] >> 8, values[6] & 0xff, values[7] >> 8, values[7] & 0xff].join('.');
        return isPublicIpv4(ipv4);
      }
    }
  }
  return true;
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address.split('%')[0]);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function systemLookup(hostname: string): Promise<LookupAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Validate an engine-tier URL before Chrome can request it. Every DNS answer
 * must be public; mixed public/private answers are rejected so an attacker
 * cannot choose the private result through DNS rebinding or resolver order.
 */
export async function assertPublicHttpUrl(rawUrl: string, lookupAll: LookupAll = systemLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Browser URL is invalid.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Browser URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Browser URLs cannot contain credentials.');
  }

  // WHATWG URL keeps brackets around IPv6 hostnames in Node. Strip them before
  // net.isIP/DNS handling so literal IPv6 targets cannot fall into hostname
  // resolution with a different policy path.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('The external browser cannot access local hosts.');
  }

  if (isIP(hostname)) {
    if (!isPublicNetworkAddress(hostname)) throw new Error('The external browser cannot access private network addresses.');
    return url;
  }

  const addresses = await lookupAll(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
    throw new Error('The browser target resolves to a private or non-routable address.');
  }
  return url;
}
