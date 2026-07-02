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
import os
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


@app.get("/", response_class=PlainTextResponse)
def root():
    return "Mapperatorinator Generation API — see /docs and /health"
