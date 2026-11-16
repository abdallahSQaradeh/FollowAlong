/**
 * Reads a WebM file's structure while it streams, so the player can re-stream from any part it
 * has seen (ADR 0006). It keeps:
 * - the init segment: every byte before the first Cluster (EBML header, Segment header, SeekHead,
 *   Info, Tracks…), which MediaSource needs again before media from the middle of the file;
 * - each Cluster's byte offset and start time.
 * Only element headers and the few small elements it reads are parsed; media bytes are skipped.
 */

const ids = {
  segment: 0x18538067,
  cluster: 0x1f43b675,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  clusterTimecode: 0xe7,
} as const;

/** Level-1 elements (children of Segment): one of these also ends a Cluster of unknown size. */
const segmentChildren = new Set([
  0x114d9b74, // SeekHead
  ids.info,
  0x1654ae6b, // Tracks
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x1043a770, // Chapters
  0x1941a469, // Attachments
  ids.cluster,
]);

export interface ClusterStart {
  /** Byte offset of the Cluster element in the file. */
  readonly offset: number;
  /** Start time in seconds. */
  readonly time: number;
}

interface Header {
  readonly id: number;
  /** Payload size; `undefined` for "unknown size" (all value bits set). */
  readonly size: number | undefined;
  /** Header length in bytes. */
  readonly length: number;
}

/** Reads an EBML variable-length integer at `at`, or `undefined` if `bytes` ends first. */
function readVint(
  bytes: Uint8Array,
  at: number,
  keepMarker: boolean,
): { value: number; length: number; allOnes: boolean } | undefined {
  const first = bytes[at];
  if (first === undefined) {
    return undefined;
  }
  if (first === 0) {
    throw new WebmIndexError('an element header longer than 8 bytes (not WebM, or damaged)');
  }
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) {
    return undefined;
  }
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[at + index] ?? 0;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }
  return { value, length, allOnes };
}

function readHeader(bytes: Uint8Array, at: number): Header | undefined {
  const id = readVint(bytes, at, true);
  if (id === undefined) {
    return undefined;
  }
  const size = readVint(bytes, at + id.length, false);
  if (size === undefined) {
    return undefined;
  }
  return {
    id: id.value,
    size: size.allOnes ? undefined : size.value,
    length: id.length + size.length,
  };
}

function readUint(bytes: Uint8Array, from: number, to: number): number {
  let value = 0;
  for (let index = from; index < to; index += 1) {
    value = value * 256 + (bytes[index] ?? 0);
  }
  return value;
}

/** A file this reader cannot follow. The index then marks itself `broken` and stops reading. */
class WebmIndexError extends Error {
  override readonly name = 'WebmIndexError';
}

export class WebmIndex {
  /** Every byte before the first Cluster, once that Cluster has been seen. */
  init: Uint8Array | undefined;
  /**
   * Set when the file has a structure this reader cannot follow. Playback is not affected (the
   * bytes still go to MediaSource); only re-streaming from a Cluster is then impossible.
   */
  broken = false;
  private readonly clusterStarts: ClusterStart[] = [];
  private timecodeScale = 1_000_000;

  /** Unparsed bytes, starting at file offset `offset`. */
  private pending = new Uint8Array(0);
  private offset = 0;
  /** Bytes still to pass over without reading (media payload). */
  private skip = 0;
  private where: 'top' | 'segment' | 'cluster' = 'top';
  /** File offset where the current Cluster ends (Infinity for unknown size). */
  private clusterEnd = Number.POSITIVE_INFINITY;
  private clusterOffset = 0;
  private readonly initParts: Uint8Array[] = [];

  /** Cluster starts seen so far, sorted by file offset (and so by time). */
  get clusters(): readonly ClusterStart[] {
    return this.clusterStarts;
  }

  /** The last Cluster that starts at or before `time`, if any has been seen. */
  clusterAt(time: number): ClusterStart | undefined {
    return this.clusterStarts.findLast((cluster) => cluster.time <= time);
  }

  /** The Cluster after `cluster` in the file, if it has been seen. */
  clusterAfter(cluster: ClusterStart): ClusterStart | undefined {
    return this.clusterStarts.find((next) => next.offset > cluster.offset);
  }

  /** The next bytes come from file offset `offset`: 0, or the start of a Cluster seen before. */
  restartAt(offset: number): void {
    this.pending = new Uint8Array(0);
    this.offset = offset;
    this.skip = 0;
    this.where = offset === 0 ? 'top' : 'segment';
    this.initParts.length = 0;
  }

  /** Reads the next bytes of the file (contiguous with what came before, or with `restartAt`). */
  feed(chunk: Uint8Array): void {
    if (this.broken) {
      return;
    }
    try {
      this.read(chunk);
    } catch (error) {
      if (!(error instanceof WebmIndexError)) {
        throw error;
      }
      this.broken = true;
      this.pending = new Uint8Array(0);
    }
  }

  private read(chunk: Uint8Array): void {
    if (this.init === undefined) {
      this.initParts.push(chunk);
    }
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    let at = 0;
    for (;;) {
      if (this.skip > 0) {
        const passed = Math.min(this.skip, joined.length - at);
        this.skip -= passed;
        at += passed;
        if (this.skip > 0) {
          break;
        }
      }
      const step = this.step(joined, at);
      if (step === undefined) {
        break;
      }
      at = step;
    }
    this.pending = joined.slice(at);
    this.offset += at;
  }

  /** Reads one element header (and a small payload) at `at`; returns where to continue. */
  private step(bytes: Uint8Array, at: number): number | undefined {
    const position = this.offset + at;
    if (this.where === 'cluster' && position >= this.clusterEnd) {
      this.where = 'segment';
    }
    const header = readHeader(bytes, at);
    if (header === undefined) {
      return undefined;
    }
    const payloadAt = at + header.length;
    if (this.where === 'cluster' && segmentChildren.has(header.id)) {
      // A Cluster of unknown size ends where the next level-1 element starts.
      this.where = 'segment';
    }

    if (this.where === 'top') {
      if (header.id === ids.segment) {
        this.where = 'segment';
        return payloadAt;
      }
      return this.pass(header, payloadAt);
    }

    if (this.where === 'segment') {
      if (header.id === ids.cluster) {
        this.startCluster(position, header, payloadAt);
        return payloadAt;
      }
      if (header.id === ids.info) {
        // Descend into Info to find TimecodeScale; its other children are skipped.
        return payloadAt;
      }
      if (header.id === ids.timecodeScale) {
        const value = this.readSmall(bytes, header, payloadAt);
        if (value === undefined) {
          return undefined;
        }
        this.timecodeScale = value;
        return payloadAt + (header.size ?? 0);
      }
      return this.pass(header, payloadAt);
    }

    // Inside a Cluster.
    if (header.id === ids.clusterTimecode) {
      const timecode = this.readSmall(bytes, header, payloadAt);
      if (timecode === undefined) {
        return undefined;
      }
      this.addCluster({ offset: this.clusterOffset, time: (timecode * this.timecodeScale) / 1e9 });
      return payloadAt + (header.size ?? 0);
    }
    return this.pass(header, payloadAt);
  }

  private startCluster(position: number, header: Header, payloadAt: number): void {
    if (this.init === undefined) {
      const init = new Uint8Array(position);
      let filled = 0;
      for (const part of this.initParts) {
        const take = Math.min(part.length, position - filled);
        init.set(part.subarray(0, take), filled);
        filled += take;
        if (filled === position) {
          break;
        }
      }
      this.init = init;
      this.initParts.length = 0;
    }
    this.where = 'cluster';
    this.clusterOffset = position;
    this.clusterEnd =
      header.size === undefined ? Number.POSITIVE_INFINITY : this.offset + payloadAt + header.size;
  }

  /** Indexes a Cluster once, keeping the list sorted by offset; a re-stream sees Clusters again. */
  private addCluster(cluster: ClusterStart): void {
    const after = this.clusterStarts.findIndex((known) => known.offset >= cluster.offset);
    if (after === -1) {
      this.clusterStarts.push(cluster);
    } else if (this.clusterStarts[after]?.offset !== cluster.offset) {
      this.clusterStarts.splice(after, 0, cluster);
    }
  }

  /** Passes over an element's payload. */
  private pass(header: Header, payloadAt: number): number {
    if (header.size === undefined) {
      return this.unreadable();
    }
    this.skip = header.size;
    return payloadAt;
  }

  /** An unsigned integer payload, or `undefined` while its bytes have not all arrived. */
  private readSmall(bytes: Uint8Array, header: Header, payloadAt: number): number | undefined {
    if (header.size === undefined || header.size > 8) {
      return this.unreadable();
    }
    if (payloadAt + header.size > bytes.length) {
      return undefined;
    }
    return readUint(bytes, payloadAt, payloadAt + header.size);
  }

  private unreadable(): never {
    throw new WebmIndexError('this WebM has an element of unknown size the player cannot follow');
  }
}
