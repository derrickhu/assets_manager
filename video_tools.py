"""
视频截帧工具 — 工作区管理、ffprobe 元数据、ffmpeg 截帧、导出到 game_assets。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

APP_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = APP_DIR / '.video_workspace'
VIDEOS_DIR = WORKSPACE_ROOT / 'videos'
FRAMES_DIR = WORKSPACE_ROOT / 'frames'
META_DIR = WORKSPACE_ROOT / 'meta'
FRAME_THUMBS_DIR = WORKSPACE_ROOT / '.thumbs'

VIDEO_EXTS = {'.mp4', '.mov', '.webm', '.mkv'}
FRAME_EXTS = {'.png', '.jpg', '.jpeg'}
BATCH_META_FILE = '_batch_meta.json'
VIDEO_MAX_MB = int(os.environ.get('VIDEO_MAX_MB', '500'))
MAX_EXTRACT_FRAMES = int(os.environ.get('VIDEO_MAX_FRAMES', '500'))
WORKSPACE_TTL_DAYS = int(os.environ.get('VIDEO_WORKSPACE_TTL_DAYS', '7'))
THUMB_SIZE = (200, 200)

# launchd 默认 PATH 不含 Homebrew，需显式探测
_FFMPEG_CANDIDATES = (
    os.environ.get('FFMPEG_PATH', ''),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
)
_FFPROBE_CANDIDATES = (
    os.environ.get('FFPROBE_PATH', ''),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
)


def _resolve_bin(candidates: tuple[str, ...], fallback_name: str) -> str | None:
    for c in candidates:
        if c and Path(c).is_file():
            return c
    return shutil.which(fallback_name)


def ffmpeg_bin() -> str | None:
    return _resolve_bin(_FFMPEG_CANDIDATES, 'ffmpeg')


def ffprobe_bin() -> str | None:
    return _resolve_bin(_FFPROBE_CANDIDATES, 'ffprobe')


def ensure_workspace() -> None:
    for d in (VIDEOS_DIR, FRAMES_DIR, META_DIR, FRAME_THUMBS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def check_ffmpeg() -> dict[str, Any]:
    fb = ffmpeg_bin()
    pb = ffprobe_bin()
    return {
        'available': bool(fb and pb),
        'ffmpeg': bool(fb),
        'ffprobe': bool(pb),
        'ffmpeg_path': fb,
        'ffprobe_path': pb,
    }


def secure_filename(filename: str) -> str:
    filename = re.sub(r'[\\/:*?"<>|]', '', filename or '')
    return filename.strip('. ')


def secure_subdir(subdir: str) -> str:
    if not subdir:
        return ''
    parts = []
    for part in subdir.replace('\\', '/').split('/'):
        cleaned = secure_filename(part.strip())
        if cleaned and cleaned not in ('.', '..'):
            parts.append(cleaned)
    return '/'.join(parts)


def _run_cmd(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def ms_to_ffmpeg_ts(ms: int) -> str:
    ms = max(0, int(ms))
    total_sec, milli = divmod(ms, 1000)
    h, rem = divmod(total_sec, 3600)
    m, s = divmod(rem, 60)
    return f'{h:02d}:{m:02d}:{s:02d}.{milli:03d}'


def probe_video(video_path: Path) -> dict[str, Any]:
    pb = ffprobe_bin()
    if not pb:
        raise RuntimeError('ffprobe 未找到，请运行: brew install ffmpeg')
    cmd = [
        pb, '-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', str(video_path),
    ]
    result = _run_cmd(cmd, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or 'ffprobe failed')

    data = json.loads(result.stdout or '{}')
    duration_sec = float(data.get('format', {}).get('duration') or 0)
    width = height = fps = None
    for stream in data.get('streams', []):
        if stream.get('codec_type') == 'video':
            width = stream.get('width')
            height = stream.get('height')
            rate = stream.get('avg_frame_rate') or stream.get('r_frame_rate') or '0/0'
            if '/' in rate:
                num, den = rate.split('/', 1)
                if float(den or 0) > 0:
                    fps = round(float(num) / float(den), 3)
            break

    return {
        'duration_ms': int(duration_sec * 1000),
        'width': width,
        'height': height,
        'fps': fps,
        'size': video_path.stat().st_size,
    }


def _meta_path(video_id: str) -> Path:
    return META_DIR / f'{video_id}.json'


def _load_meta(video_id: str) -> dict[str, Any] | None:
    path = _meta_path(video_id)
    if not path.exists():
        return None
    with path.open('r', encoding='utf-8') as f:
        return json.load(f)


def _save_meta(video_id: str, meta: dict[str, Any]) -> None:
    ensure_workspace()
    meta['updated_at'] = int(time.time() * 1000)
    with _meta_path(video_id).open('w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


def _video_dir(video_id: str) -> Path:
    return VIDEOS_DIR / video_id


def _video_file(video_id: str) -> Path | None:
    meta = _load_meta(video_id)
    if not meta:
        return None
    path = _video_dir(video_id) / meta['filename']
    return path if path.exists() else None


def resolve_workspace_path(rel_path: str) -> Path:
    rel_path = rel_path.replace('\\', '/').lstrip('/')
    target = (WORKSPACE_ROOT / rel_path).resolve()
    root = WORKSPACE_ROOT.resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError('Invalid workspace path') from exc
    return target


def resolve_frame_paths(video_id: str, frame_paths: list[str]) -> list[Path]:
    prefix = f'frames/{video_id}/'
    resolved: list[Path] = []
    for rel in frame_paths:
        rel_norm = rel.replace('\\', '/').lstrip('/')
        if not rel_norm.startswith(prefix):
            raise ValueError(f'Invalid frame path: {rel}')
        src = resolve_workspace_path(rel_norm)
        if not src.exists() or not src.is_file():
            raise FileNotFoundError(f'Frame not found: {rel}')
        if src.suffix.lower() not in FRAME_EXTS:
            raise ValueError(f'Unsupported frame type: {rel}')
        resolved.append(src)
    return resolved


def batch_stage_from_id(batch_id: str) -> str:
    if batch_id.startswith('matte_'):
        return 'matte'
    if batch_id.startswith('align_'):
        return 'align'
    return 'raw'


def latest_batch_id(video_id: str, stage: str | None = None) -> str | None:
    base = FRAMES_DIR / video_id
    if not base.exists():
        return None
    prefix_map = {'raw': 'batch_', 'matte': 'matte_', 'align': 'align_'}
    if stage and stage in prefix_map:
        prefix = prefix_map[stage]
        batches = sorted(
            [p.name for p in base.iterdir() if p.is_dir() and p.name.startswith(prefix)],
            reverse=True,
        )
        return batches[0] if batches else None
    batches = sorted([p.name for p in base.iterdir() if p.is_dir()], reverse=True)
    return batches[0] if batches else None


def write_batch_meta(batch_dir: Path, meta: dict[str, Any]) -> None:
    batch_dir.mkdir(parents=True, exist_ok=True)
    with (batch_dir / BATCH_META_FILE).open('w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


def read_batch_meta(batch_dir: Path) -> dict[str, Any] | None:
    path = batch_dir / BATCH_META_FILE
    if not path.exists():
        return None
    with path.open('r', encoding='utf-8') as f:
        return json.load(f)


def alpha_bbox(im: 'Image.Image', alpha_th: int = 16) -> tuple[int, int, int, int] | None:
    if not HAS_PIL:
        return None
    if im.mode != 'RGBA':
        im = im.convert('RGBA')
    alpha = im.split()[3].point(lambda p: 255 if p > alpha_th else 0)
    return alpha.getbbox()


def alpha_trim(im: 'Image.Image', padding: int = 4, alpha_th: int = 16) -> 'Image.Image':
    if not HAS_PIL:
        return im
    if im.mode != 'RGBA':
        im = im.convert('RGBA')
    bbox = alpha_bbox(im, alpha_th)
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - padding)
    y0 = max(0, y0 - padding)
    x1 = min(im.width, x1 + padding)
    y1 = min(im.height, y1 + padding)
    return im.crop((x0, y0, x1, y1))


def list_videos(limit: int = 50) -> list[dict[str, Any]]:
    ensure_workspace()
    items: list[dict[str, Any]] = []
    for meta_file in sorted(META_DIR.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with meta_file.open('r', encoding='utf-8') as f:
                meta = json.load(f)
            meta['video_id'] = meta_file.stem
            items.append(meta)
        except (json.JSONDecodeError, OSError):
            continue
        if len(items) >= limit:
            break
    return items


def save_upload(file_storage, original_filename: str) -> dict[str, Any]:
    ensure_workspace()
    ffmpeg_status = check_ffmpeg()
    if not ffmpeg_status['available']:
        raise RuntimeError('ffmpeg/ffprobe 未安装，请运行: brew install ffmpeg')

    filename = secure_filename(original_filename)
    if not filename:
        raise ValueError('Invalid filename')

    ext = Path(filename).suffix.lower()
    if ext not in VIDEO_EXTS:
        raise ValueError(f'Unsupported video type: {ext}')

    video_id = uuid.uuid4().hex[:12]
    video_dir = _video_dir(video_id)
    video_dir.mkdir(parents=True, exist_ok=True)
    target = video_dir / filename

    file_storage.save(str(target))
    size = target.stat().st_size
    if size > VIDEO_MAX_MB * 1024 * 1024:
        target.unlink(missing_ok=True)
        video_dir.rmdir()
        raise ValueError(f'Video too large (max {VIDEO_MAX_MB}MB)')

    probe = probe_video(target)
    now = int(time.time() * 1000)
    meta = {
        'video_id': video_id,
        'filename': filename,
        'original_name': original_filename,
        'created_at': now,
        'updated_at': now,
        'last_access_at': now,
        **probe,
    }
    _save_meta(video_id, meta)
    return meta


def get_meta(video_id: str) -> dict[str, Any]:
    meta = _load_meta(video_id)
    if not meta:
        raise FileNotFoundError('Video not found')
    meta['video_id'] = video_id
    meta['last_access_at'] = int(time.time() * 1000)
    _save_meta(video_id, meta)
    return meta


def get_video_path(video_id: str) -> Path:
    path = _video_file(video_id)
    if not path:
        raise FileNotFoundError('Video not found')
    get_meta(video_id)
    return path


def _extract_single_frame(
    video_path: Path,
    timestamp_ms: int,
    output_path: Path,
    fmt: str,
    quality: int,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fb = ffmpeg_bin()
    if not fb:
        raise RuntimeError('ffmpeg 未找到，请运行: brew install ffmpeg')
    ts = ms_to_ffmpeg_ts(timestamp_ms)
    cmd = [
        fb, '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', ts, '-i', str(video_path),
        '-frames:v', '1',
    ]
    if fmt == 'jpg':
        q = max(2, min(31, int(round(31 - (quality / 100) * 29))))
        cmd += ['-q:v', str(q)]
    cmd.append(str(output_path))
    result = _run_cmd(cmd, timeout=120)
    if result.returncode != 0 or not output_path.exists():
        raise RuntimeError(result.stderr.strip() or f'Failed to extract frame at {timestamp_ms}ms')


def estimate_interval_frame_count(duration_ms: int, interval_sec: float, start_ms: int = 0, end_ms: int | None = None) -> int:
    """与 _compute_timestamps(interval) 一致的帧数估算。"""
    end = duration_ms if end_ms is None else min(end_ms, duration_ms)
    start = max(0, start_ms)
    step = max(1, int(float(interval_sec or 1) * 1000))
    count = 0
    cur = start
    while cur <= end:
        count += 1
        cur += step
    return count


def _compute_timestamps(
    mode: str,
    duration_ms: int,
    timestamp_ms: int | None,
    interval_sec: float | None,
    start_ms: int,
    end_ms: int | None,
    count: int | None,
    timestamps_ms: list[int] | None,
) -> list[int]:
    end = duration_ms if end_ms is None else min(end_ms, duration_ms)
    start = max(0, start_ms)

    if mode == 'single':
        return [max(0, int(timestamp_ms or 0))]

    if mode == 'interval':
        step = max(1, int(float(interval_sec or 1) * 1000))
        out = []
        cur = start
        while cur <= end:
            out.append(cur)
            cur += step
        return out

    if mode == 'count':
        n = max(1, int(count or 1))
        if n == 1:
            return [start]
        span = max(1, end - start)
        return [start + int(span * i / (n - 1)) for i in range(n)]

    if mode == 'timestamps':
        return sorted({max(0, min(end, int(t))) for t in (timestamps_ms or [])})

    raise ValueError(f'Unknown extract mode: {mode}')


def extract_frames(
    video_id: str,
    mode: str,
    fmt: str = 'png',
    quality: int = 85,
    prefix: str = '',
    timestamp_ms: int | None = None,
    interval_sec: float | None = None,
    start_ms: int = 0,
    end_ms: int | None = None,
    count: int | None = None,
    timestamps_ms: list[int] | None = None,
) -> dict[str, Any]:
    ffmpeg_status = check_ffmpeg()
    if not ffmpeg_status['available']:
        raise RuntimeError('ffmpeg/ffprobe 未安装，请运行: brew install ffmpeg')

    meta = get_meta(video_id)
    video_path = get_video_path(video_id)
    fmt = 'jpg' if fmt == 'jpg' else 'png'
    prefix = secure_filename(prefix) or Path(meta['filename']).stem

    timestamps = _compute_timestamps(
        mode, meta['duration_ms'], timestamp_ms, interval_sec,
        start_ms, end_ms, count, timestamps_ms,
    )
    if not timestamps:
        raise ValueError('No timestamps to extract')
    if len(timestamps) > MAX_EXTRACT_FRAMES:
        raise ValueError(
            f'截帧数量 {len(timestamps)} 超过上限 {MAX_EXTRACT_FRAMES}，请增大间隔或缩短范围'
        )

    batch_id = f'batch_{int(time.time() * 1000)}'
    batch_dir = FRAMES_DIR / video_id / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    frames: list[dict[str, Any]] = []
    for ts in timestamps:
        name = f'{prefix}_frame_{ts:06d}.{fmt}'
        out_path = batch_dir / name
        _extract_single_frame(video_path, ts, out_path, fmt, quality)
        rel = str(out_path.relative_to(WORKSPACE_ROOT)).replace('\\', '/')
        frames.append({
            'path': rel,
            'filename': name,
            'timestamp_ms': ts,
            'size': out_path.stat().st_size,
        })

    return {
        'video_id': video_id,
        'batch_id': batch_id,
        'mode': mode,
        'count': len(frames),
        'frames': frames,
    }


def list_frames(
    video_id: str,
    batch_id: str | None = None,
    stage: str | None = None,
) -> list[dict[str, Any]]:
    base = FRAMES_DIR / video_id
    if not base.exists():
        return []

    if batch_id:
        batches = [batch_id]
    elif stage in ('raw', 'matte', 'align'):
        latest = latest_batch_id(video_id, stage)
        batches = [latest] if latest else []
    else:
        latest = latest_batch_id(video_id)
        batches = [latest] if latest else []

    frames: list[dict[str, Any]] = []
    for bid in batches:
        batch_path = base / bid
        if not batch_path.is_dir():
            continue
        batch_meta = read_batch_meta(batch_path) or {}
        frame_meta_map = batch_meta.get('frames') or {}
        st = batch_meta.get('stage') or batch_stage_from_id(bid)
        for fpath in sorted(batch_path.iterdir()):
            if not fpath.is_file() or fpath.suffix.lower() not in FRAME_EXTS:
                continue
            if fpath.name == BATCH_META_FILE:
                continue
            rel = str(fpath.relative_to(WORKSPACE_ROOT)).replace('\\', '/')
            ts_match = re.search(r'_frame_(\d+)\.', fpath.name)
            fm = frame_meta_map.get(fpath.name) or {}
            item: dict[str, Any] = {
                'path': rel,
                'filename': fpath.name,
                'batch_id': bid,
                'stage': st,
                'timestamp_ms': fm.get('timestamp_ms') or (int(ts_match.group(1)) if ts_match else None),
                'size': fpath.stat().st_size,
            }
            if fm.get('source_path'):
                item['source_path'] = fm['source_path']
            if st == 'align' and fm:
                item['align_meta'] = {
                    k: fm[k] for k in (
                        'scale', 'scale_mul', 'paste_x', 'paste_y',
                        'offset_x', 'offset_y', 'canvas_w', 'canvas_h', 'bottom_pad',
                    ) if k in fm
                }
            frames.append(item)
    return frames


def make_frame_thumbnail(rel_path: str) -> Path | None:
    if not HAS_PIL:
        return None
    src = resolve_workspace_path(rel_path)
    if not src.exists():
        return None
    thumb_name = hashlib.md5(rel_path.encode()).hexdigest() + '.jpg'
    thumb_path = FRAME_THUMBS_DIR / thumb_name
    if thumb_path.exists() and thumb_path.stat().st_mtime >= src.stat().st_mtime:
        return thumb_path
    try:
        img = Image.open(src)
        img.thumbnail(THUMB_SIZE, Image.Resampling.LANCZOS)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        img.save(thumb_path, 'JPEG', quality=85)
        return thumb_path
    except Exception:
        return None


def export_frames_to_game_assets(
    frame_paths: list[str],
    asset_root: Path,
    game: str,
    valid_games: set[str],
    subdir: str = '',
    rename_prefix: str = '',
) -> list[str]:
    if game not in valid_games:
        raise ValueError('Invalid game directory')

    target_dir = asset_root / game
    subdir = secure_subdir(subdir)
    if subdir:
        target_dir = target_dir / subdir
    target_dir.mkdir(parents=True, exist_ok=True)

    exported: list[str] = []
    rename_prefix = secure_filename(rename_prefix)

    for rel in frame_paths:
        src = resolve_workspace_path(rel)
        if not src.exists() or src.suffix.lower() not in FRAME_EXTS:
            raise FileNotFoundError(f'Frame not found: {rel}')

        stem = src.stem
        ext = src.suffix
        if rename_prefix:
            stem = f'{rename_prefix}_{stem}'

        dest = target_dir / f'{stem}{ext}'
        counter = 1
        while dest.exists():
            dest = target_dir / f'{stem}_{counter}{ext}'
            counter += 1

        shutil.copy2(src, dest)
        exported.append(str(dest.relative_to(asset_root)).replace('\\', '/'))

    return exported


def create_frames_zip(frame_paths: list[str]) -> BytesIO:
    buf = BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for rel in frame_paths:
            src = resolve_workspace_path(rel)
            if src.exists():
                zf.write(src, arcname=src.name)
    buf.seek(0)
    return buf


def delete_frames(video_id: str, frame_paths: list[str]) -> int:
    """删除工作区内的截帧文件，返回成功删除数量。"""
    prefix = f'frames/{video_id}/'
    deleted = 0
    batch_dirs: set[Path] = set()

    for rel in frame_paths:
        rel_norm = rel.replace('\\', '/').lstrip('/')
        if not rel_norm.startswith(prefix):
            continue
        try:
            src = resolve_workspace_path(rel_norm)
        except ValueError:
            continue
        if not src.exists() or not src.is_file() or src.suffix.lower() not in FRAME_EXTS:
            continue

        thumb_name = hashlib.md5(rel_norm.encode()).hexdigest() + '.jpg'
        thumb_path = FRAME_THUMBS_DIR / thumb_name
        if thumb_path.exists():
            thumb_path.unlink()

        src.unlink()
        batch_dirs.add(src.parent)
        deleted += 1

    for batch_dir in batch_dirs:
        if batch_dir.exists() and batch_dir.is_dir():
            try:
                next(batch_dir.iterdir())
            except StopIteration:
                batch_dir.rmdir()

    frames_dir = FRAMES_DIR / video_id
    if frames_dir.exists() and frames_dir.is_dir():
        try:
            next(frames_dir.iterdir())
        except StopIteration:
            frames_dir.rmdir()

    return deleted


def delete_video(video_id: str) -> None:
    meta_path = _meta_path(video_id)
    video_dir = _video_dir(video_id)
    frames_dir = FRAMES_DIR / video_id

    if meta_path.exists():
        meta_path.unlink()
    if video_dir.exists():
        shutil.rmtree(video_dir, ignore_errors=True)
    if frames_dir.exists():
        shutil.rmtree(frames_dir, ignore_errors=True)


def cleanup_stale_workspace() -> int:
    """删除超过 TTL 天未访问的视频任务。返回删除数量。"""
    if WORKSPACE_TTL_DAYS <= 0:
        return 0
    ensure_workspace()
    cutoff = int(time.time() * 1000) - WORKSPACE_TTL_DAYS * 86400 * 1000
    removed = 0
    for meta_file in META_DIR.glob('*.json'):
        try:
            with meta_file.open('r', encoding='utf-8') as f:
                meta = json.load(f)
            last = int(meta.get('last_access_at') or meta.get('updated_at') or meta.get('created_at') or 0)
            if last < cutoff:
                delete_video(meta_file.stem)
                removed += 1
        except (json.JSONDecodeError, OSError):
            continue
    return removed
