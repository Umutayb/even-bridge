// Vendored & adapted from even-terminal-pi (MIT, c) lallenlowe — src/rpc/framing.ts
// See NOTICE.md.

// Strict JSONL framing for pi RPC mode.
//
// pi's docs are explicit: split on LF ("\n") ONLY. Do NOT use node:readline —
// it also splits on U+2028 / U+2029, which are valid inside JSON strings and
// would corrupt records. A trailing CR ("\r") is stripped to accept \r\n input.

export class LineSplitter {
  buf = "";

  /** Feed a chunk; return any complete lines (without their trailing LF). */
  push(chunk) {
    this.buf += chunk;
    const lines = [];
    let nl;
    // Split on LF only.
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  /** Any buffered, not-yet-terminated content. */
  get pending() {
    return this.buf;
  }
}
