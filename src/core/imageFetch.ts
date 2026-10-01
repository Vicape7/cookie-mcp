// Fetch a remote logo so it can be re-pinned to IPFS.
//
// `imageUrl` used to be stored verbatim in the token's metadata JSON, and nothing on the path — not
// this server, not the launchpad backend — ever pinned it. The metadata is immutable, so the logo
// was a permanent pointer at someone else's host: when that link rots, expires, or turns out to have
// been a signed URL, the token's image is gone and cannot be replaced. We fetch the bytes and pin
// them instead, which is what the tool description always claimed happened.
//
// This server runs on the user's machine, so a URL it fetches is a request from inside their
// network. Every hop is therefore checked against the private address space *after* DNS resolution
// and redirects are followed by hand, so a public hostname cannot bounce us onto localhost or a
// cloud metadata endpoint. The check also runs inside the socket's own DNS lookup (`pinnedLookup`),
// so the address that was checked is the address connected to: a rebinding name that answers public
// for the pre-check and private a moment later still cannot get through.
import dns from "node:dns/promises";
import https from "node:https";
import type { LookupFunction } from "node:net";
import net from "node:net";

import { HTTP_TIMEOUT_MS } from "./config";
import { CookieMcpError } from "./errors";
import { MAX_IMAGE_BYTES, sniffImageMimeType } from "./imageFile";

/** Redirect hops to follow before giving up — real image hosts use one or two. */
const MAX_REDIRECTS = 3;

function ipv4IsPrivate(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments + TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Parse an IPv6 literal into its 16 bytes (pure). Handles `::` compression and a trailing dotted
 * IPv4, which is the point: `URL` normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a
 * regex on the dotted form misses it. Null when it is not valid IPv6.
 */
export function ipv6Bytes(ip: string): Uint8Array | null {
  let v = ip.toLowerCase();
  const zone = v.indexOf("%");
  if (zone >= 0) v = v.slice(0, zone);
  if (!net.isIPv6(v)) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (tail) {
    const [a, b, c, d] = tail[1]!.split(".").map(Number) as [number, number, number, number];
    v =
      v.slice(0, -tail[1]!.length) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }
  const [head, rest] = v.includes("::") ? v.split("::") : [v, null];
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const groups =
    rest === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g || "0", 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

function v4At(b: Uint8Array, at: number): string {
  return `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;
}

function ipv6IsPrivate(b: Uint8Array): boolean {
  const zero = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  // ::/96 — unspecified, loopback and the deprecated IPv4-compatible form (::a.b.c.d).
  if (zero(0, 12))
    return zero(12, 16) || (zero(12, 15) && b[15] === 1) || ipv4IsPrivate(v4At(b, 12));
  // ::ffff:0:0/96 IPv4-mapped, and ::ffff:0:0:0/96 IPv4-translated (SIIT).
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4IsPrivate(v4At(b, 12));
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12))
    return ipv4IsPrivate(v4At(b, 12));
  // 64:ff9b::/96 well-known NAT64 embeds the IPv4 target; 64:ff9b:1::/48 is local-use NAT64.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return ipv4IsPrivate(v4At(b, 12));
    return b[4] === 0x00 && b[5] === 0x01;
  }
  // 2002::/16 6to4 embeds the IPv4 in bytes 2–5.
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4IsPrivate(v4At(b, 2));
  // 2001::/32 Teredo tunnels to an arbitrary IPv4 (obfuscated); 2001:db8::/32 is documentation.
  if (
    b[0] === 0x20 &&
    b[1] === 0x01 &&
    ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))
  ) {
    return true;
  }
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true; // 100::/64 discard
  if ((b[0]! & 0xfe) === 0xfc) return true; // unique-local fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // site-local fec0::/10 (deprecated)
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** Is this address one we refuse to fetch from? (pure) */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(v)) return ipv4IsPrivate(v);
  const bytes = ipv6Bytes(v);
  if (!bytes) return true; // unparseable → refuse
  return ipv6IsPrivate(bytes);
}

/**
 * A `net` lookup that resolves, refuses if ANY answer is private, and hands the socket only checked
 * addresses. Used by the request itself, so there is no gap between checking and connecting.
 */
export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  dns
    .lookup(hostname, {
      all: true,
      ...(options.family ? { family: options.family } : {}),
      ...(options.hints ? { hints: options.hints } : {}),
    })
    .then((addrs) => {
      if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
        const err = Object.assign(new Error(`${hostname} resolves inside a private network`), {
          code: "EPRIVATE",
        });
        callback(err, "", 0);
        return;
      }
      if (options.all) callback(null, addrs);
      else callback(null, addrs[0]!.address, addrs[0]!.family);
    })
    .catch((e: NodeJS.ErrnoException) => callback(e, "", 0));
};

/** The slice of `Response` this module reads — what `httpsGet` returns and tests fake. */
export interface ImageResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type ImageGet = (url: URL, signal: AbortSignal) => Promise<ImageResponse>;

/**
 * GET over https with the connection pinned to a checked address (`pinnedLookup`), no redirects
 * followed, and the body capped one byte past the limit so an endless response cannot fill memory.
 */
export const httpsGet: ImageGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { lookup: pinnedLookup, signal, headers: { Accept: "image/*" } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const body = new Promise<ArrayBuffer>((ok, fail) => {
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_IMAGE_BYTES + 1) {
              chunks.push(c.subarray(0, MAX_IMAGE_BYTES + 1 - (size - c.length)));
              res.destroy();
              return;
            }
            chunks.push(c);
          });
          const done = () => {
            const b = Buffer.concat(chunks);
            ok(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
          };
          res.on("end", done);
          res.on("close", done);
          res.on("error", fail);
        });
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (name) => {
              const h = res.headers[name.toLowerCase()];
              return Array.isArray(h) ? (h[0] ?? null) : (h ?? null);
            },
          },
          arrayBuffer: () => body,
        });
      },
    );
    req.on("error", reject);
  });

/** Reject anything that is not a plain https URL to a public host. Resolves DNS. */
async function assertFetchableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CookieMcpError(
      `imageUrl is not a valid URL: ${raw}`,
      "pass a full https URL, or use imagePath for a file on this machine",
    );
  }
  if (url.protocol !== "https:") {
    throw new CookieMcpError(
      `imageUrl must be https, got ${url.protocol.replace(":", "") || "no scheme"}`,
      "an http or file URL cannot be pinned; use imagePath for a local file",
    );
  }

  // A literal IP skips DNS; a hostname is resolved and every answer must be public.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw privateHostError(url);
    return url;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new CookieMcpError(
      `cannot resolve ${host}`,
      "check the URL; the launch was not sent, so nothing was spent",
    );
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw privateHostError(url);
  return url;
}

function privateHostError(url: URL): CookieMcpError {
  return new CookieMcpError(
    `refusing to fetch ${url.hostname} — it resolves inside a private network`,
    "the logo has to be reachable publicly so it can be pinned; use imagePath for a local file",
  );
}

/**
 * Download a remote image and return it ready for `uploadImage`. Follows redirects manually,
 * re-checking each hop. Throws a `CookieMcpError` the caller can surface verbatim — this runs before
 * any spend, so every failure here is free.
 */
export async function fetchRemoteImage(
  raw: string,
  get: ImageGet = httpsGet,
): Promise<{ base64: string; mimeType: string; bytes: number }> {
  let url = await assertFetchableUrl(raw.trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    let res: ImageResponse | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let r: ImageResponse;
      try {
        r = await get(url, controller.signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EPRIVATE") throw privateHostError(url);
        throw new CookieMcpError(
          `cannot fetch ${url.href}: ${e instanceof Error ? e.message : String(e)}`,
          "the image must be publicly downloadable to be pinned",
        );
      }
      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get("location");
        if (!location) {
          throw new CookieMcpError(`${url.href} redirected without a location header`);
        }
        // Re-validate the target: a public host may redirect anywhere, including inward.
        url = await assertFetchableUrl(new URL(location, url).href);
        continue;
      }
      res = r;
      break;
    }
    if (!res) {
      throw new CookieMcpError(
        `${raw} redirected more than ${MAX_REDIRECTS} times`,
        "link the image directly rather than through a redirector",
      );
    }
    if (!res.ok) {
      throw new CookieMcpError(
        `${url.href} returned HTTP ${res.status}`,
        "the image must be publicly downloadable to be pinned",
      );
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw tooBig(declared);

    let buf: Buffer;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      // A drop or the timeout mid-body: surface it as ours, never as a bare `aborted`/`ECONNRESET`.
      throw new CookieMcpError(
        `download of ${url.href} failed before the image was complete: ${e instanceof Error ? e.message : String(e)}`,
        "retry, or host the image somewhere faster; nothing was spent",
      );
    }
    if (buf.byteLength > MAX_IMAGE_BYTES) throw tooBig(buf.byteLength);
    if (!buf.byteLength) throw new CookieMcpError(`${url.href} returned an empty body`);

    // The bytes decide the type, not the server's content-type header — same rule as imagePath.
    const mimeType = sniffImageMimeType(buf);
    if (!mimeType) {
      throw new CookieMcpError(
        `${url.href} is not a PNG, JPEG, GIF or WebP image`,
        "it may be an HTML page rather than the image itself — link the file directly",
      );
    }
    return { base64: buf.toString("base64"), mimeType, bytes: buf.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

function tooBig(bytes: number): CookieMcpError {
  return new CookieMcpError(
    `the image is ${(bytes / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
    "resize it first; a launchpad logo renders at a few hundred pixels",
  );
}
