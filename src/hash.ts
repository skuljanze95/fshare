import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Streams a file through SHA-256. Never loads the whole file into memory. */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(createReadStream(file), sink, signal ? { signal } : {});
  return hash.digest('hex');
}
