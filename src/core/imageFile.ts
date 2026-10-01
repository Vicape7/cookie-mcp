// Read a logo off local disk for deploy_token.
//
// Without this, a file on the user's machine can only reach the launchpad by being base64'd through
// the model's context — tens of thousands of tokens to *move* an image nobody needs to read, and a
// truncated paste silently corrupts the logo that immutable metadata then pins forever.
//
// The MIME type comes from magic bytes, never the extension: the launchpad stores whatever we
// declare, and a `.png` that is really a JPEG would be pinned with the wrong content type.
//
// This reads the disk of the machine the SERVER runs on, so it is a local-user feature only:
// refused outright over HTTP and with an external signer (the caller is not the machine's owner), and
// on stdio confined to one directory tree with no hidden segments, so a steered agent cannot pin
// `~/.ssh/…` or a screenshot folder elsewhere on disk. Failures that would tell a caller whether
// some path exists all read the same and never echo the resolved path.
import fs from "node:fs";
import path from "node:path";

import { requestContext } from "./context";
import { CookieMcpError } from "./errors";
import { signerMode } from "./wallet";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Raw bytes we accept as a logo. The launchpad pins the file as-is; these are what UIs render. */
const SIGNATURES: { mimeType: string; matches: (b: Buffer) => boolean }[] = [
  { mimeType: "image/png", matches: (b) => b.subarray(0, 8).equals(PNG_MAGIC) },
  { mimeType: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mimeType: "image/gif",
    matches: (b) =>
      b
        .subarray(0, 6)
        .toString("latin1")
        .match(/^GIF8[79]a$/) !== null,
  },
  {
    mimeType: "image/webp",
    matches: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/**
 * Cap on the file we will pin. Generous for a logo and well under what the upload endpoint and IPFS
 * gateways are happy with; a 4K screenshot lands here and gets told to resize rather than timing out
 * mid-launch.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Refuse local file reads when the caller is not the person whose machine this is: any request that
 * came in over HTTP, and external-signer mode (a hosted setup by definition). Checked before any
 * network call, so a remote caller learns nothing about the disk.
 */
export function assertLocalFilesAllowed(): void {
  if (requestContext()?.remote || signerMode() === "external") {
    throw new CookieMcpError(
      "imagePath is disabled on a hosted server — it would read the server's disk, not yours",
      "send the logo as imageBase64 (with imageMimeType), or as an https imageUrl",
    );
  }
}

/**
 * The directory tree `imagePath` may read from: `COOKIE_IMAGE_DIR` when set, else the user's home.
 * Returned as a real path, so a symlinked root compares correctly against a real file path.
 */
export function imageRoot(): string {
  // No cwd fallback: a server started from `/` with a stripped env would otherwise confine to `/`.
  const root = process.env.COOKIE_IMAGE_DIR?.trim() || process.env.HOME?.trim();
  if (!root) {
    throw new CookieMcpError(
      "no directory for imagePath to read from (COOKIE_IMAGE_DIR and HOME are both unset)",
      "set COOKIE_IMAGE_DIR to the folder holding the logo, or use imageBase64 / imageUrl",
    );
  }
  try {
    // `resolveImagePath` expands `~`, which MCP client configs cannot (no shell).
    return fs.realpathSync(resolveImagePath(root));
  } catch {
    throw new CookieMcpError(
      "the directory imagePath reads from does not exist",
      "set COOKIE_IMAGE_DIR to an existing folder holding the logo, or use imageBase64 / imageUrl",
    );
  }
}

/**
 * True when `real` (already symlink-resolved) sits inside `root` and no segment below the root is
 * hidden (`.ssh`, `.config`, `.env.png`, …). Pure.
 */
export function isAllowedImagePath(real: string, root: string): boolean {
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).every((seg) => seg !== "" && !seg.startsWith("."));
}

/** `~/x.png` and relative paths resolve the way the shell would. */
export function resolveImagePath(input: string): string {
  const s = input.trim();
  if (s === "~" || s.startsWith("~/")) return path.join(process.env.HOME ?? "", s.slice(1));
  return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
}

/** Sniff the format from the leading bytes (pure). `null` when it is not an image we accept. */
export function sniffImageMimeType(bytes: Buffer): string | null {
  return SIGNATURES.find((s) => s.matches(bytes))?.mimeType ?? null;
}

/**
 * Read a local image and return exactly what `uploadImage` wants. Throws a `CookieMcpError` the
 * caller can surface verbatim — this runs before any spend, so every failure here is free.
 */
export function readImageFile(input: string): { base64: string; mimeType: string; bytes: number } {
  assertLocalFilesAllowed();
  const root = imageRoot();
  // One message for missing, unreadable, a directory, a symlink out of the root and a hidden path:
  // which of those it was is exactly what a filesystem probe wants to learn.
  const unusable = () =>
    new CookieMcpError(
      `cannot use "${input.trim()}" as a logo: not a readable image file under the image directory`,
      `imagePath must name a PNG/JPEG/GIF/WebP file inside ${process.env.COOKIE_IMAGE_DIR?.trim() ? "COOKIE_IMAGE_DIR" : "your home directory"}, ` +
        "with no hidden folder in the path; set COOKIE_IMAGE_DIR to read from elsewhere, or use " +
        "imageBase64 / imageUrl",
    );

  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(resolveImagePath(input));
    stat = fs.statSync(real);
  } catch {
    throw unusable();
  }
  if (!isAllowedImagePath(real, root) || !stat.isFile() || stat.size === 0) {
    throw unusable();
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new CookieMcpError(
      `the logo file is ${(stat.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
      "resize it first; a launchpad logo renders at a few hundred pixels",
    );
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(real);
  } catch {
    throw unusable();
  }

  const mimeType = sniffImageMimeType(buf);
  if (!mimeType) {
    throw new CookieMcpError(
      "the logo file is not a PNG, JPEG, GIF or WebP image",
      "the format is read from the file's own bytes, not its extension — convert it first",
    );
  }

  return { base64: buf.toString("base64"), mimeType, bytes: stat.size };
}
