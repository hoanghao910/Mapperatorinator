# 🎮 Mapperatorinator — Handover Document

> Generated: 2026-06-11 23:09 GMT+7
> Machine gốc: Mac Mini M1 (haonh289@gmail.com)
> Target: Máy work — Claude Code

---

## 1. 🎯 Project Overview

**Mapperatorinator** (OliBomby) — AI osu! beatmap generator dùng diffusion model.
- Repo: `github.com/OliBomby/Mapperatorinator`
- Input: Audio → Output: `.osu` beatmap files
- Hỗ trợ osu!mania mode (4K/7K)
- Stems separation (Demucs) để phân tích attribution

**Mục tiêu experiment:** Tạo beatmap osu!mania cho 5 bài hát của Michael Jackson, phân tích stem attribution (stem nào đóng góp object nào vào beatmap cuối).

---

## 2. 📂 File Structure

### Repo chính
```
//Mapperatorinator/
├── inference.py              ← Entry point chính (Hydra config)
├── config.py
├── configs/                  ← Hydra configs
│   ├── inference/
│   │   ├── default.yaml
│   │   └── mt3.yaml
│   └── model/
├── cli_inference.sh          ← Shell script chạy inference
├── requirements.txt
├── Dockerfile / compose.yaml
├── colab/                    ← Colab notebook cho GPU
└── datasets/                 ← Dataset loader code
```

### Data Output
```
/mapperatorinator-output/
├── HANDOVER.md                         ← THIS FILE
│
├── multi-difficulty/                   ← 5 songs × 3 difficulties
│   ├── beat_it/
│   │   ├── Beat_It.mp3                 ← Audio gốc
│   │   ├── normal/beat_it_normal.osu
│   │   ├── easy/beat_it_easy.osu
│   │   └── hard/beat_it_hard.osu
│   ├── black_or_white/
│   ├── dirty_diana/
│   ├── give_in_to_me/
│   └── smooth_criminal/
│       └── Smooth_Criminal.mp3
│
├── stems/
│   ├── separated/                       ← Audio stems (2.4GB on disk)
│   │   └── demucs/htdemucs/
│   │       ├── Beat_It/ {vocals,drums,bass,other}.wav
│   │       ├── Black_Or_White/
│   │       ├── Dirty_Diana/
│   │       └── Give_In_To_Me/
│   │
│   ├── mapperatorinator_output/        ← 20 stem beatmaps
│   │   ├── beat_it_vocals/normal/*.osu
│   │   ├── beat_it_drums/normal/*.osu
│   │   └── ... (5 songs × 4 stems)
│   │
│   ├── attribution/                    ← 🏆 KẾT QUẢ CHÍNH
│   │   ├── attribution_summary.json    ← Tổng hợp 92.2% match
│   │   ├── beat_it_attribution.json
│   │   ├── black_or_white_attribution.json
│   │   ├── dirty_diana_attribution.json
│   │   ├── give_in_to_me_attribution.json
│   │   └── smooth_criminal_attribution.json
│   │
│   ├── logs/                           ← 20 log files từ batch runs
│   ├── report/                         ← Benchmark reports
│   ├── benchmark.py                    ← Demucs vs BS-RoFormer
│   ├── stem_batch_runner.sh            ← Batch runner script
│   ├── stem_batch_resume.sh
│   ├── analyze_attribution.py          ← Attribution analysis
│   └── bs_roformer_4stems_ft.pth       ← 503MB (failed model)
│
├── timing_analysis.py                  ← BPM analysis
├── timing_analysis_v2.py
├── batch_run.sh
├── temp_guard.sh
├── update_metadata.py
├── convert_bh.py
│
├── mapperatorinator-data.zip           ← 139MB (excl. stems)
└── mapperatorinator-stems.zip          ← 1.9GB (stems audio only)
```

---

## 3. ⚙️ Environment Setup (cho máy mới)

### Requirements
```bash
# Python
Python 3.10+ (tested on 3.14)

# PyTorch (MPS cho Mac Silicon)
pip install torch torchvision torchaudio

# Mapperatorinator dependencies
cd /path/to/Mapperatorinator
pip install -r requirements.txt

# Audio processing
pip install demucs PySoundFile librosa soundfile

# Analysis
pip install numpy scipy
```

### GPU Notes (Mac Mini M1)
- ✅ MPS available (`torch.backends.mps.is_available()`)
- ❌ CUDA not available
- Mapperatorinator inference chạy ổn trên CPU/MPS, ~2-5 phút/bài normal difficulty

### Virtual Environment
```bash
cd /path/to/Mapperatorinator
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

---

## 4. 🔬 Workflow Đã Thực Hiện

### Phase 1: Baseline Multi-Difficulty ✅
Chạy Mapperatorinator trên 5 bài hát × 3 difficulties (easy/hard/normal)
- Dùng Hydra config với model MT3 và BH
- Output: `multi-difficulty/{slug}/{difficulty}/*.osu`

### Phase 2: Stem Separation ✅
Dùng Demucs 4.0 (`htdemucs`) tách audio thành 4 stems:
- `vocals.wav`, `drums.wav`, `bass.wav`, `other.wav`
- Mỗi bài ~170-381MB (WAV 44.1kHz)
- Test cả BS-RoFormer → ❌ fail (architecture mismatch)

### Phase 3: Stem Beatmap Generation ✅
Chạy Mapperatorinator trên từng stem riêng lẻ (normal difficulty):
- 5 songs × 4 stems × 1 difficulty = 20 runs
- Batch script: `stems/stem_batch_runner.sh`
- Thời gian: ~9h (tối 10/6 → sáng 11/6)
- Output: `stems/mapperatorinator_output/`

### Phase 4: Attribution Analysis ✅
So sánh map gốc (full mix) với 4 stem maps:
- Script: `stems/analyze_attribution.py`
- Match window: 75ms
- **Kết quả: 92.2% overall match rate**

---

## 5. 🏆 Kết Quả Attribution

| Bài | Objects | Match % | Drums 🥁 | Bass 🎸 | Vocals 🎤 | Other 🎵 |
|-----|---------|---------|---------|--------|---------|---------|
| Smooth Criminal | 1,751 | **96.1%** | 54.6% | 24.3% | 9.1% | 8.0% |
| Black or White | 737 | **94.6%** | 56.7% | 8.1% | 4.2% | 25.5% |
| Dirty Diana | 930 | **89.9%** | 49.5% | 10.3% | 14.8% | 15.3% |
| Beat It | 1,027 | **89.7%** | 38.7% | 12.8% | 14.9% | 23.4% |
| Give In To Me | 1,197 | **89.1%** | 64.1% | 5.8% | 11.2% | 8.0% |
| **Total** | **5,642** | **92.2%** | **53.1%** | **13.9%** | **10.9%** | **14.3%** |

### Key Findings
1. **Drums 🥁 = dominant stem** (~53% objects overall)
2. **Bass timing matches original** (117.5 BPM)
3. **"Other" stem unreliable for timing** (harmonic content only)
4. **BS-RoFormer** → không cần dùng, Demucs 4 stems đủ

---

## 6. 🚀 Các Lệnh Chính

### Generate beatmap từ audio (single)
```bash
cd /path/to/Mapperatorinator
python inference.py \
    audio_path=/path/to/song.mp3 \
    output_dir=/path/to/output \
    diff=5.0 \
    model=mt3
```

### Stem separation (Demucs)
```bash
demucs --two-stems=vocals -o stems_output/ song.mp3
# or with htdemucs (4 stems):
demucs -n htdemucs -o stems_output/ song.mp3
```

### Chạy attribution analysis
```bash
cd /path/to/mapperatorinator-output
python stems/analyze_attribution.py
```

### Batch inference script
```bash
# Xem stems/stem_batch_runner.sh làm template
# Cấu trúc: SONG:STEM + DIFF + DIFF_VAL
```

---

## 7. 📝 Dataset Info

| Slug | Title | BPM | Duration | MP3 Source |
|------|-------|-----|----------|------------|
| `beat_it` | Beat It | 136 | ~4:18 | YouTube `oRdxUFDoQe0` |
| `black_or_white` | Black or White | 117 | ~3:18 | YouTube `lFqZOYtFtOY` |
| `dirty_diana` | Dirty Diana | 129 | ~5:00 | YouTube `LJ7qXHjxj_0` |
| `give_in_to_me` | Give In To Me | 172 | ~5:28 | YouTube `YP3W-E0OamU` |
| `smooth_criminal` | Smooth Criminal | 117 | ~4:18 | YouTube `h_D3VFfhvs4` |

---

## 8. 🔜 Next Steps / Ideas

1. **Fine-tune Mapperatorinator** trên dataset osu!mania chuyên biệt
2. **Weighted difficulty scaling** — dùng drums làm base, điều chỉnh density dựa trên stem attribution
3. **Multi-stem fusion** — kết hợp object từ nhiều stems thay vì chỉ dùng 1 stem
4. **Thêm songs** từ playlist MJ hoặc thể loại khác
5. **Export batch sang .osz** — để import trực tiếp vào osu! client
6. **Thử với GPU Colab** nếu cần speed (T4/K80)
7. **Phân tích timing pattern** cho từng stem chi tiết hơn

---

## 9. 💾 Machine Context

- **Machine gốc:** Mac Mini M1 (home)
- **Workspace:** ``
- **Python:** 3.14.5
- **PyTorch:** 2.12.0 (MPS)
- **Các tools đã dùng:**
  - `ffmpeg` — audio conversion
  - `demucs` — stem separation (pip install)
  - `librosa` — timing/BPM analysis
  - `Mapperatorinator` — từ git repo OliBomby
  - Google Colab — for GPU inference runs

---

## 10. 📦 File Size Reference

| Item | Size | Notes |
|------|------|-------|
| multi-difficulty/ | 66 MB | Cần cho attribution |
| stems/separated/htdemucs/ | 761 MB | Cần cho re-gen |
| stems/separated/demucs/ | 1.6 GB | Có thể bỏ (htdemucs là chính) |
| mapperatorinator-data.zip | 139 MB | Portable, không có stems |
| mapperatorinator-stems.zip | 1.9 GB | WAV stems compressed |
| bs_roformer_4stems_ft.pth | 503 MB | FAILED model, có thể xoá |

---

*Happy mapping! 🎵*
