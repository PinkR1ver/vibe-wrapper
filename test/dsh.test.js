const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const cp = require("node:child_process");

const { dayBounds } = require("../src/lib/dates");
const {
  inspectDsh,
  resolveDshSessionsRoot,
  scanZstdFrames,
} = require("../src/sources/dsh");
const { inspectSources } = require("../src/inspect");
const { KNOWN_SOURCES, DEFAULT_SOURCES } = require("../src/sources");

const fixtures = path.join(__dirname, "fixtures");
const sessionsRoot = path.join(fixtures, "dsh", "sessions");
const zstdRoot = path.join(fixtures, "dsh", "zstd-sessions");
const range = dayBounds("2026-06-07", "2026-06-07");

function hasZstdDecompress() {
  try {
    const zlib = require("node:zlib");
    if (typeof zlib.zstdDecompressSync === "function") return true;
  } catch {
    // Node < 22.15 has no built-in zstd.
  }
  try {
    cp.execFileSync("zstd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("resolveDshSessionsRoot honors DSH_HOME and defaults to ~/.dsh", () => {
  assert.match(
    resolveDshSessionsRoot({ home: "/home/demo", env: {} }),
    /\/home\/demo\/\.dsh\/sessions$/,
  );
  assert.equal(
    resolveDshSessionsRoot({
      home: "/home/demo",
      env: { DSH_HOME: "/custom/dsh" },
    }),
    "/custom/dsh/sessions",
  );
});

test("inspectDsh extracts authored prompts and excludes injected envelopes", async () => {
  const report = await inspectDsh({ root: sessionsRoot, range });

  assert.equal(report.source, "dsh");
  assert.equal(report.files_scanned, 2);
  // Three in-range authored prompts: two in session-demo-1, one in session-demo-2.
  // The out-of-range (2026-06-08) prompt and every synthetic envelope are excluded.
  assert.equal(report.prompt_count, 3);

  const texts = report.prompts.map((p) => p.text);
  assert.ok(texts.some((t) => t.includes("词云组件")));
  assert.ok(texts.some((t) => t.includes("动画效果")));
  assert.ok(texts.some((t) => t.includes("React 组件")));

  // Injected envelopes must never become authored prompt text.
  for (const prompt of report.prompts) {
    assert.ok(
      !/system-reminder|runtime context|skill|subagent|goal reminder/i.test(
        prompt.text,
      ),
      "envelope leaked into prompt: " + prompt.text,
    );
    assert.equal(prompt.source, "dsh");
    assert.match(prompt.session_file, /^dsh:session-demo-/);
    assert.ok(prompt.timestamp);
  }

  // DSH token totals stay empty — TokenTracker is the token authority.
  assert.equal(report.token_totals.total_tokens, 0);
});

test("inspectDsh filters prompts by date range", async () => {
  const narrow = await inspectDsh({
    root: sessionsRoot,
    range: dayBounds("2026-06-08", "2026-06-08"),
  });
  assert.equal(narrow.prompt_count, 1);
  assert.ok(narrow.prompts[0].text.includes("第二天"));
});

test("inspectDsh returns empty report for missing root", async () => {
  const report = await inspectDsh({
    root: path.join(os.tmpdir(), "vibe-roast-dsh-missing"),
  });
  assert.equal(report.prompt_count, 0);
  assert.equal(report.files_scanned, 0);
  assert.deepEqual(report.notes, []);
});

test("scanZstdFrames splits concatenated zstd frames", () => {
  const buffer = fs.readFileSync(
    path.join(
      zstdRoot,
      "--demo-project--",
      "session-demo-3",
      "session.jsonl.zstd",
    ),
  );
  const { frames, tornStart } = scanZstdFrames(buffer);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].start, 0);
  assert.ok(frames[0].end > 0 && frames[0].end < frames[1].end);
  assert.equal(frames[1].end, buffer.length);
  assert.equal(tornStart, undefined);
});

test("inspectDsh reads zstd session logs", async (t) => {
  if (!hasZstdDecompress()) return t.skip("no zstd decompressor available");

  const report = await inspectDsh({ root: zstdRoot, range });
  assert.equal(report.files_scanned, 1);
  assert.equal(report.prompt_count, 1);
  assert.ok(report.prompts[0].text.includes("词云算法"));
  assert.equal(report.notes.length, 0);
});

test("inspectDsh reports unreadable zstd logs with a note", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibe-roast-dsh-corrupt-"),
  );
  fs.mkdirSync(path.join(root, "--demo-project--", "session-bad"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "--demo-project--", "session-bad", "session.jsonl.zstd"),
    "this is not zstd data",
  );

  const report = await inspectDsh({ root, range });
  assert.equal(report.files_scanned, 1);
  assert.equal(report.prompt_count, 0);
  assert.ok(report.notes.some((n) => n.includes("could not be decompressed")));
});

test("inspectSources includes dsh as a known and default source", () => {
  assert.ok(KNOWN_SOURCES.includes("dsh"));
  assert.ok(DEFAULT_SOURCES.includes("dsh"));
});

test("inspectSources feeds dsh prompts into the word cloud", async () => {
  const report = await inspectSources({
    from: "2026-06-07",
    to: "2026-06-07",
    sources: ["dsh"],
    roots: {
      dsh: sessionsRoot,
      home: fs.mkdtempSync(path.join(os.tmpdir(), "vibe-roast-dsh-home-")),
      tokenTrackerQueue: path.join(fixtures, "missing-token-tracker.jsonl"),
    },
  });

  assert.equal(report.summary.source_count, 1);
  assert.ok(report.summary.active_sources.includes("dsh"));
  assert.equal(report.sources.dsh.prompt_count, 3);

  assert.ok(report.word_cloud_records.length >= 1);
  assert.ok(report.word_cloud_records.every((r) => r.source === "dsh"));
  assert.ok(
    report.word_frequencies.some((f) => f.term === "词云"),
    "expected 词云 in word frequencies",
  );
});
