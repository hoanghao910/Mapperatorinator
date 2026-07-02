"""Warm-model analysis engine for the web visualizer (the 'Analyze' pillar).

Loads the MaiMod model (v30) ONCE and reuses it across requests, so the
interactive viewer doesn't pay the ~860 MB model-load cost per analysis.
Wraps mai_mod.ai_mod(), which (with json_output) returns structured findings:
per hit-object surprisal, actual-vs-expected event, x/y, category.

MaiMod is v30-specific (the in-context template the analysis path needs only
exists in v30). Must run with cwd = repo root.
"""
import copy
import threading
from pathlib import Path

from hydra import compose, initialize_config_dir
from omegaconf import OmegaConf
from slider import Beatmap

# Importing these registers the structured configs (inference/base, train/base,
# diffusion/base, base_mai_mod) in Hydra's ConfigStore — required before compose().
import config as _reg_inf  # noqa: F401
import osuT5.osuT5.config as _reg_t5  # noqa: F401
import osu_diffusion.config as _reg_diff  # noqa: F401

import mai_mod
from inference import (get_config, load_model_with_server, compile_args, compile_default_args,
                       compile_derived_args, compile_device_and_seed, setup_inference_environment)

REPO = Path(__file__).resolve().parent.parent
CONFIG_DIR = str(REPO / "configs")


class AnalyzeEngine:
    """Holds a warm MaiMod model. analyze() is serialized — MPS runs one at a time."""

    # bf16 is ~25x faster than fp32 on Apple MPS for this path (~100s vs ~40min/song)
    # and produces equivalent findings — fp32 hits a CPU-fallback bottleneck.
    def __init__(self, config_name="mai_mod", inference="v30", device="mps", precision="bf16"):
        self.config_name = config_name
        self.inference = inference
        self.device = device
        self.precision = precision
        self.ready = False
        self.status = "idle"   # idle → loading (first job) → ready | error
        self.error = None
        self._lock = threading.Lock()
        self.base = None
        self.model = self.tokenizer = None
        self.gamemodes = ()

    # ── model load (once) ──
    def load(self):
        try:
            self.status = "loading"
            base = self._compose([
                f"inference={self.inference}",
                f"inference.device={self.device}",
                f"precision={self.precision}",
            ])
            i_args = base.inference
            i_args.precision = base.precision
            # Load-time prep only — NOT compile_args/compile_paths (those need an
            # audio path, which only exists per-request in analyze()).
            compile_device_and_seed(i_args, verbose=False)
            compile_default_args(i_args, verbose=False)
            compile_derived_args(i_args)
            setup_inference_environment(i_args.seed)

            self.model, self.tokenizer = load_model_with_server(
                i_args.model_path, i_args.train, i_args.device,
                max_batch_size=i_args.max_batch_size, use_server=False,
                precision=i_args.precision, attn_implementation=i_args.attn_implementation,
                gamemode=i_args.gamemode,
                auto_select_gamemode_model=i_args.auto_select_gamemode_model,
            )
            self.gamemodes = tuple(i_args.train.data.gamemodes)
            self.base = base
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

    # ── per-request analysis ──
    def analyze(self, *, beatmap_path, audio_path=None, json_path=None):
        if not self.ready:
            raise RuntimeError(f"analyze engine not ready (status={self.status})")
        bm = Path(beatmap_path)
        if not bm.is_file() or bm.suffix.lower() != ".osu":
            raise FileNotFoundError(f"beatmap not found or not a .osu: {beatmap_path}")

        mode = Beatmap.from_path(bm).mode
        if mode not in self.gamemodes:
            raise ValueError(
                f"beatmap gamemode {mode} not supported by the loaded {self.inference} model "
                f"(supports {list(self.gamemodes)}). Only these modes can be analyzed.")

        with self._lock:  # one analysis at a time on the shared model / MPS
            args = copy.deepcopy(self.base)
            args.beatmap_path = str(beatmap_path)
            args.audio_path = str(audio_path) if audio_path else ""
            args.json_output = True
            args.json_output_path = str(json_path or bm.with_suffix(".maimod.json"))

            i_args = args.inference
            i_args.beatmap_path = args.beatmap_path
            i_args.audio_path = args.audio_path
            i_args.precision = args.precision
            compile_args(i_args)            # derives audio from beatmap if not given

            gen_cfg, _bm_cfg = get_config(i_args)
            return mai_mod.ai_mod(
                args,
                generation_config=gen_cfg,
                beatmap_path=i_args.beatmap_path,
                model=self.model, tokenizer=self.tokenizer,
                verbose=False,
            )
