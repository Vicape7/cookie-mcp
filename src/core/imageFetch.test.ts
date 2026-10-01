import { describe, it, expect, vi, afterEach } from "vitest";

import { CookieMcpError } from "./errors";
import { MAX_IMAGE_BYTES } from "./imageFile";
import {
  fetchRemoteImage,
  ipv6Bytes,
  isPrivateAddress,
  pinnedLookup,
  type ImageGet,
} from "./imageFetch";

vi.mock("node:dns/promises", () => ({
  default: {
    // Every hostname in these tests resolves public unless the test says otherwise.
    lookup: vi.fn(async (host: string) =>
      host === "internal.example" ? [{ address: "10.0.0.5" }] : [{ address: "93.184.216.34" }],
    ),
  },
}));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function imageRes(bytes: Buffer, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  } as unknown as Response;
}

function redirectRes(to: string) {
  return {
    ok: false,
    status: 302,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? to : null) },
  } as unknown as Response;
}

// The transport is injected rather than global `fetch` being stubbed: the real one (`httpsGet`) pins
// the socket to a checked address, which no fetch stub could exercise.
let get: ImageGet = async () => {
  throw new Error("no transport stubbed");
};
function useGet(fn: unknown) {
  get = fn as ImageGet;
}
const fetchImage = (raw: string) => fetchRemoteImage(raw, (url, signal) => get(url, signal));

afterEach(() => {
  get = async () => {
    throw new Error("no transport stubbed");
  };
});

describe("isPrivateAddress", () => {
  it("blocks loopback, RFC1918, CGNAT and cloud metadata", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
  });

  it("blocks the IPv6 forms, including an IPv4-mapped loopback", () => {
    for (const ip of ["::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("catches IPv4-mapped loopback in the hex form URL normalises it to", () => {
    // new URL("https://[::ffff:127.0.0.1]/").hostname is "[::ffff:7f00:1]".
    expect(new URL("https://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    for (const ip of ["[::ffff:7f00:1]", "::ffff:a9fe:a9fe", "::ffff:0:a00:1", "::7f00:1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("::ffff:5db8:d822")).toBe(false); // 93.184.216.34
  });

  it("looks through NAT64 and 6to4 to the IPv4 they reach, and refuses Teredo", () => {
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true); // → 127.0.0.1
    expect(isPrivateAddress("64:ff9b::a9fe:a9fe")).toBe(true); // → 169.254.169.254
    expect(isPrivateAddress("64:ff9b::5db8:d822")).toBe(false); // → 93.184.216.34
    expect(isPrivateAddress("64:ff9b:1::1")).toBe(true); // local-use NAT64
    expect(isPrivateAddress("2002:7f00:1::")).toBe(true); // 6to4 of 127.0.0.1
    expect(isPrivateAddress("2002:c0a8:101::1")).toBe(true); // 6to4 of 192.168.1.1
    expect(isPrivateAddress("2002:5db8:d822::1")).toBe(false);
    expect(isPrivateAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true);
    expect(isPrivateAddress("2001:db8::1")).toBe(true);
    expect(isPrivateAddress("fec0::1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1::1")).toBe(false);
  });

  it("refuses anything it cannot parse", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("ipv6Bytes", () => {
  it("expands compression and a dotted tail to the same 16 bytes", () => {
    const a = ipv6Bytes("::ffff:127.0.0.1");
    expect(a).toEqual(ipv6Bytes("0:0:0:0:0:ffff:7f00:0001"));
    expect(Buffer.from(a!).toString("hex")).toBe("00000000000000000000ffff7f000001");
    expect(ipv6Bytes("not-ipv6")).toBeNull();
  });
});

describe("pinnedLookup", () => {
  // The socket's own resolution is checked, so a name that turns private after the pre-check
  // (DNS rebinding) is refused at connect time.
  const lookup = (host: string, all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((resolve) =>
      pinnedLookup(host, { all }, (err: NodeJS.ErrnoException | null, addr: unknown) =>
        resolve({ err, addr }),
      ),
    );

  it("hands the socket a checked public address", async () => {
    expect(await lookup("cdn.example")).toEqual({ err: null, addr: "93.184.216.34" });
    const all = await lookup("cdn.example", true);
    expect(all.addr).toEqual([{ address: "93.184.216.34" }]);
  });

  it("refuses a private answer with an EPRIVATE error", async () => {
    const { err } = await lookup("internal.example");
    expect(err?.code).toBe("EPRIVATE");
  });
});

describe("fetchRemoteImage", () => {
  it("downloads the bytes and types them from the magic bytes", async () => {
    useGet(vi.fn().mockResolvedValue(imageRes(PNG)));

    const got = await fetchImage("https://example.com/logo.png");
    expect(got.mimeType).toBe("image/png");
    expect(Buffer.from(got.base64, "base64").equals(PNG)).toBe(true);
  });

  it("ignores a lying content-type and trusts the bytes", async () => {
    useGet(vi.fn().mockResolvedValue(imageRes(PNG, { "content-type": "image/gif" })));
    expect((await fetchImage("https://example.com/x")).mimeType).toBe("image/png");
  });

  it("refuses a non-https URL without fetching", async () => {
    const fetchMock = vi.fn();
    useGet(fetchMock);

    await expect(fetchImage("http://example.com/logo.png")).rejects.toThrow(/must be https/);
    await expect(fetchImage("file:///etc/passwd")).rejects.toThrow(/must be https/);
    await expect(fetchImage("not a url")).rejects.toThrow(/not a valid URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves into a private network", async () => {
    const fetchMock = vi.fn();
    useGet(fetchMock);

    await expect(fetchImage("https://internal.example/logo.png")).rejects.toThrow(
      /private network/,
    );
    // A literal address skips DNS but is checked the same way.
    await expect(fetchImage("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /private network/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a connect-time private resolution as a private-network refusal", async () => {
    useGet(vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "EPRIVATE" })));
    await expect(fetchImage("https://rebind.example/logo.png")).rejects.toThrow(/private network/);
  });

  it("re-checks each redirect hop, so a public host cannot bounce us inward", async () => {
    useGet(vi.fn().mockResolvedValue(redirectRes("https://169.254.169.254/latest/meta-data")));

    await expect(fetchImage("https://example.com/logo.png")).rejects.toThrow(/private network/);
  });

  it("follows a redirect to a public host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectRes("https://cdn.example/real.png"))
      .mockResolvedValueOnce(imageRes(PNG));
    useGet(fetchMock);

    expect((await fetchImage("https://example.com/logo.png")).mimeType).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a redirect loop", async () => {
    useGet(vi.fn().mockResolvedValue(redirectRes("https://example.com/again")));

    await expect(fetchImage("https://example.com/logo.png")).rejects.toThrow(
      /redirected more than/,
    );
  });

  it("rejects an oversized image on its declared length, before reading the body", async () => {
    const arrayBuffer = vi.fn();
    useGet(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "99999999" : null) },
        arrayBuffer,
      } as unknown as Response),
    );

    await expect(fetchImage("https://example.com/huge.png")).rejects.toThrow(/limit is 5 MB/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects a body that outgrows the cap even when content-length lied", async () => {
    useGet(
      vi
        .fn()
        .mockResolvedValue(
          imageRes(Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89), { "content-length": "10" }),
        ),
    );

    await expect(fetchImage("https://example.com/huge.png")).rejects.toThrow(/limit is 5 MB/);
  });

  it("wraps a connection drop mid-body in our error, not a bare socket error", async () => {
    useGet(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => {
          throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
        },
      } as unknown as Response),
    );

    const err = await fetchImage("https://example.com/logo.png").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CookieMcpError);
    expect(String((err as Error).message)).toMatch(/failed before the image was complete.*aborted/);
  });

  it("rejects an HTML page dressed as an image URL", async () => {
    useGet(vi.fn().mockResolvedValue(imageRes(Buffer.from("<!doctype html><html>", "latin1"))));

    await expect(fetchImage("https://example.com/logo.png")).rejects.toThrow(
      /not a PNG, JPEG, GIF or WebP/,
    );
  });

  it("surfaces a 404 rather than launching with a broken logo", async () => {
    useGet(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
      } as unknown as Response),
    );

    await expect(fetchImage("https://example.com/gone.png")).rejects.toThrow(/HTTP 404/);
  });
});
