// Unit tests for the RC transcript detection (bridge-session marker scan).

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionFile, findBridgeSessionId } from "../src/rc-transcripts.mjs";

const CWD = "/home/aye/project-x";
const LOCAL_ID = "c55cf77e-1257-47dc-93a3-c5e31aa2ba5f";
const CSE_ID = "cse_01X3pHABhjfEkcvWkaR5sW1d";

function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "rc-transcripts-"));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function writeTranscript(base, cwd, id, lines) {
  const dir = join(base, cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

const MARKER =
  '{"type":"bridge-session","sessionId":"c55cf77e-1257-47dc-93a3-c5e31aa2ba5f",' +
  `"bridgeSessionId":"${CSE_ID}","lastSequenceNum":0,"ownerAccountUuid":"x","ownerOrganizationUuid":"y"}`;

test("claudeSessionFile encodes the cwd like ~/.claude/projects does", () => {
  assert.equal(
    claudeSessionFile(CWD, LOCAL_ID, "/base"),
    join("/base", "-home-aye-project-x", `${LOCAL_ID}.jsonl`),
  );
});

test("finds the bridgeSessionId in a transcript head", () => {
  const { base, cleanup } = makeBase();
  try {
    writeTranscript(base, CWD, LOCAL_ID, [
      '{"type":"last-prompt","leafUuid":"a","sessionId":"c55cf77e-1257-47dc-93a3-c5e31aa2ba5f"}',
      '{"type":"mode","mode":"normal","sessionId":"c55cf77e-1257-47dc-93a3-c5e31aa2ba5f"}',
      MARKER,
      '{"type":"user","text":"hi"}',
    ]);
    assert.equal(findBridgeSessionId(CWD, LOCAL_ID, base), CSE_ID);
  } finally {
    cleanup();
  }
});

test("plain local transcript (no marker) returns null", () => {
  const { base, cleanup } = makeBase();
  try {
    writeTranscript(base, CWD, LOCAL_ID, [
      '{"type":"last-prompt","leafUuid":"a","sessionId":"c55cf77e-1257-47dc-93a3-c5e31aa2ba5f"}',
      '{"type":"user","text":"hi"}',
    ]);
    assert.equal(findBridgeSessionId(CWD, LOCAL_ID, base), null);
  } finally {
    cleanup();
  }
});

test("missing file returns null (no throw)", () => {
  const { base, cleanup } = makeBase();
  try {
    assert.equal(findBridgeSessionId(CWD, LOCAL_ID, base), null);
    assert.equal(findBridgeSessionId("", LOCAL_ID, base), null);
  } finally {
    cleanup();
  }
});

test("marker deeper than 64KB is still missed gracefully (returns null, no throw)", () => {
  const { base, cleanup } = makeBase();
  try {
    const filler = JSON.stringify({ type: "user", text: "x".repeat(200) });
    const lines = [];
    for (let i = 0; i < 400; i++) lines.push(filler); // ~80KB before the marker
    lines.push(MARKER);
    writeTranscript(base, CWD, LOCAL_ID, lines);
    assert.equal(findBridgeSessionId(CWD, LOCAL_ID, base), null);
  } finally {
    cleanup();
  }
});

test("truncated trailing line at the head boundary does not throw", () => {
  const { base, cleanup } = makeBase();
  try {
    // Pad to just under 64KB so the marker line is cut mid-JSON at the boundary.
    const filler = JSON.stringify({ type: "user", text: "x".repeat(190) });
    const lines = [];
    for (let i = 0; i < 380; i++) lines.push(filler);
    lines.push(MARKER);
    writeTranscript(base, CWD, LOCAL_ID, lines);
    // Whatever comes back (null or the id), it must not throw.
    const r = findBridgeSessionId(CWD, LOCAL_ID, base);
    assert.ok(r === null || r === CSE_ID);
  } finally {
    cleanup();
  }
});
