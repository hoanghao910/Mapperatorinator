"""Persistent job queue (SQLite) for the generation API.

Survives restarts so a long automation run can be resumed and inspected. One
background worker claims jobs FIFO (by priority then creation order); the HTTP
handlers only enqueue and read. WAL mode + short-lived connections keep the
worker thread and request threads from blocking each other.
"""
import json
import sqlite3
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "mapperatorinator-output" / "api_jobs.db"

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_ERROR = "error"
STATUS_CANCELED = "canceled"


def _conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=30000")
    return c


def init_db():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id         TEXT PRIMARY KEY,
                status     TEXT NOT NULL,
                priority   INTEGER NOT NULL DEFAULT 0,
                created    REAL NOT NULL,
                started    REAL,
                finished   REAL,
                audio_path TEXT NOT NULL,
                title      TEXT NOT NULL,
                artist     TEXT NOT NULL,
                difficulty REAL NOT NULL,
                fix        TEXT NOT NULL,
                out_dir    TEXT,
                slug       TEXT,
                seed       INTEGER NOT NULL DEFAULT 42,
                source     TEXT,            -- 'path' | 'upload'
                error      TEXT,
                result     TEXT             -- JSON
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC, created)")
        c.execute("""
            CREATE TABLE IF NOT EXISTS analyze_jobs (
                id           TEXT PRIMARY KEY,
                status       TEXT NOT NULL,
                created      REAL NOT NULL,
                started      REAL,
                finished     REAL,
                beatmap_path TEXT NOT NULL,
                audio_path   TEXT,
                source       TEXT,            -- 'path' | 'upload'
                error        TEXT,
                result       TEXT             -- JSON (findings)
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_analyze_status ON analyze_jobs(status, created)")


def add_job(*, audio_path, title, artist, difficulty=5.0, fix="auto",
            out_dir=None, slug=None, seed=42, priority=0, source="path"):
    jid = uuid.uuid4().hex[:12]
    with _conn() as c:
        c.execute(
            "INSERT INTO jobs (id,status,priority,created,audio_path,title,artist,"
            "difficulty,fix,out_dir,slug,seed,source) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (jid, STATUS_QUEUED, priority, time.time(), str(audio_path), title, artist,
             float(difficulty), fix, out_dir, slug, int(seed), source),
        )
    return get_job(jid)


def get_job(jid):
    with _conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
    return _row_to_dict(row)


def list_jobs(status=None, limit=100):
    q = "SELECT * FROM jobs"
    args = []
    if status:
        q += " WHERE status=?"
        args.append(status)
    q += " ORDER BY created DESC LIMIT ?"
    args.append(int(limit))
    with _conn() as c:
        rows = c.execute(q, args).fetchall()
    return [_row_to_dict(r) for r in rows]


def counts():
    with _conn() as c:
        rows = c.execute("SELECT status, COUNT(*) n FROM jobs GROUP BY status").fetchall()
    return {r["status"]: r["n"] for r in rows}


def claim_next():
    """Atomically move the oldest queued job to running; return it or None."""
    with _conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT * FROM jobs WHERE status=? ORDER BY priority DESC, created LIMIT 1",
            (STATUS_QUEUED,),
        ).fetchone()
        if row is None:
            c.execute("COMMIT")
            return None
        c.execute("UPDATE jobs SET status=?, started=? WHERE id=?",
                  (STATUS_RUNNING, time.time(), row["id"]))
        c.execute("COMMIT")
    return get_job(row["id"])


def complete(jid, result):
    with _conn() as c:
        c.execute("UPDATE jobs SET status=?, finished=?, result=?, error=NULL WHERE id=?",
                  (STATUS_DONE, time.time(), json.dumps(result), jid))


def fail(jid, error):
    with _conn() as c:
        c.execute("UPDATE jobs SET status=?, finished=?, error=? WHERE id=?",
                  (STATUS_ERROR, time.time(), str(error)[:4000], jid))


def cancel(jid):
    """Cancel only if still queued. Returns True if canceled."""
    with _conn() as c:
        cur = c.execute("UPDATE jobs SET status=?, finished=? WHERE id=? AND status=?",
                        (STATUS_CANCELED, time.time(), jid, STATUS_QUEUED))
        return cur.rowcount > 0


def requeue_running():
    """On startup, any job left 'running' was interrupted — put it back."""
    with _conn() as c:
        cur = c.execute("UPDATE jobs SET status=?, started=NULL WHERE status=?",
                        (STATUS_QUEUED, STATUS_RUNNING))
        return cur.rowcount


# ─────────────────────────── analyze jobs ───────────────────────────

def add_analyze_job(*, beatmap_path, audio_path=None, source="path"):
    jid = uuid.uuid4().hex[:12]
    with _conn() as c:
        c.execute(
            "INSERT INTO analyze_jobs (id,status,created,beatmap_path,audio_path,source) "
            "VALUES (?,?,?,?,?,?)",
            (jid, STATUS_QUEUED, time.time(), str(beatmap_path),
             str(audio_path) if audio_path else None, source),
        )
    return get_analyze_job(jid)


def get_analyze_job(jid):
    with _conn() as c:
        row = c.execute("SELECT * FROM analyze_jobs WHERE id=?", (jid,)).fetchone()
    return _row_to_dict(row)


def list_analyze_jobs(status=None, limit=100):
    q = "SELECT * FROM analyze_jobs"
    args = []
    if status:
        q += " WHERE status=?"
        args.append(status)
    q += " ORDER BY created DESC LIMIT ?"
    args.append(int(limit))
    with _conn() as c:
        rows = c.execute(q, args).fetchall()
    return [_row_to_dict(r) for r in rows]


def analyze_counts():
    with _conn() as c:
        rows = c.execute("SELECT status, COUNT(*) n FROM analyze_jobs GROUP BY status").fetchall()
    return {r["status"]: r["n"] for r in rows}


def claim_next_analyze():
    with _conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT * FROM analyze_jobs WHERE status=? ORDER BY created LIMIT 1",
            (STATUS_QUEUED,),
        ).fetchone()
        if row is None:
            c.execute("COMMIT")
            return None
        c.execute("UPDATE analyze_jobs SET status=?, started=? WHERE id=?",
                  (STATUS_RUNNING, time.time(), row["id"]))
        c.execute("COMMIT")
    return get_analyze_job(row["id"])


def complete_analyze(jid, result):
    with _conn() as c:
        c.execute("UPDATE analyze_jobs SET status=?, finished=?, result=?, error=NULL WHERE id=?",
                  (STATUS_DONE, time.time(), json.dumps(result), jid))


def fail_analyze(jid, error):
    with _conn() as c:
        c.execute("UPDATE analyze_jobs SET status=?, finished=?, error=? WHERE id=?",
                  (STATUS_ERROR, time.time(), str(error)[:4000], jid))


def requeue_running_analyze():
    with _conn() as c:
        cur = c.execute("UPDATE analyze_jobs SET status=?, started=NULL WHERE status=?",
                        (STATUS_QUEUED, STATUS_RUNNING))
        return cur.rowcount


def _row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    if d.get("result"):
        try:
            d["result"] = json.loads(d["result"])
        except (ValueError, TypeError):
            pass
    return d
