import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { errnoCode } from './errors.js';
import { which } from './util.js';

// ---------------------------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------------------------

export interface WalkEntry {
  /** Path relative to the walked root, using "/" separators. */
  rel: string;
  abs: string;
  type: 'file' | 'dir';
  size: number;
  mtime: Date;
  mode: number;
}

export interface WalkResult {
  entries: WalkEntry[];
  fileCount: number;
  totalBytes: number;
  /** Symbolic links are never followed, so a link cannot leak files from outside the folder. */
  skippedLinks: string[];
  /** Sockets, FIFOs, devices and unreadable directories. */
  skippedOther: string[];
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export async function walkDir(root: string, signal?: AbortSignal): Promise<WalkResult> {
  const result: WalkResult = {
    entries: [],
    fileCount: 0,
    totalBytes: 0,
    skippedLinks: [],
    skippedOther: [],
  };
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }];

  while (stack.length > 0) {
    signal?.throwIfAborted();
    const current = stack.pop();
    if (!current) break;
    let dirents;
    try {
      dirents = await readdir(current.abs, { withFileTypes: true });
    } catch (err) {
      if (current.rel === '') throw err;
      result.skippedOther.push(`${current.rel}/ (${errnoCode(err) ?? 'unreadable'})`);
      continue;
    }
    dirents.sort(byName);
    const subdirs: Array<{ abs: string; rel: string }> = [];
    for (const dirent of dirents) {
      const abs = path.join(current.abs, dirent.name);
      const rel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        result.skippedLinks.push(rel);
        continue;
      }
      if (!dirent.isFile() && !dirent.isDirectory()) {
        result.skippedOther.push(rel);
        continue;
      }
      const info = await lstat(abs);
      const type = info.isDirectory() ? 'dir' : 'file';
      result.entries.push({ rel, abs, type, size: info.size, mtime: info.mtime, mode: info.mode });
      if (type === 'dir') {
        subdirs.push({ abs, rel });
      } else {
        result.fileCount += 1;
        result.totalBytes += info.size;
      }
    }
    // Reverse so the stack pops directories in sorted order.
    for (let i = subdirs.length - 1; i >= 0; i -= 1) {
      const subdir = subdirs[i];
      if (subdir) stack.push(subdir);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------

export interface ZipFolderOptions {
  root: string;
  entries: WalkEntry[];
  outPath: string;
  signal?: AbortSignal;
  /** Skip the system `zip` command (used on Windows, in tests and via FSHARE_BUILTIN_ZIP=1). */
  forceBuiltin?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ZipFolderResult {
  method: 'zip' | 'builtin';
  warnings: string[];
}

/**
 * Zips `entries` (from walkDir) into `outPath`. Entries are stored under a top-level folder
 * named after the shared folder, like `zip -r photos.zip photos` would do.
 */
export async function zipFolder(options: ZipFolderOptions): Promise<ZipFolderResult> {
  const env = options.env ?? process.env;
  const rootName = path.basename(options.root);
  const names = options.entries.map((e) => `${rootName}/${e.rel}`);
  const canUseSystemZip =
    !options.forceBuiltin &&
    env.FSHARE_BUILTIN_ZIP !== '1' &&
    process.platform !== 'win32' &&
    rootName !== '' &&
    names.every((n) => !/[\r\n]/.test(n));
  const zipBin = canUseSystemZip ? await which('zip', env) : null;

  if (zipBin) {
    const warnings = await zipWithSystemZip({
      zipBin,
      cwd: path.dirname(options.root),
      names: [rootName, ...names],
      outPath: options.outPath,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { method: 'zip', warnings };
  }

  const top = rootName === '' ? 'folder' : rootName;
  await writeZip(
    [
      { name: `${top}/`, type: 'dir', size: 0, mtime: new Date(), mode: 0o755 },
      ...options.entries.map((e) => ({
        name: e.type === 'dir' ? `${top}/${e.rel}/` : `${top}/${e.rel}`,
        abs: e.abs,
        type: e.type,
        size: e.size,
        mtime: e.mtime,
        mode: e.mode,
      })),
    ],
    options.outPath,
    options.signal ? { signal: options.signal } : {},
  );
  return { method: 'builtin', warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// System zip
// ---------------------------------------------------------------------------------------------

async function zipWithSystemZip(options: {
  zipBin: string;
  cwd: string;
  names: string[];
  outPath: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  // -q quiet, -X no extra file attributes, -nw no wildcard expansion, -@ read names from stdin.
  // Directories are listed explicitly (no -r), so only the walked entries are included.
  const child = spawn(options.zipBin, ['-q', '-X', '-nw', '-@', options.outPath], {
    cwd: options.cwd,
    stdio: ['pipe', 'ignore', 'pipe'],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  child.stdin.on('error', () => {
    // zip exited early; the exit code below explains why.
  });
  for (const name of options.names) {
    if (!child.stdin.write(`${name}\n`)) await once(child.stdin, 'drain');
  }
  child.stdin.end();

  const code = await exited;
  if (code === 0) return [];
  if (code === 18) {
    return [`Some files could not be read and were left out of the zip:\n${stderr.trim()}`];
  }
  throw new Error(`zip failed (exit code ${String(code)}): ${stderr.trim() || 'no details'}`);
}

// ---------------------------------------------------------------------------------------------
// Built-in ZIP writer (deflate via node:zlib, ZIP64 when needed)
// ---------------------------------------------------------------------------------------------

export interface ZipEntryInput {
  /** Name inside the archive, "/" separated; directories end with "/". */
  name: string;
  abs?: string;
  type: 'file' | 'dir';
  size: number;
  mtime: Date;
  mode: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

type Crc32Fn = (data: Buffer, value?: number) => number;
const nativeCrc32 = (zlib as unknown as { crc32?: Crc32Fn }).crc32;

/** CRC-32 (IEEE). Uses zlib.crc32 when available (Node 22.2+). */
export function crc32(data: Buffer, previous = 0): number {
  return nativeCrc32 ? nativeCrc32(data, previous) : crc32Js(data, previous);
}

/** Table-driven CRC-32 for Node versions without zlib.crc32. */
export function crc32Js(data: Buffer, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Deflate can expand incompressible data slightly; switch to ZIP64 well before 4 GiB. */
const ZIP64_THRESHOLD = MAX32 - 64 * 1024 * 1024;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const VERSION_MADE_BY = (3 << 8) | 45; // Unix, spec 4.5

interface CentralRecord {
  name: Buffer;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  externalAttributes: number;
  zip64Sizes: boolean;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const y = Math.min(year, 2107) - 1980;
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: (y << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeUInt64(buffer: Buffer, value: number, offset: number): void {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

class ZipWriter {
  private offset = 0;
  private readonly records: CentralRecord[] = [];

  constructor(
    private readonly out: WriteStream,
    private readonly forceZip64: boolean,
  ) {}

  private async raw(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (!this.out.write(chunk)) await once(this.out, 'drain');
  }

  private localHeader(
    name: Buffer,
    flags: number,
    method: number,
    dos: { time: number; date: number },
    zip64: boolean,
  ): Buffer {
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2); // sizes are in the data descriptor
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dos.time, 10);
    header.writeUInt16LE(dos.date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    return Buffer.concat([header, name, extra]);
  }

  /** Directories and empty files: stored, no data, sizes known up front. */
  async addEmpty(entry: ZipEntryInput): Promise<void> {
    const name = Buffer.from(entry.name, 'utf8');
    const dos = dosDateTime(entry.mtime);
    const offset = this.offset;
    await this.raw(this.localHeader(name, FLAG_UTF8, 0, dos, false));
    const isDir = entry.type === 'dir';
    const typeBits = isDir ? 0o040000 : 0o100000;
    const permissions = entry.mode & 0o7777 || (isDir ? 0o755 : 0o644);
    this.records.push({
      name,
      flags: FLAG_UTF8,
      method: 0,
      ...dos,
      crc: 0,
      compressedSize: 0,
      size: 0,
      offset,
      externalAttributes: (((typeBits | permissions) << 16) | (isDir ? 0x10 : 0)) >>> 0,
      zip64Sizes: false,
    });
  }

  async addFile(entry: ZipEntryInput, signal?: AbortSignal): Promise<void> {
    if (!entry.abs) throw new Error(`Missing source path for ${entry.name}`);
    if (entry.size === 0) return this.addEmpty(entry);
    const name = Buffer.from(entry.name, 'utf8');
    const dos = dosDateTime(entry.mtime);
    const offset = this.offset;
    const zip64 = this.forceZip64 || entry.size >= ZIP64_THRESHOLD;
    const flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
    await this.raw(this.localHeader(name, flags, 8, dos, zip64));

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        compressedSize += chunk.length;
        this.raw(chunk).then(() => callback(), callback);
      },
    });
    // Read at most the size seen during the walk so a growing file cannot break ZIP64 decisions.
    const source = createReadStream(entry.abs, { start: 0, end: entry.size - 1 });
    await pipeline(source, tap, zlib.createDeflateRaw(), sink, signal ? { signal } : {});

    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (zip64) {
      writeUInt64(descriptor, compressedSize, 8);
      writeUInt64(descriptor, size, 16);
    } else {
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    await this.raw(descriptor);

    this.records.push({
      name,
      flags,
      method: 8,
      ...dos,
      crc,
      compressedSize,
      size,
      offset,
      externalAttributes: ((0o100000 | (entry.mode & 0o7777 || 0o644)) << 16) >>> 0,
      zip64Sizes: zip64,
    });
  }

  async finish(): Promise<void> {
    const centralStart = this.offset;
    for (const r of this.records) {
      const offsetTooBig = r.offset >= MAX32 || this.forceZip64;
      const extraFields: number[] = [];
      if (r.zip64Sizes) extraFields.push(r.size, r.compressedSize);
      if (offsetTooBig) extraFields.push(r.offset);
      const extra = Buffer.alloc(extraFields.length > 0 ? 4 + extraFields.length * 8 : 0);
      if (extraFields.length > 0) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(extraFields.length * 8, 2);
        extraFields.forEach((value, i) => writeUInt64(extra, value, 4 + i * 8));
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(VERSION_MADE_BY, 4);
      header.writeUInt16LE(r.zip64Sizes || offsetTooBig ? 45 : 20, 6);
      header.writeUInt16LE(r.flags, 8);
      header.writeUInt16LE(r.method, 10);
      header.writeUInt16LE(r.time, 12);
      header.writeUInt16LE(r.date, 14);
      header.writeUInt32LE(r.crc, 16);
      header.writeUInt32LE(r.zip64Sizes ? MAX32 : r.compressedSize, 20);
      header.writeUInt32LE(r.zip64Sizes ? MAX32 : r.size, 24);
      header.writeUInt16LE(r.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32); // comment length
      header.writeUInt16LE(0, 34); // disk number
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(r.externalAttributes, 38);
      header.writeUInt32LE(offsetTooBig ? MAX32 : r.offset, 42);
      await this.raw(Buffer.concat([header, r.name, extra]));
    }
    const centralSize = this.offset - centralStart;
    const count = this.records.length;
    const needsZip64 =
      this.forceZip64 || count >= MAX16 || centralStart >= MAX32 || centralSize >= MAX32;

    if (needsZip64) {
      const zip64EndOffset = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      writeUInt64(record, 44, 4);
      record.writeUInt16LE(VERSION_MADE_BY, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      writeUInt64(record, count, 24);
      writeUInt64(record, count, 32);
      writeUInt64(record, centralSize, 40);
      writeUInt64(record, centralStart, 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      writeUInt64(locator, zip64EndOffset, 8);
      locator.writeUInt32LE(1, 16);
      await this.raw(Buffer.concat([record, locator]));
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(needsZip64 ? MAX16 : count, 8);
    end.writeUInt16LE(needsZip64 ? MAX16 : count, 10);
    end.writeUInt32LE(needsZip64 ? MAX32 : centralSize, 12);
    end.writeUInt32LE(needsZip64 ? MAX32 : centralStart, 16);
    end.writeUInt16LE(0, 20);
    await this.raw(end);
  }
}

/** Writes a ZIP archive using only Node built-ins. */
export async function writeZip(
  entries: ZipEntryInput[],
  outPath: string,
  options: { signal?: AbortSignal; forceZip64?: boolean } = {},
): Promise<void> {
  const out = createWriteStream(outPath, { mode: 0o600 });
  await once(out, 'open');
  const writer = new ZipWriter(out, options.forceZip64 ?? false);
  try {
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (entry.type === 'dir') await writer.addEmpty(entry);
      else await writer.addFile(entry, options.signal);
    }
    await writer.finish();
    out.end();
    await once(out, 'close');
  } catch (err) {
    out.destroy();
    throw err;
  }
}
