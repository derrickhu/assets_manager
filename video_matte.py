"""批量 rembg 抠图。"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Callable

os.environ.setdefault('OMP_NUM_THREADS', '8')

from video_tools import (
    FRAMES_DIR,
    WORKSPACE_ROOT,
    alpha_trim,
    resolve_frame_paths,
    write_batch_meta,
)

REMBG_MODELS = (
    'birefnet-general',
    'birefnet-general-lite',
    'u2net',
    'isnet-anime',
)
DEFAULT_MODEL = 'birefnet-general'
MATTE_PADDING = 4


def check_rembg() -> dict[str, Any]:
    try:
        import rembg  # noqa: F401
        return {
            'available': True,
            'models': list(REMBG_MODELS),
            'default_model': DEFAULT_MODEL,
        }
    except ImportError:
        return {
            'available': False,
            'models': list(REMBG_MODELS),
            'default_model': DEFAULT_MODEL,
            'error': 'rembg 未安装，请运行: pip3 install rembg onnxruntime',
        }


def _load_rembg_session(model: str):
    from rembg import new_session

    if model not in REMBG_MODELS:
        raise ValueError(f'Unsupported model: {model}')
    return new_session(model, providers=['CPUExecutionProvider'])


def batch_matte_frames(
    video_id: str,
    frame_paths: list[str],
    model: str = DEFAULT_MODEL,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    from PIL import Image
    from rembg import remove

    status = check_rembg()
    if not status['available']:
        raise RuntimeError(status.get('error') or 'rembg 不可用')

    paths = resolve_frame_paths(video_id, frame_paths)
    if not paths:
        raise ValueError('No valid frames to process')

    batch_id = f'matte_{int(time.time() * 1000)}'
    batch_dir = FRAMES_DIR / video_id / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    session = _load_rembg_session(model)
    frames_meta: dict[str, Any] = {}
    frames_out: list[dict[str, Any]] = []
    total = len(paths)

    for idx, src in enumerate(paths):
        rel_src = str(src.relative_to(WORKSPACE_ROOT)).replace('\\', '/')
        img = Image.open(src).convert('RGBA')
        result = remove(img, session=session)
        result = alpha_trim(result, MATTE_PADDING)
        out_name = f'{src.stem}.png'
        out_path = batch_dir / out_name
        result.save(out_path, 'PNG')
        rel_out = str(out_path.relative_to(WORKSPACE_ROOT)).replace('\\', '/')
        ts_match = re.search(r'_frame_(\d+)', src.stem)
        timestamp_ms = int(ts_match.group(1)) if ts_match else None
        frame_info = {
            'path': rel_out,
            'filename': out_name,
            'batch_id': batch_id,
            'stage': 'matte',
            'source_path': rel_src,
            'timestamp_ms': timestamp_ms,
            'size': out_path.stat().st_size,
        }
        frames_out.append(frame_info)
        frames_meta[out_name] = {'source_path': rel_src, 'timestamp_ms': timestamp_ms}
        if on_progress:
            on_progress(idx + 1, total)

    write_batch_meta(batch_dir, {
        'batch_id': batch_id,
        'stage': 'matte',
        'model': model,
        'count': len(frames_out),
        'frames': frames_meta,
    })

    return {
        'video_id': video_id,
        'batch_id': batch_id,
        'stage': 'matte',
        'model': model,
        'count': len(frames_out),
        'frames': frames_out,
    }
