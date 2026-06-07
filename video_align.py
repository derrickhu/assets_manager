"""截帧对齐：透明底 bbox 底边对齐 + 统一身高。"""

from __future__ import annotations

import re
import statistics
import time
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from video_tools import (
    FRAMES_DIR,
    WORKSPACE_ROOT,
    alpha_bbox,
    alpha_trim,
    read_batch_meta,
    resolve_frame_paths,
    write_batch_meta,
)

DEFAULT_CANVAS = 512
DEFAULT_BOTTOM_PAD = 8
ALPHA_THRESHOLD = 16


def batch_align_frames(
    video_id: str,
    frame_paths: list[str],
    canvas_w: int = DEFAULT_CANVAS,
    canvas_h: int = DEFAULT_CANVAS,
    bottom_pad: int = DEFAULT_BOTTOM_PAD,
    target_height: int | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    paths = resolve_frame_paths(video_id, frame_paths)
    if not paths:
        raise ValueError('No valid frames to align')

    canvas_w = max(32, int(canvas_w))
    canvas_h = max(32, int(canvas_h))
    bottom_pad = max(0, int(bottom_pad))

    crops: list[tuple[Path, Image.Image, str, int | None]] = []
    heights: list[int] = []

    for src in paths:
        rel_src = str(src.relative_to(WORKSPACE_ROOT)).replace('\\', '/')
        img = Image.open(src).convert('RGBA')
        crop = alpha_trim(img, padding=0, alpha_th=ALPHA_THRESHOLD)
        if crop.width < 1 or crop.height < 1:
            raise ValueError(f'Empty alpha content: {rel_src}')
        heights.append(crop.height)
        ts_match = re.search(r'_frame_(\d+)', src.stem)
        timestamp_ms = int(ts_match.group(1)) if ts_match else None
        crops.append((src, crop, rel_src, timestamp_ms))

    if target_height is None or target_height <= 0:
        target_h = int(statistics.median(heights))
    else:
        target_h = int(target_height)
    target_h = max(1, target_h)

    batch_id = f'align_{int(time.time() * 1000)}'
    batch_dir = FRAMES_DIR / video_id / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    frames_meta: dict[str, Any] = {}
    frames_out: list[dict[str, Any]] = []
    total = len(crops)

    for idx, (src, crop, rel_src, timestamp_ms) in enumerate(crops):
        out_img, meta = align_crop_to_canvas(
            crop, target_h, canvas_w, canvas_h, bottom_pad,
        )
        meta['source_path'] = rel_src
        meta['timestamp_ms'] = timestamp_ms
        meta['offset_x'] = 0
        meta['offset_y'] = 0

        out_name = f'{src.stem}.png'
        out_path = batch_dir / out_name
        out_img.save(out_path, 'PNG')
        rel_out = str(out_path.relative_to(WORKSPACE_ROOT)).replace('\\', '/')

        frame_info = {
            'path': rel_out,
            'filename': out_name,
            'batch_id': batch_id,
            'stage': 'align',
            'source_path': rel_src,
            'timestamp_ms': timestamp_ms,
            'size': out_path.stat().st_size,
            'align_meta': meta,
        }
        frames_out.append(frame_info)
        frames_meta[out_name] = meta
        if on_progress:
            on_progress(idx + 1, total)

    write_batch_meta(batch_dir, {
        'batch_id': batch_id,
        'stage': 'align',
        'canvas_w': canvas_w,
        'canvas_h': canvas_h,
        'bottom_pad': bottom_pad,
        'target_height': target_h,
        'count': len(frames_out),
        'frames': frames_meta,
    })

    return {
        'video_id': video_id,
        'batch_id': batch_id,
        'stage': 'align',
        'canvas_w': canvas_w,
        'canvas_h': canvas_h,
        'bottom_pad': bottom_pad,
        'target_height': target_h,
        'count': len(frames_out),
        'frames': frames_out,
    }


def align_crop_to_canvas(
    crop: Image.Image,
    target_h: int,
    canvas_w: int,
    canvas_h: int,
    bottom_pad: int,
    scale_mul: float = 1.0,
    offset_x: int = 0,
    offset_y: int = 0,
) -> tuple[Image.Image, dict[str, Any]]:
    ch = max(1, crop.height)
    scale = (target_h / ch) * scale_mul
    nw = max(1, int(round(crop.width * scale)))
    nh = max(1, int(round(crop.height * scale)))
    resized = crop.resize((nw, nh), Image.Resampling.LANCZOS)

    paste_x = (canvas_w - nw) // 2 + offset_x
    paste_y = canvas_h - bottom_pad - nh + offset_y

    out = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    out.paste(resized, (paste_x, paste_y), resized)

    return out, {
        'scale': scale,
        'scale_mul': scale_mul,
        'paste_x': paste_x,
        'paste_y': paste_y,
        'canvas_w': canvas_w,
        'canvas_h': canvas_h,
        'bottom_pad': bottom_pad,
        'content_w': nw,
        'content_h': nh,
        'target_height': target_h,
    }


def apply_align_adjustments(
    video_id: str,
    batch_id: str,
    adjustments: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    batch_dir = FRAMES_DIR / video_id / batch_id
    if not batch_dir.is_dir() or not batch_id.startswith('align_'):
        raise FileNotFoundError('Align batch not found')

    meta = read_batch_meta(batch_dir) or {}
    batch_meta = meta.get('frames') or {}
    canvas_w = int(meta.get('canvas_w') or DEFAULT_CANVAS)
    canvas_h = int(meta.get('canvas_h') or DEFAULT_CANVAS)
    bottom_pad = int(meta.get('bottom_pad') or DEFAULT_BOTTOM_PAD)
    target_h = int(meta.get('target_height') or DEFAULT_CANVAS)

    updated = 0
    for filename, adj in adjustments.items():
        frame_meta = batch_meta.get(filename)
        if not frame_meta:
            continue
        source_path = frame_meta.get('source_path')
        if not source_path:
            continue
        src = WORKSPACE_ROOT / source_path.replace('\\', '/')
        if not src.exists():
            raise FileNotFoundError(f'Source not found: {source_path}')

        crop = alpha_trim(Image.open(src).convert('RGBA'), padding=0, alpha_th=ALPHA_THRESHOLD)
        scale_mul = float(adj.get('scale_mul', frame_meta.get('scale_mul', 1.0)))
        offset_x = int(adj.get('offset_x', frame_meta.get('offset_x', 0)))
        offset_y = int(adj.get('offset_y', frame_meta.get('offset_y', 0)))

        out_img, new_meta = align_crop_to_canvas(
            crop, target_h, canvas_w, canvas_h, bottom_pad,
            scale_mul=scale_mul, offset_x=offset_x, offset_y=offset_y,
        )
        new_meta['source_path'] = frame_meta.get('source_path')
        new_meta['timestamp_ms'] = frame_meta.get('timestamp_ms')
        new_meta['offset_x'] = offset_x
        new_meta['offset_y'] = offset_y
        new_meta['scale_mul'] = scale_mul

        out_path = batch_dir / filename
        out_img.save(out_path, 'PNG')
        batch_meta[filename] = new_meta
        updated += 1

    meta['frames'] = batch_meta
    write_batch_meta(batch_dir, meta)
    return {'updated': updated, 'batch_id': batch_id}


def preview_align_frame(
    video_id: str,
    batch_id: str,
    source_path: str,
    scale_mul: float = 1.0,
    offset_x: int = 0,
    offset_y: int = 0,
) -> BytesIO:
    """单帧对齐预览（与保存时渲染一致）。"""
    from io import BytesIO

    batch_dir = FRAMES_DIR / video_id / batch_id
    if not batch_dir.is_dir() or not batch_id.startswith('align_'):
        raise FileNotFoundError('Align batch not found')

    meta = read_batch_meta(batch_dir) or {}
    canvas_w = int(meta.get('canvas_w') or DEFAULT_CANVAS)
    canvas_h = int(meta.get('canvas_h') or DEFAULT_CANVAS)
    bottom_pad = int(meta.get('bottom_pad') or DEFAULT_BOTTOM_PAD)
    target_h = int(meta.get('target_height') or DEFAULT_CANVAS)

    rel = source_path.replace('\\', '/').lstrip('/')
    src = WORKSPACE_ROOT / rel
    if not src.exists():
        raise FileNotFoundError(f'Source not found: {source_path}')

    crop = alpha_trim(Image.open(src).convert('RGBA'), padding=0, alpha_th=ALPHA_THRESHOLD)
    out_img, _ = align_crop_to_canvas(
        crop, target_h, canvas_w, canvas_h, bottom_pad,
        scale_mul=float(scale_mul),
        offset_x=int(offset_x),
        offset_y=int(offset_y),
    )
    buf = BytesIO()
    out_img.save(buf, 'PNG')
    buf.seek(0)
    return buf
