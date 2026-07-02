"""Warm-model inference engine for the generation API (Part 1).

Loads the v32-mini model + diffusion model ONCE and reuses them across every
queued job, so batch automation doesn't pay the model-load cost per song.
Wraps the existing inference.py functions (model loading is cleanly separated
from generate()), then applies the osu_timing.py fix to produce the corrected
.osu the downstream converter consumes.

Must run with cwd = repo root (inference.py reads some configs relatively).
"""
import copy
import os
import re
import threading
from pathlib import Path

from accelerate.utils import set_seed
from hydra import compose, initialize_config_dir
from omegaconf import OmegaConf

# Importing these registers the structured configs (inference/base, train/base,
# diffusion/base) in Hydra's ConfigStore — required before compose().
import config as _reg_inf  # noqa: F401
import osuT5.osuT5.config as _reg_t5  # noqa: F401
import osu_diffusion.config as _reg_diff  # noqa: F401

import inference as I
import osu_timing
import mania_ln
import osu_thin

REPO = Path(__file__).resolve().parent.parent
CONFIG_DIR = str(REPO / "configs" / "inference")


def slugify(text):
    return re.sub(r'[^a-z0-9]+', '_', (text or "").lower()).strip('_') or "song"


class Engine:
    """Holds warm models. generate_osu() is serialized — MPS runs one at a time."""

    def __init__(self, config_name="v32-mini", device="mps"):
        self.config_name = config_name
        self.device = device
        self.ready = False
        self.status = "loading"
        self.error = None
        self._lock = threading.Lock()
        self.base = None
        self.model = self.tokenizer = None
        self.timing_model = self.timing_tokenizer = None
        self.diff_model = self.diff_tokenizer = self.refine_model = None

    # ── model load (once) ──
    def load(self):
        try:
            base = self._compose([
                f"device={self.device}",
                # osu!mania, 5 keys — matches the game's 5-lane format.
                # positions are irrelevant in mania (columns, not x,y) → skip the
                # diffusion pass entirely (faster warmup + generation).
                "gamemode=3",
                "keycount=5",
                "generate_positions=false",
                "seed=42",
            ])
            I.compile_device_and_seed(base, verbose=True)
            I.compile_default_args(base, verbose=False)
            I.compile_derived_args(base)
            I.setup_inference_environment(base.seed)
            self.base = base

            self.model, self.tokenizer = self._load_main(base, auto_gamemode=base.auto_select_gamemode_model)

            if I.should_load_separate_timing_model(base):
                self.timing_model, self.timing_tokenizer = self._load_main(base, auto_gamemode=False)

            if base.generate_positions:
                self.diff_model, self.diff_tokenizer = I.load_diff_model(
                    base.diff_ckpt, base.diffusion, base.device)
                if os.path.exists(base.diff_refine_ckpt):
                    self.refine_model = I.load_diff_model(
                        base.diff_refine_ckpt, base.diffusion, base.device)[0]

            self.ready = True
            self.status = "ready"
        except Exception as e:  # surfaced via /health
            self.status = "error"
            self.error = f"{type(e).__name__}: {e}"
            raise

    def _compose(self, overrides):
        with initialize_config_dir(config_dir=CONFIG_DIR, version_base="1.1"):
            cfg = compose(config_name=self.config_name, overrides=overrides)
        return OmegaConf.to_object(cfg)

    def _load_main(self, base, auto_gamemode):
        return I.load_model_with_server(
            base.model_path, base.train, base.device,
            max_batch_size=base.max_batch_size, use_server=base.use_server,
            precision=base.precision, attn_implementation=base.attn_implementation,
            lora_path=base.lora_path, gamemode=base.gamemode,
            auto_select_gamemode_model=auto_gamemode)

    # ── per-job generation ──
    def generate_osu(self, *, audio_path, title, artist, difficulty=5.0,
                     out_dir=None, slug=None, seed=42, fix="auto",
                     hold_note_ratio=None, ln_target=None):
        if not self.ready:
            raise RuntimeError(f"engine not ready (status={self.status})")
        slug = slug or slugify(title)
        out_dir = str(out_dir or (REPO / "mapperatorinator-output" / "api" / slug))
        os.makedirs(out_dir, exist_ok=True)

        with self._lock:  # one generation at a time on the shared model / MPS
            job = copy.deepcopy(self.base)
            job.audio_path = str(audio_path)
            job.output_path = out_dir
            job.beatmap_path = ""
            job.difficulty = float(difficulty)
            # per-difficulty LN tier (BENCHMARK.md §6): hold_note_ratio enables
            # holds in the model; the exact LN% is enforced by the post-process.
            tier = mania_ln.tier_for(float(difficulty))
            job.hold_note_ratio = (hold_note_ratio if hold_note_ratio is not None
                                   else tier["hold_note_ratio"])
            job.title = title
            job.artist = artist
            job.title_unicode = None
            job.artist_unicode = None
            job.tags = None
            job.seed = int(seed)

            I.compile_paths(job)            # validates audio exists, sets output
            I.compile_default_args(job, verbose=False)
            I.compile_derived_args(job)
            set_seed(job.seed)              # deterministic per job

            gen_cfg, bm_cfg = I.get_config(job)
            _result, raw_path, _osz = I.generate(
                job,
                generation_config=gen_cfg,
                beatmap_path=None,
                beatmap_config=bm_cfg,
                model=self.model, tokenizer=self.tokenizer,
                timing_model=self.timing_model, timing_tokenizer=self.timing_tokenizer,
                diff_model=self.diff_model, diff_tokenizer=self.diff_tokenizer,
                refine_model=self.refine_model,
                verbose=False,
            )

        # normalise filename (cheap, outside the lock)
        raw_osu = os.path.join(out_dir, f"{slug}.osu")
        if os.path.abspath(raw_path) != os.path.abspath(raw_osu):
            os.replace(raw_path, raw_osu)

        # density cap: thin notes/s to the tier target FIRST, so the game chart
        # isn't a frantic 1/4 stream. Runs before the LN pass because osu_thin
        # sets the note *count* while mania_ln only flips note *types* — so both
        # the density and LN% targets hold on the final map.
        thin_info = {}
        try:
            thin_info = osu_thin.apply_density_cap(
                raw_osu, osu_thin.tier_for(float(difficulty))["target_nps"],
                out_path=raw_osu, verbose=False)
        except Exception as e:  # never fail a job on a post-process
            thin_info = {"thin_error": f"{type(e).__name__}: {e}"}

        # mania LN post-process: enforce the exact per-tier LN% on the raw map
        # (before timing fix, which only touches [TimingPoints]).
        ln_info = {}
        target = ln_target if ln_target is not None else tier["ln_target"]
        try:
            ln_info = mania_ln.apply_long_notes(
                raw_osu, str(audio_path), target, out_path=raw_osu, verbose=False)
        except Exception as e:  # never fail a job on the polish pass
            ln_info = {"ln_error": f"{type(e).__name__}: {e}"}

        fixed_osu = os.path.join(out_dir, f"{slug}_fixed.osu")
        fix_info = self._timing_fix(raw_osu, fixed_osu, fix, audio_path)

        return {
            "slug": slug,
            "out_dir": out_dir,
            "raw_osu": raw_osu,
            "fixed_osu": fixed_osu,
            "tier": tier["name"],
            "thin": thin_info,
            "ln": ln_info,
            **fix_info,
        }

    @staticmethod
    def _timing_fix(raw, fixed, mode, audio_path):
        content = osu_timing.read_osu(raw)
        match, _body, points = osu_timing.parse_timing_block(content)
        if match is None:
            # no timing section — just copy through
            with open(fixed, "w") as f:
                f.write(content)
            return {"fix_applied": "none (no timing points)", "bpm_before": None, "bpm_after": None}
        ref_bpm = None
        if mode == "auto":
            ref_bpm, _src = osu_timing.ref_bpm_from_analysis(raw, audio_path)
        fixed_pts, applied = osu_timing.resolve_fix(points, mode, ref_bpm, 180.0)
        new = osu_timing.rewrite_osu(content, match, osu_timing.serialize_points(fixed_pts))
        with open(fixed, "w") as f:
            f.write(new)
        return {
            "fix_applied": applied,
            "bpm_before": osu_timing.median_bpm(points),
            "bpm_after": osu_timing.median_bpm(fixed_pts),
        }
