import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

import { runWithRequestContext } from "./context";
import {
  MAX_IMAGE_BYTES,
  imageRoot,
  isAllowedImagePath,
  readImageFile,
  resolveImagePath,
  sniffImageMimeType,
} from "./imageFile";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a....", "latin1");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "latin1"),
]);

let dir: string;
let outside: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-img-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-img-out-"));
  process.env.COOKIE_IMAGE_DIR = dir;
});
afterAll(() => {
  delete process.env.COOKIE_IMAGE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.COOKIE_SIGNER;
});

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe("sniffImageMimeType", () => {
  it("recognises the formats a launchpad UI can render", () => {
    expect(sniffImageMimeType(PNG)).toBe("image/png");
    expect(sniffImageMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMimeType(GIF)).toBe("image/gif");
    expect(sniffImageMimeType(WEBP)).toBe("image/webp");
  });

  it("rejects anything else, including SVG and a PDF", () => {
    expect(sniffImageMimeType(Buffer.from("<svg xmlns=...", "latin1"))).toBeNull();
    expect(sniffImageMimeType(Buffer.from("%PDF-1.7", "latin1"))).toBeNull();
    expect(sniffImageMimeType(Buffer.from([]))).toBeNull();
  });
});

describe("readImageFile", () => {
  it("returns base64 + the sniffed type", () => {
    const file = readImageFile(write("logo.png", PNG));
    expect(file.mimeType).toBe("image/png");
    expect(Buffer.from(file.base64, "base64").equals(PNG)).toBe(true);
    expect(file.bytes).toBe(PNG.length);
  });

  it("trusts the bytes over the extension — a JPEG named .png is typed image/jpeg", () => {
    expect(readImageFile(write("liar.png", JPEG)).mimeType).toBe("image/jpeg");
  });

  it("says the same thing for missing, a directory and an empty file, and never the real path", () => {
    const missing = path.join(dir, "nope.png");
    for (const p of [missing, dir, write("empty.png", Buffer.alloc(0))]) {
      expect(() => readImageFile(p)).toThrow(/not a readable image file under the image directory/);
    }
    // The message echoes the path as typed, so type it through an alias: where the temp dir is not
    // itself a symlink (Linux `/tmp`), the typed path would otherwise be the real one.
    const alias = path.join(outside, "alias");
    fs.symlinkSync(dir, alias);
    expect(() => readImageFile(path.join(alias, "nope.png"))).toThrow(
      /not a readable image file under the image directory/,
    );
    let message = "";
    try {
      readImageFile(path.join(alias, "nope.png"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(fs.realpathSync(dir));
  });

  it("refuses a non-image", () => {
    expect(() => readImageFile(write("notes.txt", Buffer.from("hello")))).toThrow(
      /not a PNG, JPEG, GIF or WebP/,
    );
  });

  it("refuses a file outside the image directory, and a symlink pointing out of it", () => {
    const stray = path.join(outside, "stray.png");
    fs.writeFileSync(stray, PNG);
    expect(() => readImageFile(stray)).toThrow(/not a readable image file/);
    const link = path.join(dir, "link.png");
    fs.symlinkSync(stray, link);
    expect(() => readImageFile(link)).toThrow(/not a readable image file/);
    expect(() => readImageFile(path.join(dir, "..", path.basename(outside), "stray.png"))).toThrow(
      /not a readable image file/,
    );
  });

  it("refuses a hidden file or a file under a hidden folder", () => {
    fs.mkdirSync(path.join(dir, ".ssh"), { recursive: true });
    const hidden = path.join(dir, ".ssh", "qr.png");
    fs.writeFileSync(hidden, PNG);
    expect(() => readImageFile(hidden)).toThrow(/not a readable image file/);
    expect(() => readImageFile(write(".logo.png", PNG))).toThrow(/not a readable image file/);
  });

  it("is disabled for a request that came over HTTP", async () => {
    const p = write("remote.png", PNG);
    await runWithRequestContext({ remote: true }, async () => {
      expect(() => readImageFile(p)).toThrow(/disabled on a hosted server/);
    });
  });

  it("is disabled with an external signer", () => {
    const p = write("external.png", PNG);
    process.env.COOKIE_SIGNER = "external";
    expect(() => readImageFile(p)).toThrow(/disabled on a hosted server/);
  });

  it("refuses a file over the size cap before reading it", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(() => readImageFile(write("huge.png", big))).toThrow(/limit is 5 MB/);
  });
});

describe("isAllowedImagePath", () => {
  it("allows a plain path below the root only", () => {
    expect(isAllowedImagePath("/home/x/Pictures/logo.png", "/home/x")).toBe(true);
    expect(isAllowedImagePath("/home/x", "/home/x")).toBe(false);
    expect(isAllowedImagePath("/home/xy/logo.png", "/home/x")).toBe(false);
    expect(isAllowedImagePath("/etc/hosts", "/home/x")).toBe(false);
    expect(isAllowedImagePath("/home/x/.config/a.png", "/home/x")).toBe(false);
    expect(isAllowedImagePath("/home/x/a/.b/c.png", "/home/x")).toBe(false);
  });
});

describe("resolveImagePath", () => {
  it("expands ~ and resolves a relative path against cwd", () => {
    const home = process.env.HOME;
    process.env.HOME = "/home/x";
    expect(resolveImagePath("~/a.png")).toBe("/home/x/a.png");
    expect(resolveImagePath("~")).toBe("/home/x");
    // `~user` is not a home reference we understand — it stays a relative path, not `$HOME/user`.
    expect(resolveImagePath("~user/a.png")).toBe(path.resolve(process.cwd(), "~user/a.png"));
    expect(resolveImagePath("a.png")).toBe(path.resolve(process.cwd(), "a.png"));
    expect(resolveImagePath("  /tmp/a.png  ")).toBe("/tmp/a.png");
    process.env.HOME = home;
  });
});

describe("imageRoot", () => {
  it("expands ~ in COOKIE_IMAGE_DIR (MCP client configs have no shell)", () => {
    const saved = { dir: process.env.COOKIE_IMAGE_DIR, home: process.env.HOME };
    process.env.HOME = dir;
    process.env.COOKIE_IMAGE_DIR = "~";
    try {
      expect(imageRoot()).toBe(fs.realpathSync(dir));
    } finally {
      process.env.COOKIE_IMAGE_DIR = saved.dir;
      process.env.HOME = saved.home;
    }
  });

  it("refuses to fall back to cwd when COOKIE_IMAGE_DIR and HOME are both unset", () => {
    const saved = { dir: process.env.COOKIE_IMAGE_DIR, home: process.env.HOME };
    delete process.env.COOKIE_IMAGE_DIR;
    delete process.env.HOME;
    try {
      expect(() => imageRoot()).toThrow(/COOKIE_IMAGE_DIR and HOME are both unset/);
    } finally {
      process.env.COOKIE_IMAGE_DIR = saved.dir;
      process.env.HOME = saved.home;
    }
  });
});
