import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { isoLocal } from "./time.mjs";

// What the person sends into an affair's conversation (a picture, a file) is kept in that affair's own files/ folder.
// Nothing here reads the content: a picture is for the eyes of the look that is called, a file is read when it is needed.
// The only thing written is a new file under <root>/<id>/files/, named from the time and the sent name, never over another.

export const MAX_BYTES = 20 * 1024 * 1024;
const IMAGES = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/heic": "heic" };
/** A file that could be run by double click is kept, but not under a name that says it can be run. */
const RUNNABLE = /\.(?:exe|bat|cmd|com|scr|msi|dll|ps1|psm1|vbs|vbe|wsf|js|mjs|cjs|jar|lnk|sh|reg|hta)$/i;
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
// Rounded up, so a file that is over the limit never reads as exactly the limit.
const MB = (n) => `${n >= 10 * 1024 * 1024 ? Math.ceil(n / 1024 / 1024) : (Math.ceil((n / 1024 / 1024) * 10) / 10).toFixed(1)} MB`;

/** A name that is only a name: no folders, no characters a path cannot hold, no leading dots, not too long, extension kept. */
export function cleanName(raw, fallback) {
  let name = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  name = name.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!name || /^_+$/.test(name)) name = fallback;
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 80) {
    const ext = path.extname(name).slice(0, 12);
    name = `${name.slice(0, 80 - ext.length)}${ext}`;
  }
  if (RUNNABLE.test(name)) name = `${name}.txt`;
  return name;
}

/** "20261103-101542" from the local time. */
const stampOf = (ms, tz) => isoLocal(ms, tz).slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

/** The first path under filesDir that nobody has: <stamp>-<name>, then <stamp>-2-<name> … */
function freePath(filesDir, stamp, name) {
  for (let n = 1; n < 1000; n++) {
    const file = path.join(filesDir, `${stamp}-${n > 1 ? `${n}-` : ""}${name}`);
    if (!existsSync(file)) return file;
  }
  throw new Error("files/ 里同一秒的重名太多了");
}

/** The path really is inside filesDir (not a name that climbs out of it). */
function inside(filesDir, file) {
  const rel = path.relative(filesDir, file);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel) && path.dirname(file) === filesDir;
}

/**
 * Keeps what was sent in `<root>/<id>/files/` and says what it kept.
 * `item` is `{ type: "image", data: base64, mimeType, name? }` or `{ type: "file", from: path, name, mimeType }`.
 * @returns {{ ok: true, name: string, path: string, mime: string, size: number } | { ok: false, text: string }}
 */
export function keep({ root, id, tz, now, item }) {
  const filesDir = path.resolve(root, id, "files");
  const isImageData = item.type === "image";
  const mime = String(item.mimeType ?? "").toLowerCase().split(";")[0].trim() || "application/octet-stream";
  const label = String(item.name ?? "").split(/[\\/]/).pop() || (isImageData ? "图片" : "文件");
  let bytes = null;
  let size = 0;
  if (isImageData) {
    const data = String(item.data ?? "").replace(/^data:[^,]*,/, "");
    if (Math.floor((data.length * 3) / 4) > MAX_BYTES + 3) return { ok: false, text: `「${label}」超过 ${MB(MAX_BYTES)}，没收下。压小一点再发，或者把要点打成字。` };
    bytes = Buffer.from(data, "base64");
    size = bytes.length;
    if (size === 0) return { ok: false, text: `「${label}」是空的，没收下。` };
  } else {
    let st;
    try {
      st = statSync(item.from);
    } catch {
      return { ok: false, text: `「${label}」没收到（文件读不到）。再发一次试试。` };
    }
    if (!st.isFile()) return { ok: false, text: `「${label}」不是一个文件，没收下。` };
    size = st.size;
    if (size > MAX_BYTES) return { ok: false, text: `「${label}」有 ${MB(size)}，超过 ${MB(MAX_BYTES)}，没收下。压小一点再发，或者把要点打成字。` };
    if (size === 0) return { ok: false, text: `「${label}」是空的，没收下。` };
  }
  const isImage = Boolean(IMAGES[mime]);
  const stamp = stampOf(now, tz);
  // A sent picture with no name is named for what it is; one with a name that has no extension gets the one its type says.
  let name = cleanName(item.name, isImageData ? `图片.${IMAGES[mime] ?? "bin"}` : "文件");
  if (isImage && !path.extname(name)) name = `${name}.${IMAGES[mime]}`;
  mkdirSync(filesDir, { recursive: true });
  const target = freePath(filesDir, stamp, name);
  if (!inside(filesDir, target)) return { ok: false, text: `「${label}」的名字不能用，没收下。` };
  try {
    if (bytes) {
      // wx: never over a file that is already there.
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } else {
      copyFileSync(item.from, target, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    return { ok: false, text: `「${label}」没存成：${error.code === "ENOSPC" ? "磁盘满了" : "写不进去"}。` };
  }
  return { ok: true, name, path: target.replaceAll("\\", "/"), mime, size };
}
