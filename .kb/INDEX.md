# Sales Dashboard — Knowledge Base

Local knowledge base used as source-of-truth context for product/strategy decisions.
Pulled into agents and chat tools as ground-truth references.

## Contents

### `transcripts/`
Raw + cleaned transcripts from external content (YouTube videos, podcasts, etc.) that
inform the build. VTT pulled via `yt-dlp`, cleaned via `clean_vtt.py`.

| ID | Channel | Title | Cleaned |
|---|---|---|---|
| `NKOHsR9nVEM` | Jeremy Haynes | The BEST Ad Creative Testing Strategy For 2026 (Post-Andromeda) | [txt](transcripts/NKOHsR9nVEM.en.txt) |
| `NRgDr0aBCUo` | Jeremy Haynes | Aggressive Ad Strategies To Scale The F*ck Out Of Your Offer | [txt](transcripts/NRgDr0aBCUo.en.txt) |
| `Rim2s-WFwYg` | Jeremy Haynes | The NEW Way To Scale Ads with Meta's Andromeda Update | [txt](transcripts/Rim2s-WFwYg.en.txt) |

### `playbooks/`
Synthesised, opinionated playbooks distilled from raw sources — the actual
material we make build decisions against.

- [Jeremy Haynes — Post-Andromeda Meta Ads Playbook](playbooks/jeremy-haynes-andromeda.md)

## How to add a new transcript
```bash
cd .kb/transcripts
python -m yt_dlp --write-auto-sub --skip-download --sub-lang "en.*" \
  --sub-format vtt -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=VIDEO_ID"
python clean_vtt.py VIDEO_ID.en.vtt
```
