const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { isInRange } = require("../lib/dates");
const { normalizeWhitespace, textFromContent } = require("../extract/text");
const { walkFiles } = require("../lib/jsonl");
const { emptyTotals, toIsoTimestamp } = require("./common");

// Standard Zstandard frame magic, little-endian (0x28B52FFD).
const ZSTD_MAGIC = 4247762216;
const ZSTD_CLI_MAX_BUFFER = 512 * 1024 * 1024;
const SESSION_LOG_NAMES = new Set(["session.jsonl", "session.jsonl.zstd"]);

// Resolve the DeepSeek Harness sessions root. DSH stores one append-only JSONL
// log per session under <DSH_HOME>/sessions/<encoded-cwd>/<encoded-session-id>/
// session.jsonl[.zstd]. DSH_HOME defaults to ~/.dsh.
function resolveDshSessionsRoot({
  home = os.homedir(),
  env = process.env,
} = {}) {
  const dshHome = env.DSH_HOME || path.join(home, ".dsh");
  return path.join(dshHome, "sessions");
}

async function inspectDsh({ root, range } = {}) {
  const sessionsRoot = root || resolveDshSessionsRoot();
  const files = await walkFiles(sessionsRoot, (_filePath, name) =>
    SESSION_LOG_NAMES.has(name),
  );

  const prompts = [];
  let unreadable = false;

  for (const file of files) {
    const text = readSessionText(file);
    if (text === null) {
      unreadable = true;
      continue;
    }
    for (const prompt of extractDshPrompts(text, range)) {
      prompts.push(prompt);
    }
  }

  return {
    source: "dsh",
    root: sessionsRoot,
    files_scanned: files.length,
    prompt_count: prompts.length,
    // Token counts for DSH come from TokenTracker activity. The adapter only
    // supplies authored prompt text for word clouds and profile statistics.
    token_totals: emptyTotals(),
    prompts,
    notes: buildNotes(files.length, unreadable),
  };
}

function buildNotes(fileCount, unreadable) {
  if (fileCount === 0) return [];
  if (unreadable) {
    return [
      "Some DeepSeek Harness session logs could not be decompressed. " +
        "Install the zstd CLI or use Node 22.15+ (built-in zstd) to include DSH prompts.",
    ];
  }
  return [];
}

// Extract authored user prompts from one decompressed DSH JSONL session log.
// DSH writes every authored request as a user/message event whose
// data.source.kind === "user". It also appends synthetic user/message records
// for injected context (agent-instructions, plugin runtime snapshots,
// skill-catalog, subagent-report, subagent-settled, goal, coordinator) — none
// of which are user-authored and must never enter word frequencies.
function extractDshPrompts(text, range) {
  const prompts = [];
  let sessionId = null;

  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event.type === "session" && typeof event.id === "string") {
      sessionId = event.id;
      continue;
    }

    if (event.type !== "user/message" || !isAuthoredUserMessage(event))
      continue;

    const message = normalizeWhitespace(textFromContent(event.data?.content));
    if (!message) continue;

    const timestamp = toIsoTimestamp(event.time);
    if (!isInRange(timestamp, range)) continue;

    prompts.push({
      source: "dsh",
      timestamp,
      session_file: "dsh:" + (sessionId || "unknown"),
      text: message,
    });
  }

  return prompts;
}

function isAuthoredUserMessage(event) {
  const data = event.data || {};
  return data.role === "user" && data.source?.kind === "user";
}

// Read a session log to UTF-8 text, decompressing .zstd artifacts. Returns
// null when the file is missing or no decompressor is available.
function readSessionText(filePath) {
  try {
    if (!filePath.endsWith(".zstd")) return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  return decompressZstdFile(filePath);
}

function decompressZstdFile(filePath) {
  const sync = nodeZstdDecompressSync();
  if (sync) {
    try {
      const buffer = fs.readFileSync(filePath);
      const { frames } = scanZstdFrames(buffer);
      if (frames.length === 0) return null;
      return Buffer.concat(
        frames.map((frame) => sync(buffer.subarray(frame.start, frame.end))),
      ).toString("utf8");
    } catch {
      // Fall through to the external zstd CLI.
    }
  }

  try {
    return cp.execFileSync("zstd", ["-dc", filePath], {
      encoding: "utf8",
      maxBuffer: ZSTD_CLI_MAX_BUFFER,
      timeout: 30000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function nodeZstdDecompressSync() {
  try {
    const zlib = require("node:zlib");
    return typeof zlib.zstdDecompressSync === "function"
      ? zlib.zstdDecompressSync
      : null;
  } catch {
    return null;
  }
}

// Locate complete Zstandard frames in a concatenated-frame container. DSH
// appends each durable batch as an independent, checksummed Zstandard frame,
// so a session log is a concatenation of frames rather than a single stream.
// Node's one-shot zstdDecompressSync decodes exactly one frame, so the reader
// must split frames before decoding.
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error("invalid Zstandard frame magic");
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error("reserved Zstandard frame-header bit set");
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) {
      return { frames, tornStart: start };
    }
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("reserved Zstandard block type");
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        return { frames, tornStart: start };
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }

    frames.push({ start, end: offset });
  }

  return { frames };
}

module.exports = {
  inspectDsh,
  resolveDshSessionsRoot,
  extractDshPrompts,
  scanZstdFrames,
};
