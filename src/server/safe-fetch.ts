import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetch a page a consultant pasted, without letting the address reach inside
 * this machine. The server can see the database, the gateway and the local
 * model; a URL like http://localhost:15532 must never be read on anyone's
 * behalf. Redirects are followed by hand so each hop is checked too.
 */

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} is a private or local address and cannot be read.`);
    this.name = "BlockedAddressError";
  }
}

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(v) === 6) {
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    // NAT64 and 6to4 both embed an IPv4 address that may be private.
    if (v.startsWith("64:ff9b:") || v.startsWith("2002:")) return true;
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return true;
}

async function assertPublic(url: URL): Promise<void> {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) addresses can be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new BlockedAddressError(host);
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BlockedAddressError(host);
  }
}

/**
 * Read a body up to `maxBytes`. A pasted URL can point at a multi-gigabyte
 * file; reading it whole would take the server down with it.
 */
export async function readTextCapped(response: Response, maxBytes = 5_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(
        `the page is larger than ${Math.round(maxBytes / 1_000_000)} MB and was not read`,
      );
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Note: the address is checked at resolution time and fetch resolves again,
 * which leaves a DNS-rebinding window; closing it needs a pinned-IP agent.
 */
export async function safeFetch(
  input: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  let url = new URL(input);
  for (let hop = 0; hop <= (init.maxRedirects ?? 5); hop++) {
    await assertPublic(url);
    const response = await fetch(url, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error("Too many redirects.");
}
