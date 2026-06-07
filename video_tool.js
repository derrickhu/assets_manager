/* 视频截帧工具 */

let vtCurrentVideoId = null;
let vtCurrentDurationMs = 0;
let vtMaxExtractFrames = 500;
let vtFrames = [];
let vtSelectedPaths = new Set();
let vtFfmpegOk = true;
let vtRembgOk = false;
let vtLastBatchId = null;
let vtStage = 'raw';
let vtLatestBatches = { raw: null, matte: null, align: null };
let vtBatchMeta = null;
let vtAlignEditorIdx = 0;
let vtAlignAdjustments = {};
let vtAlignPlayTimer = null;
let vtAlignPreviewTimer = null;
let vtAlignPreviewSeq = 0;
let vtActiveJobPoll = null;

function vtEsc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function vtFormatMs(ms) {
    if (!Number.isFinite(ms)) return '0:00.000';
    const total = Math.max(0, Math.floor(ms));
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const milli = total % 1000;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

function vtParseTimeInput(str) {
    str = (str || '').trim();
    if (!str) return 0;
    if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
    const parts = str.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
    return 0;
}

async function initVideoTool() {
    setupVideoToolEvents();
    const savedModel = localStorage.getItem('vt-matte-model');
    if (savedModel) {
        const sel = document.getElementById('vt-matte-model');
        if (sel) sel.value = savedModel;
    }
    await vtLoadStatus();
    vtUpdateQuickExtractEstimate();
    await vtLoadVideoList();
}

async function vtLoadStatus() {
    const ffmpegBanner = document.getElementById('vt-ffmpeg-banner');
    const rembgBanner = document.getElementById('vt-rembg-banner');
    try {
        const resp = await fetch('/api/video/status', { cache: 'no-store' });
        const data = await resp.json();
        vtFfmpegOk = !!data.ffmpeg?.available;
        vtRembgOk = !!data.rembg?.available;
        if (data.max_extract_frames) vtMaxExtractFrames = data.max_extract_frames;
        if (ffmpegBanner) ffmpegBanner.style.display = vtFfmpegOk ? 'none' : 'block';
        if (rembgBanner) rembgBanner.style.display = vtRembgOk ? 'none' : 'block';
        vtUpdatePostProcessActions();
        return vtFfmpegOk;
    } catch (_) {
        vtFfmpegOk = false;
        vtRembgOk = false;
        if (ffmpegBanner) ffmpegBanner.style.display = 'block';
        if (rembgBanner) rembgBanner.style.display = 'block';
        return false;
    }
}

async function vtLoadVideoList() {
    const listEl = document.getElementById('vt-video-list');
    if (!listEl) return;
    try {
        const resp = await fetch('/api/video/list');
        const data = await resp.json();
        const videos = data.videos || [];
        if (videos.length === 0) {
            listEl.innerHTML = '<div class="vt-empty-hint">暂无视频任务</div>';
            return;
        }
        listEl.innerHTML = videos.map((v) => `
            <div class="vt-video-item ${v.video_id === vtCurrentVideoId ? 'active' : ''}"
                 data-id="${v.video_id}" onclick="vtSelectVideo('${v.video_id}')">
                <div class="vt-video-item-name">${vtEsc(v.original_name || v.filename)}</div>
                <div class="vt-video-item-meta">${vtFormatMs(v.duration_ms)} · ${formatSize(v.size || 0)}</div>
            </div>
        `).join('');
    } catch (err) {
        listEl.innerHTML = `<div class="vt-empty-hint">加载失败: ${vtEsc(String(err))}</div>`;
    }
}

async function vtSelectVideo(videoId) {
    vtCurrentVideoId = videoId;
    vtSelectedPaths.clear();
    vtLastBatchId = null;
    vtStage = 'raw';
    vtLatestBatches = { raw: null, matte: null, align: null };
    vtBatchMeta = null;
    vtUpdateStageTabs();

    await vtLoadVideoList();

    const player = document.getElementById('vt-player');
    const metaEl = document.getElementById('vt-video-meta');
    if (!player) return;

    player.src = `/api/video/${videoId}/stream`;
    player.load();

    try {
        const resp = await fetch(`/api/video/${videoId}/meta`);
        const meta = await resp.json();
        const dur = meta.duration_ms || 0;
        vtCurrentDurationMs = dur;
        document.getElementById('vt-slider').max = dur;
        document.getElementById('vt-slider').value = 0;
        document.getElementById('vt-time-input').value = '0';
        document.getElementById('vt-time-display').textContent = `0 / ${vtFormatMs(dur)}`;
        if (metaEl) {
            metaEl.textContent = `${meta.width || '?'}×${meta.height || '?'} · ${meta.fps || '?'} fps · ${vtFormatMs(dur)}`;
        }
    } catch (_) {
        vtCurrentDurationMs = 0;
    }

    vtUpdateQuickExtractEstimate();
    await vtRefreshFrames();
}

function setupVideoToolEvents() {
    const dropzone = document.getElementById('vt-dropzone');
    const input = document.getElementById('vt-file-input');
    const player = document.getElementById('vt-player');
    const slider = document.getElementById('vt-slider');

    if (dropzone && input) {
        dropzone.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => {
            if (e.target.files?.[0]) vtUploadVideo(e.target.files[0]);
            input.value = '';
        });
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files?.[0]) vtUploadVideo(e.dataTransfer.files[0]);
        });
    }

    if (player && slider) {
        player.addEventListener('timeupdate', () => {
            if (player.duration && !slider.matches(':active')) {
                slider.value = Math.round(player.currentTime * 1000);
                document.getElementById('vt-time-display').textContent =
                    `${vtFormatMs(slider.value)} / ${vtFormatMs(slider.max)}`;
                document.getElementById('vt-time-input').value = String(Math.round(player.currentTime * 1000) / 1000);
            }
        });
        slider.addEventListener('input', () => {
            const ms = Number(slider.value);
            player.currentTime = ms / 1000;
            document.getElementById('vt-time-display').textContent =
                `${vtFormatMs(ms)} / ${vtFormatMs(slider.max)}`;
            document.getElementById('vt-time-input').value = String(ms / 1000);
        });
    }

    document.getElementById('vt-mode')?.addEventListener('change', vtUpdateModeFields);
    vtUpdateModeFields();

    document.getElementById('vt-quick-interval')?.addEventListener('input', vtUpdateQuickExtractEstimate);
    document.querySelectorAll('.vt-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = document.getElementById('vt-quick-interval');
            if (input) input.value = btn.dataset.sec || '1';
            vtUpdateQuickExtractEstimate();
        });
    });

    document.getElementById('vt-align-onion')?.addEventListener('change', () => {
        if (document.getElementById('vt-align-editor')?.classList.contains('active')) {
            vtRenderAlignEditor();
        }
    });

    ['vt-align-scale', 'vt-align-offset-x', 'vt-align-offset-y'].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', vtOnAlignSliderInput);
    });
}

function vtOnAlignSliderInput() {
    vtApplyAlignEditorSlidersToCurrent();
}

function vtUpdateModeFields() {
    const mode = document.getElementById('vt-mode')?.value || 'single';
    document.querySelectorAll('[data-vt-mode]').forEach((el) => {
        el.style.display = el.dataset.vtMode === mode ? 'block' : 'none';
    });
}

function vtEstimateFrameCount(intervalSec, durationMs = vtCurrentDurationMs) {
    if (!durationMs || durationMs <= 0) return 0;
    const step = Math.max(1, Math.round(parseFloat(intervalSec || 1) * 1000));
    let count = 0;
    for (let cur = 0; cur <= durationMs; cur += step) count += 1;
    return count;
}

function vtUpdateQuickExtractEstimate() {
    const estimateEl = document.getElementById('vt-quick-estimate');
    const btn = document.getElementById('vt-quick-extract-btn');
    const interval = parseFloat(document.getElementById('vt-quick-interval')?.value || '1');

    if (!vtCurrentVideoId || !vtCurrentDurationMs) {
        if (estimateEl) estimateEl.textContent = '请先选择或上传视频';
        if (btn) btn.disabled = true;
        return;
    }

    const count = vtEstimateFrameCount(interval, vtCurrentDurationMs);
    const durText = vtFormatMs(vtCurrentDurationMs);
    if (count > vtMaxExtractFrames) {
        if (estimateEl) {
            estimateEl.innerHTML = `<span class="vt-estimate-warn">预计 ${count} 帧，超过上限 ${vtMaxExtractFrames}</span><br>视频 ${durText} · 请增大间隔`;
        }
        if (btn) btn.disabled = true;
        return;
    }

    if (estimateEl) {
        estimateEl.innerHTML = `预计约 <strong>${count}</strong> 帧 · 视频时长 ${durText}`;
    }
    if (btn) btn.disabled = !vtFfmpegOk || count === 0;
}

function vtGetCurrentMs() {
    const player = document.getElementById('vt-player');
    const slider = document.getElementById('vt-slider');
    if (player && !Number.isNaN(player.currentTime)) return Math.round(player.currentTime * 1000);
    return Number(slider?.value || 0);
}

function vtSeekToInput() {
    const ms = vtParseTimeInput(document.getElementById('vt-time-input')?.value);
    const slider = document.getElementById('vt-slider');
    const player = document.getElementById('vt-player');
    if (slider) slider.value = ms;
    if (player) player.currentTime = ms / 1000;
    document.getElementById('vt-time-display').textContent =
        `${vtFormatMs(ms)} / ${vtFormatMs(slider?.max || 0)}`;
}

async function vtUploadVideo(file) {
    const status = document.getElementById('vt-upload-status');
    if (status) status.textContent = '上传中...';
    const form = new FormData();
    form.append('file', file);
    try {
        const resp = await fetch('/api/video/upload', { method: 'POST', body: form });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '上传失败');
        if (status) status.textContent = '上传成功';
        await vtLoadVideoList();
        await vtSelectVideo(data.video.video_id);
    } catch (err) {
        if (status) status.textContent = `失败: ${err.message}`;
        showGitResult('❌ 视频上传失败', 'error', err.message);
    }
}

async function vtExtractFrames() {
    if (!vtCurrentVideoId) {
        showGitResult('请先选择或上传视频', 'error');
        return;
    }
    await vtLoadStatus();
    if (!vtFfmpegOk) {
        showGitResult('ffmpeg 未就绪', 'error', '请执行: brew install ffmpeg && cd asset_manager && ./service.sh install');
        return;
    }

    const mode = document.getElementById('vt-mode')?.value || 'single';
    const fmt = document.getElementById('vt-format')?.value || 'png';
    const prefix = document.getElementById('vt-prefix')?.value || '';
    const body = { mode, format: fmt, prefix };

    if (mode === 'single') {
        body.timestamp_ms = vtGetCurrentMs();
    } else if (mode === 'interval') {
        body.interval_sec = parseFloat(document.getElementById('vt-interval')?.value || '1');
        body.start_ms = vtParseTimeInput(document.getElementById('vt-start')?.value);
        const endVal = document.getElementById('vt-end')?.value?.trim();
        if (endVal) body.end_ms = vtParseTimeInput(endVal);
    } else if (mode === 'count') {
        body.count = parseInt(document.getElementById('vt-count')?.value || '10', 10);
        body.start_ms = vtParseTimeInput(document.getElementById('vt-start-count')?.value);
    } else if (mode === 'timestamps') {
        const raw = document.getElementById('vt-timestamps')?.value || '';
        body.timestamps_ms = raw.split(/[\s,;]+/)
            .filter(Boolean)
            .map((s) => vtParseTimeInput(s));
    }

    const btn = document.getElementById('vt-extract-btn');
    if (btn) { btn.disabled = true; btn.textContent = '生成中...'; }

    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '截帧失败');
        vtLastBatchId = data.batch_id;
        vtStage = 'raw';
        vtUpdateStageTabs();
        showGitResult('✅ 截帧完成', 'success', `生成 ${data.count} 帧`);
        await vtRefreshFrames();
    } catch (err) {
        showGitResult('❌ 截帧失败', 'error', err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '生成帧'; }
    }
}

async function vtQuickExtractAll() {
    if (!vtCurrentVideoId) {
        showGitResult('请先选择或上传视频', 'error');
        return;
    }
    await vtLoadStatus();
    if (!vtFfmpegOk) {
        showGitResult('ffmpeg 未就绪', 'error', '请执行: brew install ffmpeg && cd asset_manager && ./service.sh install');
        return;
    }

    const intervalSec = parseFloat(document.getElementById('vt-quick-interval')?.value || '1');
    const fmt = document.getElementById('vt-quick-format')?.value || 'png';
    const count = vtEstimateFrameCount(intervalSec, vtCurrentDurationMs);
    if (count > vtMaxExtractFrames) {
        showGitResult('间隔过小', 'error', `预计 ${count} 帧，超过上限 ${vtMaxExtractFrames}，请增大间隔`);
        return;
    }
    if (count === 0) {
        showGitResult('无法截帧', 'error', '视频时长无效');
        return;
    }

    const btn = document.getElementById('vt-quick-extract-btn');
    if (btn) { btn.disabled = true; btn.textContent = `截帧中 (0/${count})...`; }

    const body = {
        mode: 'interval',
        format: fmt,
        interval_sec: intervalSec,
        start_ms: 0,
    };

    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '截帧失败');
        vtLastBatchId = data.batch_id;
        vtStage = 'raw';
        vtUpdateStageTabs();
        vtSelectedPaths.clear();
        showGitResult('✅ 全片截帧完成', 'success', `共 ${data.count} 帧，请在下方挑选`);
        await vtRefreshFrames();
        document.querySelector('.vt-frames-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        showGitResult('❌ 截帧失败', 'error', err.message);
    } finally {
        if (btn) {
            btn.textContent = '一键全片截帧';
            vtUpdateQuickExtractEstimate();
        }
    }
}

async function vtRefreshFrames() {
    if (!vtCurrentVideoId) {
        vtFrames = [];
        vtBatchMeta = null;
        vtRenderFrameGrid();
        return;
    }
    const prefix = { raw: 'batch_', matte: 'matte_', align: 'align_' }[vtStage] || 'batch_';
    let batchId = vtLastBatchId;
    if (!batchId || !batchId.startsWith(prefix)) {
        batchId = vtLatestBatches[vtStage] || null;
        vtLastBatchId = batchId;
    }
    const params = new URLSearchParams();
    if (batchId) params.set('batch_id', batchId);
    else params.set('stage', vtStage);
    const url = `/api/video/${vtCurrentVideoId}/frames?${params.toString()}`;
    try {
        const resp = await fetch(url);
        const data = await resp.json();
        vtFrames = data.frames || [];
        vtLatestBatches = { ...vtLatestBatches, ...(data.latest_batches || {}) };
        vtBatchMeta = data.batch_meta || null;
        if (!vtLastBatchId && vtLatestBatches[vtStage]) {
            vtLastBatchId = vtLatestBatches[vtStage];
        }
        vtUpdatePostProcessActions();
        vtRenderFrameGrid();
    } catch (_) {
        vtFrames = [];
        vtRenderFrameGrid();
    }
}

function vtStagePrefix(stage) {
    return { raw: 'batch_', matte: 'matte_', align: 'align_' }[stage] || 'batch_';
}

function vtUpdateStageTabs() {
    document.querySelectorAll('.vt-stage-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.stage === vtStage);
    });
}

function vtSwitchStage(stage) {
    if (vtStage === stage) return;
    vtStage = stage;
    vtSelectedPaths.clear();
    const prefix = vtStagePrefix(stage);
    if (vtLastBatchId && !vtLastBatchId.startsWith(prefix)) {
        vtLastBatchId = vtLatestBatches[stage] || null;
    }
    vtUpdateStageTabs();
    vtRefreshFrames();
}

function vtUpdatePostProcessActions() {
    const n = vtSelectedPaths.size;
    const matteBtn = document.getElementById('vt-matte-btn');
    const alignBtn = document.getElementById('vt-align-btn');
    const editorBtn = document.getElementById('vt-align-editor-btn');
    if (matteBtn) matteBtn.disabled = n === 0 || !vtRembgOk || !vtCurrentVideoId;
    if (alignBtn) alignBtn.disabled = n === 0 || !vtCurrentVideoId;
    const canEdit = vtStage === 'align' && vtLastBatchId && vtFrames.length > 0;
    if (editorBtn) editorBtn.disabled = !canEdit;
}

function vtSetJobProgress(kind, done, total) {
    const wrap = document.getElementById(`${kind}-progress`);
    const fill = document.getElementById(`${kind}-fill`);
    const text = document.getElementById(`${kind}-progress-text`);
    if (!wrap) return;
    if (total <= 0) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'flex';
    const pct = Math.round((done / total) * 100);
    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${done} / ${total}`;
}

function vtSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function vtPollJob(jobId, kind) {
    while (true) {
        const resp = await fetch(`/api/video/jobs/${jobId}`);
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Job 查询失败');
        vtSetJobProgress(kind, data.progress || 0, data.total || 0);
        if (data.status === 'done') return data;
        if (data.status === 'error') throw new Error(data.error || '任务失败');
        await vtSleep(1000);
    }
}

async function vtMatteSelected() {
    const paths = Array.from(vtSelectedPaths);
    if (!paths.length || !vtCurrentVideoId) return;
    await vtLoadStatus();
    if (!vtRembgOk) {
        showGitResult('rembg 未就绪', 'error', 'pip3 install rembg onnxruntime');
        return;
    }
    const model = document.getElementById('vt-matte-model')?.value || 'birefnet-general';
    localStorage.setItem('vt-matte-model', model);
    const btn = document.getElementById('vt-matte-btn');
    if (btn) { btn.disabled = true; btn.textContent = '抠图中...'; }
    vtSetJobProgress('vt-matte', 0, paths.length);
    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/matte`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame_paths: paths, model }),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '抠图失败');
        const result = await vtPollJob(data.job_id, 'vt-matte');
        vtStage = 'matte';
        vtLastBatchId = result.batch_id;
        vtSelectedPaths.clear();
        vtUpdateStageTabs();
        showGitResult('✅ 抠图完成', 'success', `共 ${result.progress} 张`);
        await vtRefreshFrames();
        document.querySelector('.vt-frames-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        showGitResult('❌ 抠图失败', 'error', err.message);
    } finally {
        vtSetJobProgress('vt-matte', 0, 0);
        if (btn) { btn.textContent = '批量抠图选中'; vtUpdatePostProcessActions(); }
    }
}

async function vtAlignSelected() {
    const paths = Array.from(vtSelectedPaths);
    if (!paths.length || !vtCurrentVideoId) return;
    const canvasW = parseInt(document.getElementById('vt-align-canvas-w')?.value || '512', 10);
    const canvasH = parseInt(document.getElementById('vt-align-canvas-h')?.value || '512', 10);
    const bottomPad = parseInt(document.getElementById('vt-align-bottom-pad')?.value || '8', 10);
    const btn = document.getElementById('vt-align-btn');
    if (btn) { btn.disabled = true; btn.textContent = '对齐中...'; }
    vtSetJobProgress('vt-align', 0, paths.length);
    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/align`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                frame_paths: paths,
                canvas_w: canvasW,
                canvas_h: canvasH,
                bottom_pad: bottomPad,
            }),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '对齐失败');
        const result = await vtPollJob(data.job_id, 'vt-align');
        vtStage = 'align';
        vtLastBatchId = result.batch_id;
        vtSelectedPaths.clear();
        vtUpdateStageTabs();
        showGitResult('✅ 对齐完成', 'success', `共 ${result.progress} 张`);
        await vtRefreshFrames();
        document.querySelector('.vt-frames-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        showGitResult('❌ 对齐失败', 'error', err.message);
    } finally {
        vtSetJobProgress('vt-align', 0, 0);
        if (btn) { btn.textContent = '自动对齐选中'; vtUpdatePostProcessActions(); }
    }
}

function vtOpenAlignEditor() {
    if (vtStage !== 'align' || !vtLastBatchId || !vtFrames.length) {
        showGitResult('请先完成自动对齐', 'error');
        return;
    }
    vtAlignAdjustments = {};
    vtFrames.forEach((f) => {
        const m = f.align_meta || {};
        vtAlignAdjustments[f.filename] = {
            scale_mul: m.scale_mul ?? 1,
            offset_x: m.offset_x ?? 0,
            offset_y: m.offset_y ?? 0,
        };
    });
    vtAlignEditorIdx = 0;
    document.getElementById('vt-align-editor')?.classList.add('active');
    vtRenderAlignEditor();
}

function vtCloseAlignEditor() {
    vtAlignEditorStopPlay();
    vtRevokeAlignPreviewUrl();
    if (vtAlignPreviewTimer) {
        clearTimeout(vtAlignPreviewTimer);
        vtAlignPreviewTimer = null;
    }
    document.getElementById('vt-align-editor')?.classList.remove('active');
}

function vtRevokeAlignPreviewUrl() {
    const preview = document.getElementById('vt-align-preview');
    if (preview?._previewUrl) {
        URL.revokeObjectURL(preview._previewUrl);
        preview._previewUrl = null;
    }
}

function vtGetAlignSourcePath(frame) {
    return frame?.source_path || frame?.path;
}

function vtScheduleAlignPreview() {
    if (vtAlignPreviewTimer) clearTimeout(vtAlignPreviewTimer);
    vtAlignPreviewTimer = setTimeout(() => vtUpdateAlignPreviewImage(), 60);
}

async function vtUpdateAlignPreviewImage() {
    const f = vtFrames[vtAlignEditorIdx];
    const preview = document.getElementById('vt-align-preview');
    if (!f || !preview || !vtCurrentVideoId || !vtLastBatchId) return;

    const adj = vtAlignAdjustments[f.filename] || { scale_mul: 1, offset_x: 0, offset_y: 0 };
    const sourcePath = vtGetAlignSourcePath(f);
    const seq = ++vtAlignPreviewSeq;
    preview.classList.add('vt-preview-loading');

    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/align-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batch_id: vtLastBatchId,
                source_path: sourcePath,
                scale_mul: adj.scale_mul,
                offset_x: adj.offset_x,
                offset_y: adj.offset_y,
            }),
        });
        if (!resp.ok || seq !== vtAlignPreviewSeq) return;
        const blob = await resp.blob();
        if (seq !== vtAlignPreviewSeq) return;
        vtRevokeAlignPreviewUrl();
        preview._previewUrl = URL.createObjectURL(blob);
        preview.src = preview._previewUrl;
    } catch (_) {
        /* keep last preview */
    } finally {
        if (seq === vtAlignPreviewSeq) preview.classList.remove('vt-preview-loading');
    }
}

function vtApplyAlignEditorSlidersToCurrent() {
    const f = vtFrames[vtAlignEditorIdx];
    if (!f) return;
    const scale = parseFloat(document.getElementById('vt-align-scale')?.value || '1');
    const offsetX = parseInt(document.getElementById('vt-align-offset-x')?.value || '0', 10);
    const offsetY = parseInt(document.getElementById('vt-align-offset-y')?.value || '0', 10);
    vtAlignAdjustments[f.filename] = { scale_mul: scale, offset_x: offsetX, offset_y: offsetY };
    document.getElementById('vt-align-scale-val').textContent = scale.toFixed(2);
    document.getElementById('vt-align-offset-x-val').textContent = String(offsetX);
    document.getElementById('vt-align-offset-y-val').textContent = String(offsetY);
    vtScheduleAlignPreview();
}

function vtRenderAlignEditor() {
    const f = vtFrames[vtAlignEditorIdx];
    if (!f) return;
    const preview = document.getElementById('vt-align-preview');
    const ghost = document.getElementById('vt-align-ghost');
    const label = document.getElementById('vt-align-frame-label');
    if (label) label.textContent = `${vtAlignEditorIdx + 1} / ${vtFrames.length} · ${f.filename}`;

    const adj = vtAlignAdjustments[f.filename] || { scale_mul: 1, offset_x: 0, offset_y: 0 };
    document.getElementById('vt-align-scale').value = adj.scale_mul;
    document.getElementById('vt-align-offset-x').value = adj.offset_x;
    document.getElementById('vt-align-offset-y').value = adj.offset_y;
    document.getElementById('vt-align-scale-val').textContent = Number(adj.scale_mul).toFixed(2);
    document.getElementById('vt-align-offset-x-val').textContent = String(adj.offset_x);
    document.getElementById('vt-align-offset-y-val').textContent = String(adj.offset_y);

    vtScheduleAlignPreview();

    const showGhost = document.getElementById('vt-align-onion')?.checked;
    if (ghost) {
        if (showGhost && vtAlignEditorIdx > 0) {
            const prev = vtFrames[vtAlignEditorIdx - 1];
            ghost.src = vtFrameUrl(prev.path, false);
            ghost.style.display = 'block';
        } else {
            ghost.style.display = 'none';
        }
    }
}

function vtAlignEditorPrev() {
    if (vtAlignEditorIdx > 0) {
        vtApplyAlignEditorSlidersToCurrent();
        vtAlignEditorIdx -= 1;
        vtRenderAlignEditor();
    }
}

function vtAlignEditorNext() {
    if (vtAlignEditorIdx < vtFrames.length - 1) {
        vtApplyAlignEditorSlidersToCurrent();
        vtAlignEditorIdx += 1;
        vtRenderAlignEditor();
    }
}

function vtAlignEditorCopyRef() {
    vtApplyAlignEditorSlidersToCurrent();
    const ref = vtAlignAdjustments[vtFrames[vtAlignEditorIdx].filename];
    vtFrames.forEach((f) => {
        vtAlignAdjustments[f.filename] = { ...ref };
    });
    showGitResult('已复制', 'success', '当前帧参数已应用到全部');
}

function vtAlignEditorStopPlay() {
    if (vtAlignPlayTimer) {
        clearInterval(vtAlignPlayTimer);
        vtAlignPlayTimer = null;
    }
    const btn = document.getElementById('vt-align-play-btn');
    if (btn) btn.textContent = '▶ 预览动画';
}

function vtAlignEditorTogglePlay() {
    if (vtAlignPlayTimer) {
        vtAlignEditorStopPlay();
        return;
    }
    const btn = document.getElementById('vt-align-play-btn');
    if (btn) btn.textContent = '⏸ 停止预览';
    vtAlignPlayTimer = setInterval(() => {
        if (vtAlignEditorIdx >= vtFrames.length - 1) vtAlignEditorIdx = 0;
        else vtAlignEditorIdx += 1;
        vtRenderAlignEditor();
    }, 300);
}

async function vtAlignEditorSave() {
    if (!vtCurrentVideoId || !vtLastBatchId) return;
    vtApplyAlignEditorSlidersToCurrent();
    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/align-adjust`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                batch_id: vtLastBatchId,
                adjustments: vtAlignAdjustments,
            }),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '保存失败');
        showGitResult('✅ 已保存', 'success', `更新 ${data.updated} 帧`);
        vtCloseAlignEditor();
        await vtRefreshFrames();
    } catch (err) {
        showGitResult('❌ 保存失败', 'error', err.message);
    }
}

function vtFrameUrl(relPath, thumb, download) {
    const q = [];
    if (thumb) q.push('thumb=1');
    if (download) q.push('download=1');
    const qs = q.length ? `?${q.join('&')}` : '';
    return `/api/video/frame/${relPath.split('/').map(encodeURIComponent).join('/')}${qs}`;
}

function vtPreviewFrame(frame) {
    if (!frame) return;
    if (typeof currentPreviewPath !== 'undefined') currentPreviewPath = frame.path;
    const modal = document.getElementById('image-modal');
    if (!modal) return;
    document.getElementById('modal-image').src = vtFrameUrl(frame.path, false);
    document.getElementById('modal-title').textContent = frame.filename || '截帧预览';
    document.getElementById('modal-path').textContent = frame.path || '';
    document.getElementById('modal-size').textContent = frame.size ? formatSize(frame.size) : '';
    const dl = document.getElementById('modal-download');
    if (dl) {
        dl.href = vtFrameUrl(frame.path, false, true);
        dl.download = frame.filename || 'frame.png';
    }
    modal.classList.add('active');
}

function vtRenderFrameGrid() {
    const grid = document.getElementById('vt-frame-grid');
    const countEl = document.getElementById('vt-frame-count');
    if (countEl) countEl.textContent = String(vtFrames.length);
    if (!grid) return;

    if (vtFrames.length === 0) {
        grid.innerHTML = '<div class="vt-empty-hint">暂无截帧，请先生成</div>';
        vtUpdateFrameActions();
        return;
    }

    grid.innerHTML = vtFrames.map((f, idx) => `
        <div class="vt-frame-card ${vtSelectedPaths.has(f.path) ? 'selected' : ''}" data-idx="${idx}">
            <input type="checkbox" class="vt-frame-cb" ${vtSelectedPaths.has(f.path) ? 'checked' : ''} title="选择" />
            <img src="${vtFrameUrl(f.path, true)}" alt="" loading="lazy" title="点击查看大图" />
            <div class="vt-frame-label">${vtEsc(f.filename)}</div>
            <div class="vt-frame-ts">${f.timestamp_ms != null ? vtFormatMs(f.timestamp_ms) : ''}</div>
            <button type="button" class="vt-frame-del" title="删除此帧">✕</button>
            <button type="button" class="vt-frame-dl" title="下载此帧">⬇</button>
        </div>
    `).join('');

    grid.querySelectorAll('.vt-frame-card').forEach((card) => {
        const idx = Number(card.dataset.idx);
        const f = vtFrames[idx];
        const cb = card.querySelector('input[type="checkbox"]');
        cb?.addEventListener('change', () => vtToggleFrame(f.path, cb.checked));
        card.querySelector('.vt-frame-dl')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            vtDownloadOne(f.path, f.filename);
        });
        card.querySelector('.vt-frame-del')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            vtDeleteOne(f.path);
        });
        card.addEventListener('click', (e) => {
            if (e.target.closest('input[type="checkbox"], button')) return;
            vtPreviewFrame(f);
        });
    });

    vtUpdateFrameActions();
}

function vtToggleFrame(path, checked) {
    if (checked) vtSelectedPaths.add(path);
    else vtSelectedPaths.delete(path);
    vtRenderFrameGrid();
}

function vtSelectAllFrames(checked) {
    vtSelectedPaths.clear();
    if (checked) vtFrames.forEach((f) => vtSelectedPaths.add(f.path));
    vtRenderFrameGrid();
}

function vtUpdateFrameActions() {
    const n = vtSelectedPaths.size;
    const selCount = document.getElementById('vt-selected-count');
    if (selCount) selCount.textContent = String(n);
    const dlBtn = document.getElementById('vt-download-btn');
    if (dlBtn) {
        dlBtn.disabled = n === 0;
        dlBtn.textContent = n <= 1 ? '下载到本地' : `下载到本地 (${n} 张 ZIP)`;
    }
    const delBtn = document.getElementById('vt-delete-frames-btn');
    if (delBtn) {
        delBtn.disabled = n === 0;
        delBtn.textContent = n <= 1 ? '删除' : `删除 (${n})`;
    }
    vtUpdatePostProcessActions();
}

function vtDownloadOne(path, filename) {
    const frame = vtFrames.find((f) => f.path === path);
    const name = filename || frame?.filename || 'frame.png';
    const a = document.createElement('a');
    a.href = vtFrameUrl(path, false, true);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function vtDownloadToLocal() {
    const paths = Array.from(vtSelectedPaths);
    if (!paths.length || !vtCurrentVideoId) return;
    if (paths.length === 1) {
        const f = vtFrames.find((x) => x.path === paths[0]);
        vtDownloadOne(paths[0], f?.filename);
        return;
    }
    await vtDownloadZip(paths);
}

async function vtDownloadZip(paths) {
    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/download-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame_paths: paths }),
        });
        if (!resp.ok) throw new Error('下载失败');
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${vtCurrentVideoId}_frames.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
        showGitResult('✅ 已开始下载', 'success', `${paths.length} 张图片已打包`);
    } catch (err) {
        showGitResult('❌ 下载失败', 'error', err.message);
    }
}

async function vtDeleteFrames(paths) {
    if (!paths.length || !vtCurrentVideoId) return;
    try {
        const resp = await fetch(`/api/video/${vtCurrentVideoId}/delete-frames`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame_paths: paths }),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '删除失败');
        paths.forEach((p) => vtSelectedPaths.delete(p));
        await vtRefreshFrames();
        showGitResult('✅ 已删除', 'success', `${data.deleted} 张截帧`);
    } catch (err) {
        showGitResult('❌ 删除失败', 'error', err.message);
    }
}

function vtDeleteOne(path) {
    if (!confirm('确定删除此截帧？')) return;
    vtDeleteFrames([path]);
}

async function vtDeleteSelectedFrames() {
    const paths = Array.from(vtSelectedPaths);
    if (!paths.length) return;
    const msg = paths.length === 1 ? '确定删除选中的 1 张截帧？' : `确定删除选中的 ${paths.length} 张截帧？`;
    if (!confirm(msg)) return;
    await vtDeleteFrames(paths);
}

async function vtDeleteCurrentVideo() {
    if (!vtCurrentVideoId) return;
    if (!confirm('确定删除该视频及所有截帧？')) return;
    try {
        await fetch(`/api/video/${vtCurrentVideoId}`, { method: 'DELETE' });
        vtCurrentVideoId = null;
        vtCurrentDurationMs = 0;
        vtFrames = [];
        vtSelectedPaths.clear();
        document.getElementById('vt-player').src = '';
        vtUpdateQuickExtractEstimate();
        await vtLoadVideoList();
        vtRenderFrameGrid();
        showGitResult('✅ 已删除', 'success');
    } catch (err) {
        showGitResult('❌ 删除失败', 'error', err.message);
    }
}

function vtCaptureCurrentFrame() {
    document.getElementById('vt-mode').value = 'single';
    vtUpdateModeFields();
    vtExtractFrames();
}
