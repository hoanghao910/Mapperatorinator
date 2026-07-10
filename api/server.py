"""Mapperatorinator generation API (Part 1: audio -> clean .osu).

A small HTTP service so other projects (e.g. game_content_tools) can request
beatmap generation without owning this repo's heavy .venv / MPS model. Jobs are
queued and processed FIFO by one warm-model worker — built for batch automation
(submit many songs, poll for results).

Run:  ./run_api.sh           (or: .venv/bin/python -m uvicorn api.server:app ...)
Docs: http://127.0.0.1:8000/docs   (interactive OpenAPI)

Endpoints
  GET  /health                      worker + queue status
  POST /jobs                        enqueue one job (JSON, path-based)
  POST /jobs/batch                  enqueue many (JSON list)
  POST /jobs/upload                 enqueue one job (multipart audio upload)
  GET  /jobs?status=&limit=         list jobs
  GET  /jobs/{id}                   one job (result has .osu paths + inline text)
  GET  /jobs/{id}/files/{which}     download .osu  (which = raw | fixed)
  DELETE /jobs/{id}                 cancel a still-queued job
"""
import base64
import os
import re
import threading
import time
import traceback
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from api import store
from api.engine import Engine, REPO, slugify
from api.analyze_engine import AnalyzeEngine

UPLOAD_DIR = REPO / "mapperatorinator-output" / "api" / "_uploads"
DEVICE = os.environ.get("MAPP_DEVICE", "mps")
CONFIG_NAME = os.environ.get("MAPP_CONFIG", "v32-mini")
VALID_AUDIO = {".mp3", ".wav", ".ogg", ".m4a", ".flac"}

app = FastAPI(title="Mapperatorinator Generation API", version="1.0")
engine = Engine(config_name=CONFIG_NAME, device=DEVICE)
analyze_engine = AnalyzeEngine(device=DEVICE)   # v30, lazy-loaded on first /analyze
_stop = threading.Event()
_load_lock = threading.Lock()  # serialize model loads (Hydra GlobalHydra is a singleton)


# ─────────────────────────── schemas ───────────────────────────

class JobIn(BaseModel):
    audio_path: str
    title: str
    artist: str
    difficulty: float = 5.0
    fix: str = "auto"           # auto | double_time | simplify | none
    out_dir: Optional[str] = None
    slug: Optional[str] = None
    seed: int = 42
    priority: int = 0


class BatchIn(BaseModel):
    jobs: List[JobIn]


class AnalyzeIn(BaseModel):
    beatmap_path: str                 # existing .osu to analyze
    audio_path: Optional[str] = None  # the audio it was made from (else derived from beatmap dir)


# ─────────────────────────── worker ───────────────────────────

def _worker():
    try:
        with _load_lock:
            engine.load()
    except Exception:
        traceback.print_exc()
        return  # /health will report status=error
    while not _stop.is_set():
        job = store.claim_next()
        if job is None:
            time.sleep(1.0)
            continue
        try:
            res = engine.generate_osu(
                audio_path=job["audio_path"], title=job["title"], artist=job["artist"],
                difficulty=job["difficulty"], out_dir=job["out_dir"], slug=job["slug"],
                seed=job["seed"], fix=job["fix"],
            )
            store.complete(job["id"], res)
        except Exception:
            store.fail(job["id"], traceback.format_exc())


def _analyze_worker():
    """Lazily loads the v30 analysis model on the first job, then serves the queue."""
    while not _stop.is_set():
        job = store.claim_next_analyze()
        if job is None:
            time.sleep(1.0)
            continue
        try:
            if not analyze_engine.ready:
                with _load_lock:
                    if not analyze_engine.ready:
                        analyze_engine.load()
            res = analyze_engine.analyze(
                beatmap_path=job["beatmap_path"], audio_path=job.get("audio_path"))
            store.complete_analyze(job["id"], res)
        except Exception:
            store.fail_analyze(job["id"], traceback.format_exc())


@app.on_event("startup")
def _startup():
    store.init_db()
    store.requeue_running()
    store.requeue_running_analyze()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_worker, name="mapp-worker", daemon=True).start()
    threading.Thread(target=_analyze_worker, name="mapp-analyze-worker", daemon=True).start()


@app.on_event("shutdown")
def _shutdown():
    _stop.set()


# ─────────────────────────── helpers ───────────────────────────

def _validate_audio(path):
    p = Path(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(400, f"audio not found: {path}")
    if p.suffix.lower() not in VALID_AUDIO:
        raise HTTPException(400, f"unsupported audio type: {p.suffix} (allowed: {sorted(VALID_AUDIO)})")


def _job_view(job, inline=True):
    """Attach inline .osu text to a finished job (transport='Both')."""
    if not job:
        raise HTTPException(404, "job not found")
    if inline and job.get("status") == store.STATUS_DONE and isinstance(job.get("result"), dict):
        r = job["result"]
        for key, path in (("osu_raw_text", r.get("raw_osu")), ("osu_fixed_text", r.get("fixed_osu"))):
            if path and os.path.isfile(path):
                try:
                    with open(path) as f:
                        r[key] = f.read()
                except OSError:
                    pass
    return job


# ─────────────────────────── endpoints ───────────────────────────

@app.get("/health")
def health():
    return {
        "status": engine.status,            # loading | ready | error
        "model_loaded": engine.ready,
        "device": DEVICE,
        "config": CONFIG_NAME,
        "error": engine.error,
        "queue": store.counts(),
        "analyze": {
            "status": analyze_engine.status,    # idle/loading until first job, then ready|error
            "model_loaded": analyze_engine.ready,
            "error": analyze_engine.error,
            "queue": store.analyze_counts(),
        },
    }


@app.post("/jobs")
def create_job(job: JobIn):
    _validate_audio(job.audio_path)
    return store.add_job(
        audio_path=job.audio_path, title=job.title, artist=job.artist,
        difficulty=job.difficulty, fix=job.fix, out_dir=job.out_dir,
        slug=job.slug, seed=job.seed, priority=job.priority, source="path",
    )


@app.post("/jobs/batch")
def create_batch(batch: BatchIn):
    out = []
    for j in batch.jobs:
        _validate_audio(j.audio_path)
        out.append(store.add_job(
            audio_path=j.audio_path, title=j.title, artist=j.artist,
            difficulty=j.difficulty, fix=j.fix, out_dir=j.out_dir,
            slug=j.slug, seed=j.seed, priority=j.priority, source="path",
        ))
    return {"count": len(out), "jobs": out}


@app.post("/jobs/upload")
async def create_job_upload(
    file: UploadFile = File(...),
    title: str = Form(...),
    artist: str = Form(...),
    difficulty: float = Form(5.0),
    fix: str = Form("auto"),
    slug: Optional[str] = Form(None),
    seed: int = Form(42),
    priority: int = Form(0),
):
    suffix = Path(file.filename or "audio.mp3").suffix.lower() or ".mp3"
    if suffix not in VALID_AUDIO:
        raise HTTPException(400, f"unsupported audio type: {suffix}")
    safe = slug or slugify(title)
    dest = UPLOAD_DIR / f"{safe}_{int(time.time())}{suffix}"
    with open(dest, "wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    return store.add_job(
        audio_path=str(dest), title=title, artist=artist, difficulty=difficulty,
        fix=fix, slug=slug, seed=seed, priority=priority, source="upload",
    )


@app.get("/jobs")
def list_jobs(status: Optional[str] = None, limit: int = 100):
    return {"jobs": store.list_jobs(status=status, limit=limit)}


@app.get("/jobs/{jid}")
def get_job(jid: str, inline: bool = True):
    return _job_view(store.get_job(jid), inline=inline)


@app.get("/jobs/{jid}/files/{which}")
def get_job_file(jid: str, which: str):
    job = store.get_job(jid)
    if not job:
        raise HTTPException(404, "job not found")
    if job.get("status") != store.STATUS_DONE or not isinstance(job.get("result"), dict):
        raise HTTPException(409, f"job not done (status={job.get('status')})")
    key = {"raw": "raw_osu", "fixed": "fixed_osu"}.get(which)
    if key is None:
        raise HTTPException(400, "which must be 'raw' or 'fixed'")
    path = job["result"].get(key)
    if not path or not os.path.isfile(path):
        raise HTTPException(404, f"{which} .osu not found on disk")
    return FileResponse(path, media_type="text/plain", filename=os.path.basename(path))


@app.delete("/jobs/{jid}")
def delete_job(jid: str):
    job = store.get_job(jid)
    if not job:
        raise HTTPException(404, "job not found")
    if store.cancel(jid):
        return {"id": jid, "status": store.STATUS_CANCELED}
    raise HTTPException(409, f"cannot cancel job in status={job.get('status')} (only queued)")


# ─────────────────────────── analyze endpoints ───────────────────────────

def _validate_osu(path):
    p = Path(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(400, f"beatmap not found: {path}")
    if p.suffix.lower() != ".osu":
        raise HTTPException(400, f"beatmap must be a .osu: {p.suffix}")


@app.post("/analyze")
def create_analyze(job: AnalyzeIn):
    _validate_osu(job.beatmap_path)
    if job.audio_path:
        _validate_audio(job.audio_path)
    return store.add_analyze_job(beatmap_path=job.beatmap_path, audio_path=job.audio_path, source="path")


@app.post("/analyze/upload")
async def create_analyze_upload(
    beatmap: UploadFile = File(...),
    audio: UploadFile = File(...),
):
    if Path(beatmap.filename or "").suffix.lower() != ".osu":
        raise HTTPException(400, "beatmap must be a .osu file")
    asuf = Path(audio.filename or "audio.mp3").suffix.lower() or ".mp3"
    if asuf not in VALID_AUDIO:
        raise HTTPException(400, f"unsupported audio type: {asuf}")
    stamp = int(time.time())
    bm_dest = UPLOAD_DIR / f"analyze_{stamp}.osu"
    au_dest = UPLOAD_DIR / f"analyze_{stamp}{asuf}"
    for up, dest in ((beatmap, bm_dest), (audio, au_dest)):
        with open(dest, "wb") as f:
            while chunk := await up.read(1 << 20):
                f.write(chunk)
    return store.add_analyze_job(beatmap_path=str(bm_dest), audio_path=str(au_dest), source="upload")


@app.get("/analyze")
def list_analyze(status: Optional[str] = None, limit: int = 100):
    return {"jobs": store.list_analyze_jobs(status=status, limit=limit)}


@app.get("/analyze/{jid}")
def get_analyze(jid: str):
    job = store.get_analyze_job(jid)
    if not job:
        raise HTTPException(404, "analyze job not found")
    return job


# ─────────────────────────── recent runs (disk scan) ───────────────────────────
# The webui demo/analyze dropdowns are static fixtures; to also surface whatever
# has actually been generated, we scan the output tree for finished maps and serve
# them by an opaque id (base64 of the repo-relative path). No DB dependency, so it
# catches maps made by any path (API jobs, stem_study, run_generate.sh, by hand).

RUNS_ROOT = REPO / "mapperatorinator-output"
_RUN_AUDIO_EXT = (".mp3", ".ogg", ".wav", ".m4a", ".flac")


def _run_id(rel_posix: str) -> str:
    return base64.urlsafe_b64encode(rel_posix.encode()).decode().rstrip("=")


def _run_path(rid: str) -> Path:
    """Decode a run id back to an on-disk .osu path, validated to stay under
    RUNS_ROOT (no traversal) and to actually be an .osu file that exists."""
    pad = "=" * (-len(rid) % 4)
    try:
        rel = base64.urlsafe_b64decode(rid + pad).decode()
    except Exception:
        raise HTTPException(400, "bad run id")
    p = (RUNS_ROOT / rel).resolve()
    try:
        p.relative_to(RUNS_ROOT.resolve())
    except ValueError:
        raise HTTPException(400, "run id escapes output dir")
    if p.suffix != ".osu" or not p.is_file():
        raise HTTPException(404, "run map not found")
    return p


def _osu_quickstats(path: Path) -> dict:
    """Mode + object count + notes/s + LN% from an .osu, cheap single pass."""
    mode, times, holds, sec = None, [], 0, None
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            for ln in f:
                s = ln.strip()
                if s.startswith("Mode:"):
                    try:
                        mode = int(s.split(":", 1)[1])
                    except ValueError:
                        pass
                elif s.startswith("["):
                    sec = s
                elif sec == "[HitObjects]" and s:
                    p = s.split(",")
                    if len(p) >= 4:
                        try:
                            times.append(int(p[2]))
                            if int(p[3]) & 128:
                                holds += 1
                        except ValueError:
                            pass
    except OSError:
        return {}
    n = len(times)
    if not n:
        return {"mode": mode, "objs": 0}
    dur = (max(times) - min(times)) / 1000.0
    return {"mode": mode, "objs": n,
            "nps": round(n / dur, 2) if dur else 0,
            "ln_pct": round(100 * holds / n)}


def _run_label(rel_posix: str) -> str:
    """Human label from the path: the last 2-3 meaningful path parts, minus the
    generic filename. e.g. stem_study/maps/thapphonktudo/original_H/x_fixed.osu
    → 'thapphonktudo · original H'."""
    parts = rel_posix.split("/")[:-1]  # drop filename
    for junk in ("mapperatorinator-output", "maps", "api"):
        parts = [p for p in parts if p != junk]
    tail = parts[-2:] if len(parts) >= 2 else parts
    return " · ".join(t.replace("_", " ") for t in tail) or rel_posix


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _read_audio_filename(osu_path: Path) -> Optional[str]:
    """The `AudioFilename:` basename declared in the .osu, if any."""
    try:
        with open(osu_path, encoding="utf-8", errors="ignore") as f:
            for ln in f:
                s = ln.strip()
                if s.startswith("AudioFilename:"):
                    return os.path.basename(s.split(":", 1)[1].strip())
                if s.startswith("[") and s != "[General]":
                    break  # AudioFilename lives in [General], near the top
    except OSError:
        pass
    return None


def _audio_index() -> dict:
    """basename(lower) → [paths] for every audio file under the output dir. Built
    once per request so audio can be resolved even when it lives in a different
    subtree than the map (e.g. stem_study keeps stems under stems/htdemucs/…)."""
    idx: dict = {}
    if RUNS_ROOT.is_dir():
        for ext in _RUN_AUDIO_EXT:
            for p in RUNS_ROOT.rglob(f"*{ext}"):
                idx.setdefault(p.name.lower(), []).append(p)
    return idx


def _resolve_run_audio(osu_path: Path, index: Optional[dict] = None) -> Optional[Path]:
    """Find the audio for a map. Prefer a sibling matching its AudioFilename; else
    search the whole output tree for that basename, disambiguating by the map's
    path tokens (so cocongmaisac/other_H → stems/htdemucs/CoCongMaiSac/other.mp3,
    not thapphonktudo's other.mp3). Falls back to any audio beside the map."""
    af = _read_audio_filename(osu_path)
    if af:
        sib = osu_path.parent / af
        if sib.is_file():
            return sib
        cands = (index if index is not None else _audio_index()).get(af.lower(), [])
        if len(cands) == 1:
            return cands[0]
        if cands:
            try:
                want = {_norm(t) for t in osu_path.relative_to(RUNS_ROOT).parts}
            except ValueError:
                want = set()
            return max(cands, key=lambda c: len(
                want & {_norm(t) for t in c.relative_to(RUNS_ROOT).parts}))
    # last resort: any audio sitting next to the map (older API-job layout)
    for d in (osu_path.parent, osu_path.parent.parent):
        if d and d.is_dir():
            for ext in _RUN_AUDIO_EXT:
                hits = sorted(d.glob(f"*{ext}"))
                if hits:
                    return hits[0]
    return None


@app.get("/runs")
def list_runs(limit: int = 60):
    """List recently generated maps (newest first) found on disk under the output
    dir. Each entry has an opaque id usable with /runs/{id}/osu and /runs/{id}/audio."""
    if not RUNS_ROOT.is_dir():
        return []
    files = [p for p in RUNS_ROOT.rglob("*_fixed.osu")
             if "_uploads" not in p.parts]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    files = files[:max(1, min(limit, 500))]
    index = _audio_index()
    out = []
    for p in files:
        rel = p.relative_to(RUNS_ROOT).as_posix()
        st = _osu_quickstats(p)
        out.append({
            "id": _run_id(rel),
            "label": _run_label(rel),
            "path": rel,
            "mtime": int(p.stat().st_mtime),
            "has_audio": _resolve_run_audio(p, index) is not None,
            **st,
        })
    return out


@app.get("/runs/{rid}/osu")
def get_run_osu(rid: str):
    p = _run_path(rid)
    return FileResponse(str(p), media_type="text/plain", filename=p.name)


@app.get("/runs/{rid}/audio")
def get_run_audio(rid: str):
    aud = _resolve_run_audio(_run_path(rid))
    if not aud:
        raise HTTPException(404, "no audio found for this run")
    return FileResponse(str(aud), filename=aud.name)


@app.get("/", response_class=PlainTextResponse)
def root():
    return "Mapperatorinator Generation API — see /docs and /health"
