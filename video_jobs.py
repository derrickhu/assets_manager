"""异步 Job 管理（抠图 / 对齐等耗时任务）。"""

from __future__ import annotations

import threading
import uuid
from typing import Any, Callable

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def create_job(video_id: str, job_type: str, total: int) -> str:
    job_id = uuid.uuid4().hex[:16]
    with _lock:
        _jobs[job_id] = {
            'job_id': job_id,
            'video_id': video_id,
            'type': job_type,
            'status': 'pending',
            'progress': 0,
            'total': total,
            'error': None,
            'batch_id': None,
            'message': '',
        }
    return job_id


def get_job(job_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def update_job(job_id: str, **kwargs: Any) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)


def run_job_async(job_id: str, fn: Callable[[str], None]) -> None:
    def worker() -> None:
        try:
            update_job(job_id, status='running')
            fn(job_id)
            job = get_job(job_id)
            if job and job.get('status') != 'error':
                update_job(job_id, status='done')
        except Exception as exc:
            update_job(job_id, status='error', error=str(exc))

    threading.Thread(target=worker, daemon=True).start()
