"""Clean YouTube auto-caption VTT into deduped readable text.

YouTube auto-captions emit overlapping VTT frames where each line of speech is
shown twice — once being typed and once finalised. This script keeps only the
finalised text (no <c> markup, no per-token timestamps) and removes adjacent
duplicates.
"""
import re
import sys
from pathlib import Path

TIMESTAMP = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3} --> ")
INNER_TS = re.compile(r"<\d{2}:\d{2}:\d{2}\.\d{3}>")
TAG = re.compile(r"</?c[^>]*>")
META_LINES = {"WEBVTT", "Kind: captions", ""}

def clean_vtt(text: str) -> str:
    """Return plain-text speech with per-line timestamps preserved as [hh:mm:ss]."""
    lines = text.splitlines()
    out_lines = []
    last_clean = ""
    current_ts = None
    for raw in lines:
        line = raw.rstrip()
        if not line:
            continue
        if line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:") or line.startswith("NOTE"):
            continue
        ts_match = TIMESTAMP.match(line)
        if ts_match:
            current_ts = line.split(" --> ")[0][:8]
            continue
        if "align:" in line or "position:" in line:
            continue
        # Strip inline tags + per-token timestamps
        clean = INNER_TS.sub("", line)
        clean = TAG.sub("", clean)
        clean = clean.strip()
        if not clean:
            continue
        # Drop adjacent duplicates (the YT "typing" preview)
        if clean == last_clean:
            continue
        # Drop if the new line is contained in the previous (preview frame)
        if last_clean and clean in last_clean:
            continue
        # Drop if the previous is contained in the new (extension frame) — replace previous
        if last_clean and last_clean in clean and out_lines:
            out_lines[-1] = (current_ts, clean)
            last_clean = clean
            continue
        out_lines.append((current_ts, clean))
        last_clean = clean
    # Render — group into sentences-ish, keep timestamps every 30s
    rendered = []
    last_emitted_ts = None
    buffer = []
    for ts, text in out_lines:
        if ts and (last_emitted_ts is None or _ts_diff(last_emitted_ts, ts) >= 30):
            if buffer:
                rendered.append(" ".join(buffer))
                buffer = []
            rendered.append(f"\n[{ts}]")
            last_emitted_ts = ts
        buffer.append(text)
    if buffer:
        rendered.append(" ".join(buffer))
    return "\n".join(rendered).strip() + "\n"

def _ts_diff(a: str, b: str) -> int:
    def secs(t):
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    return secs(b) - secs(a)

if __name__ == "__main__":
    src = Path(sys.argv[1])
    dst = src.with_suffix(".txt")
    dst.write_text(clean_vtt(src.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"{src.name} -> {dst.name} ({dst.stat().st_size} bytes)")
