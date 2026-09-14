"""把任意 TTS provider 的输出统一转成 DH_live 实时数字人渲染器要求的音频格式。

DH 的 wasm 口型驱动（``Module._setAudioBuffer``）只接受
**16000Hz / 单声道 / PCM_16 WAV**（见 DH_live/web_demo/voiceapi/tts.py 的 ``get_audio()``）。
而 Shikigami 各 provider 的输出格式并不统一：

============  ==========================
provider      输出
============  ==========================
edge_tts      MP3（24kHz）
kokoro        WAV
gpt_sovits    WAV
qwen3_tts     WAV
============  ==========================

因此在这里做一次集中归一化，供 ``/ws/tts?format=dh`` 使用。

实现策略（按代价从低到高）：
1. 已经是目标格式 → 原样返回（用标准库 ``wave`` 嗅探头部，零拷贝）；
2. ``soundfile`` 进程内解码 + 重采样（覆盖 WAV/FLAC/OGG，新版 libsndfile 亦支持 MP3）；
3. ``ffmpeg`` 子进程兜底（libsndfile 读不了 MP3 时）。

之所以把 2 放在 3 前面：ffmpeg 每次要起进程，而首响时间是这条路最核心的体验指标，
优先走进程内路径可以把每句的转码开销压到毫秒级。
"""

from __future__ import annotations

import io
import logging
import shutil
import subprocess
import wave
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# DH 渲染器要求的硬性参数，勿改（改了口型会失控）
DH_SAMPLE_RATE = 16000
DH_CHANNELS = 1
DH_SUBTYPE = "PCM_16"

# 单次转码的兜底上限：超长音频（异常输入）直接截断，避免拖垮播放链路
_MAX_SECONDS = 120

_ffmpeg_path_cache: Optional[str] = None
_ffmpeg_probed = False


def _is_target_wav(raw: bytes) -> bool:
    """判断 raw 是否已经是 16k/单声道/16bit PCM WAV。"""
    if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return False
    try:
        with wave.open(io.BytesIO(raw), "rb") as w:
            return (
                w.getnchannels() == DH_CHANNELS
                and w.getsampwidth() == 2
                and w.getframerate() == DH_SAMPLE_RATE
                and w.getcomptype() == "NONE"
            )
    except (wave.Error, EOFError):
        return False


def _encode_pcm16_wav(samples, sample_rate: int = DH_SAMPLE_RATE) -> bytes:
    """float 波形 → 16k/单声道/PCM_16 WAV（优先 soundfile，退化为标准库 wave）。"""
    try:
        import numpy as np
        import soundfile as sf

        arr = np.asarray(samples, dtype="float32")
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        arr = np.clip(arr, -1.0, 1.0)
        # 统一走 soundfile，保证头部写法与 DH 侧完全一致
        if sample_rate != DH_SAMPLE_RATE:
            arr = _resample(arr, sample_rate, DH_SAMPLE_RATE)
        out = io.BytesIO()
        sf.write(out, arr, DH_SAMPLE_RATE, format="WAV", subtype=DH_SUBTYPE)
        return out.getvalue()
    except Exception:
        pass

    # 纯标准库兜底（不依赖 numpy / soundfile，但要求入参已是 PCM 整数数组）
    import numpy as np  # noqa: F401  仍需要 numpy 做类型归一

    arr = np.asarray(samples)
    if arr.dtype.kind == "f":
        arr = np.clip(arr, -1.0, 1.0)
        arr = (arr * 32767.0).astype("<i2")
    else:
        arr = arr.astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(DH_CHANNELS)
        w.setsampwidth(2)
        w.setframerate(DH_SAMPLE_RATE)
        w.writeframes(arr.tobytes())
    return out.getvalue()


def _resample(arr, src_rate: int, dst_rate: int):
    """线性插值重采样。

    采样率比是简单的比例（24000→16000 等）。线性插值的抗混叠不如多相滤波，
    但用于口型驱动足够，且换来的是零依赖、亚毫秒级耗时。
    """
    import numpy as np

    if src_rate == dst_rate or arr.size == 0:
        return arr
    n_out = int(round(arr.size * dst_rate / float(src_rate)))
    if n_out <= 0:
        return arr
    x_old = np.linspace(0.0, 1.0, num=arr.size, endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
    return np.interp(x_new, x_old, arr).astype("float32")


def _decode_with_soundfile(raw: bytes) -> Tuple["object", int]:
    """用 soundfile 解码为 (float32 单声道波形, 采样率)。失败抛异常。"""
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    return np.ascontiguousarray(mono, dtype="float32"), int(sr)


def _find_ffmpeg() -> Optional[str]:
    """定位 ffmpeg：PATH → imageio-ffmpeg 自带二进制。结果缓存。"""
    global _ffmpeg_path_cache, _ffmpeg_probed
    if _ffmpeg_probed:
        return _ffmpeg_path_cache
    _ffmpeg_probed = True

    exe = shutil.which("ffmpeg")
    if exe:
        _ffmpeg_path_cache = exe
        return exe
    try:
        import imageio_ffmpeg  # type: ignore

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe:
            _ffmpeg_path_cache = exe
            return exe
    except Exception:
        pass
    logger.debug("[dh_audio] 未找到 ffmpeg，MP3 类输入将无法转码")
    return None


def _transcode_with_ffmpeg(raw: bytes) -> bytes:
    """ffmpeg 兜底：直接产出目标格式 WAV。"""
    exe = _find_ffmpeg()
    if not exe:
        raise RuntimeError("未找到 ffmpeg，无法解码该音频格式")
    proc = subprocess.run(
        [
            exe, "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0",
            "-t", str(_MAX_SECONDS),
            "-ac", str(DH_CHANNELS),
            "-ar", str(DH_SAMPLE_RATE),
            "-acodec", "pcm_s16le",
            "-f", "wav",
            "pipe:1",
        ],
        input=raw,
        capture_output=True,
        timeout=30,
    )
    if proc.returncode != 0 or not proc.stdout:
        err = (proc.stderr or b"").decode("utf-8", "ignore").strip()[:300]
        raise RuntimeError(f"ffmpeg 转码失败: {err}")
    return proc.stdout


def to_dh_wav(raw: bytes) -> bytes:
    """任意 TTS 输出 → 16kHz / 单声道 / PCM_16 WAV。

    失败时抛出异常，由调用方决定是否降级（不返回半成品，避免口型错乱）。
    """
    if not raw:
        return b""

    # 1) 已是目标格式：零开销直通
    if _is_target_wav(raw):
        return raw

    # 2) 进程内解码（WAV / FLAC / OGG，以及 libsndfile ≥1.1 的 MP3）
    try:
        samples, sr = _decode_with_soundfile(raw)
        return _encode_pcm16_wav(samples, sr)
    except Exception as e:
        logger.debug("[dh_audio] soundfile 解码失败，转 ffmpeg: %s", e)

    # 3) ffmpeg 兜底
    return _transcode_with_ffmpeg(raw)
