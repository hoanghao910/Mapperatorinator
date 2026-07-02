# Mapperatorinator Generation API (Part 1 as a service)

An HTTP service that wraps **Part 1** of the pipeline — *audio → timing-corrected
`.osu`* — so other projects can request beatmap generation without owning this
repo's heavy `.venv` / MPS model. Built for **batch automation**: submit many
songs, they queue, one warm-model worker processes them FIFO, you poll for
results.

```
 game_content_tools (Part 2, system python)         Mapperatorinator (Part 1, .venv + MPS)
 ──────────────────────────────────────────         ──────────────────────────────────────
  mapperatorinator_client.py  ──HTTP POST /jobs──►   FastAPI  ─► SQLite queue ─► warm worker
                              ◄──poll  GET /jobs/{id}──         (inference + osu_timing fix)
  osu_to_json.py  (local convert the .osu)           returns  <slug>_fixed.osu
```

Why a service: the two projects need **different python environments** (Part 1
pins `transformers 4.57.3` in `.venv`; Part 2 is system python). The model also
takes ~tens of seconds to load and should stay **warm** across a batch — a
long-lived service loads it once.

---

## 1. Start the server

```bash
cd ~/Works/Workspace/Mapperatorinator
./run_api.sh                 # http://127.0.0.1:8770   (local only)
./run_api.sh 0.0.0.0 8770    # expose on the LAN (e.g. another machine calls in)
```
Interactive docs at **`http://127.0.0.1:8770/docs`**. The model loads in the
background — `/health` shows `status: loading` then `ready`.

Env knobs: `MAPP_DEVICE` (default `mps`), `MAPP_CONFIG` (default `v32-mini`).

---

## 2. Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | worker status (`loading`/`ready`/`error`) + queue counts |
| `POST` | `/jobs` | enqueue one job by **path** (JSON) |
| `POST` | `/jobs/batch` | enqueue many by path (`{"jobs":[...]}`) |
| `POST` | `/jobs/upload` | enqueue one by **upload** (multipart) |
| `GET`  | `/jobs?status=&limit=` | list jobs |
| `GET`  | `/jobs/{id}` | one job; when `done`, `result` carries `.osu` paths **and** inline text |
| `GET`  | `/jobs/{id}/files/{raw\|fixed}` | download a `.osu` |
| `DELETE` | `/jobs/{id}` | cancel a still-**queued** job |
| `POST` | `/analyze` | enqueue analysis of an existing `.osu` (JSON: `beatmap_path`, `audio_path`) |
| `POST` | `/analyze/upload` | enqueue analysis by **upload** (multipart: `beatmap` + `audio`) |
| `GET`  | `/analyze/{id}` | analyze job; when `done`, `result` is the MaiMod findings JSON |
| `GET`  | `/analyze?status=&limit=` | list analyze jobs |

**Job input fields:** `audio_path` (path mode) *or* uploaded `file`, `title`,
`artist`, `difficulty` (default `5.0`), `fix` (`auto`\|`double_time`\|`simplify`\|`none`,
default `auto`), `out_dir`, `slug`, `seed` (default `42`), `priority` (higher runs first).

**Transport = both** (your chosen design): submit by path *or* upload, and a
finished job returns **both** the on-disk `.osu` paths and the inline `.osu` text
(`result.osu_fixed_text` / `result.osu_raw_text`) — so it works whether or not
the caller shares the filesystem.

**Finished `result`:**
```json
{
  "slug": "dirty_diana",
  "out_dir": ".../mapperatorinator-output/api/dirty_diana",
  "raw_osu": ".../dirty_diana.osu",
  "fixed_osu": ".../dirty_diana_fixed.osu",
  "fix_applied": "none (auto)",
  "bpm_before": 131.35, "bpm_after": 131.35,
  "osu_fixed_text": "osu file format v14\n...",
  "osu_raw_text":  "osu file format v14\n..."
}
```

---

## 3. The queue (built for automation)

- **Persistent** — jobs live in `mapperatorinator-output/api_jobs.db` (SQLite,
  WAL). The queue **survives server restarts**; a job left `running` when the
  server stopped is automatically re-queued on next start.
- **FIFO with priority** — oldest first, higher `priority` jumps ahead.
- **One worker** — the model is single-instance and MPS runs one generation at a
  time, so jobs are processed serially. Throughput ≈ one map every ~2–3 min
  (verified: Dirty Diana ★5 ≈ 175 s, model already warm).
- **Statuses:** `queued → running → done | error | canceled`.

Feed it 100 songs at once (`/jobs/batch`), walk away, poll `/health` for queue
depth and `GET /jobs?status=done` for results.

---

## 4. Calling it from game_content_tools

Use `scripts/mapperatorinator_client.py` (only needs `requests`).

### One song, then convert locally (full Part 1 + Part 2 chain)
```python
from mapperatorinator_client import MapperatorinatorClient
cli = MapperatorinatorClient("http://127.0.0.1:8770")

out = cli.generate_and_convert(
    "/abs/song.mp3", "Smooth Criminal", "Michael Jackson",
    difficulty=5.0,
    out_dir="charts/smooth_criminal",
    analysis="/abs/song.mp3.analysis.json",   # optional enrichment (analyze.py)
    strong_percent=15,
)
print(out["fixed_osu"], out["json"])          # -> .osu + [bh.json, mt3.json]
```

### Batch automation (many songs → poll → convert each)
```python
jobs = cli.submit_batch([
    {"audio_path": "/abs/a.mp3", "title": "A", "artist": "X", "difficulty": 3.0},
    {"audio_path": "/abs/a.mp3", "title": "A", "artist": "X", "difficulty": 7.0},
    {"audio_path": "/abs/b.mp3", "title": "B", "artist": "Y", "difficulty": 5.0},
])
for j in jobs:
    done = cli.wait(j["id"])                   # blocks until this one is ready
    osu_text = done["result"]["osu_fixed_text"]
    # ... write it and run osu_to_json.py, or just use generate_and_convert above
```

### CLI (quick checks / shell automation)
```bash
cd ~/Works/SourceCode/game_content_tools
python3 scripts/mapperatorinator_client.py health
python3 scripts/mapperatorinator_client.py submit /abs/song.mp3 "Title" "Artist" --difficulty 5
python3 scripts/mapperatorinator_client.py list --status done
python3 scripts/mapperatorinator_client.py run  /abs/song.mp3 "Title" "Artist" \
    --difficulty 5 --out-dir charts/title --strong-percent 15      # full chain
```
Point at a remote host with `--base http://HOST:8770` or `MAPP_API` env var; add
`--upload` to send bytes instead of a path (for cross-machine).

---

## 5. Outputs & cleanup

- Generated `.osu` land in `mapperatorinator-output/api/<slug>/` by default
  (override per job with `out_dir`). Uploaded audio is staged under
  `mapperatorinator-output/api/_uploads/`.
- Maps are deterministic (`seed=42`) — safe to delete and regenerate.
- The durable `analysis.json` (from `analyze.py`) belongs next to the source
  audio, not here.

---

## 6. Notes

- **Use `.venv`** to run the server (`run_api.sh` does). System python breaks the
  model (`transformers 5.x`).
- One worker by design — don't pass `--workers >1` to uvicorn; the model isn't
  shared across processes and MPS is serial anyway.
- Local-only by default (`127.0.0.1`). There's no auth — only bind `0.0.0.0` on a
  trusted network.
- **Analysis (`/analyze`)** runs MaiMod on an existing `.osu` + its audio and
  returns per-object findings (real vs. expected). It uses a **separate queue** and
  a **v30** model that **lazy-loads on the first `/analyze` job** (bf16, ~100 s/song);
  it coexists with the generation model. Pass a `.osu` and the audio it was made
  from (they must match). The webui **Analyze** mode has an **⚡ Analyze live** button
  that calls `/analyze/upload`.
- See [INTEGRATION.md](INTEGRATION.md) for the full two-part pipeline and the
  per-song recipe; this file covers only the API layer.
