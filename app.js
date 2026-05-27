/* ═══════════════════════════════════════
   游戏资产管理中心 - 前端逻辑
   通过 Flask API 获取真实文件数据
   ═══════════════════════════════════════ */

// ─── 状态 ───
let allAssets = [];
let games = [];
let currentFilter = 'all';   // all | image | audio
let currentGame = null;       // null = 全部
let currentSubcat = null;     // 子分类
let searchQuery = '';
let currentPage = 1;
let viewMode = 'grid';
let sortBy = 'name';
let selectMode = false;       // 多选模式
let selectedAssets = new Set(); // 选中的资产ID
const PAGE_SIZE = 80;

// ─── 初始化 ───
document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    loadAssets();
    loadServerInfo();
    loadGitInfo();
    // 每 30 秒刷新 Git 状态
    setInterval(loadGitInfo, 30000);
});

// ─── 事件绑定 ───
function initEvents() {
    // 资产分类导航
    document.querySelectorAll('.nav-item[data-filter]').forEach(item => {
        item.addEventListener('click', () => {
            setActiveNav(item, 'filter');
            currentFilter = item.dataset.filter;
            currentGame = null;
            currentSubcat = null;
            currentPage = 1;
            hideSubNav();
            render();
        });
    });

    // 搜索（防抖）
    let debounce;
    document.getElementById('search-input').addEventListener('input', e => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            searchQuery = e.target.value.trim().toLowerCase();
            currentPage = 1;
            render();
        }, 200);
    });

    // 排序
    document.getElementById('sort-select').addEventListener('change', e => {
        sortBy = e.target.value;
        render();
    });

    // 键盘快捷键
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeModal(); closeAudioPlayer(); }
    });
}

// ─── 加载数据 ───
async function loadAssets() {
    try {
        const resp = await fetch('/api/scan');
        const data = await resp.json();
        allAssets = data.assets;
        games = data.games;
        updateStats(data.stats);
        buildGameNav();
        render();
    } catch (err) {
        console.error('加载失败:', err);
        document.getElementById('assets-grid').innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">❌</div>
                <div class="empty-text">无法连接服务器，请确保后端正在运行</div>
            </div>`;
    }
}

async function loadServerInfo() {
    try {
        const resp = await fetch('/api/info');
        const info = await resp.json();
        document.getElementById('server-url').textContent = info.url;
    } catch (e) {
        document.getElementById('server-url').textContent = window.location.origin;
    }
}

// ─── 构建游戏导航 ───
function buildGameNav() {
    const list = document.getElementById('game-nav-list');
    list.innerHTML = games.map(g => `
        <li class="nav-item" data-game="${g.id}">
            <span class="nav-icon">${g.icon}</span>
            <span>${g.name}</span>
            <span class="badge">${g.image_count + g.audio_count}</span>
        </li>
    `).join('');

    list.querySelectorAll('.nav-item[data-game]').forEach(item => {
        item.addEventListener('click', () => {
            setActiveNav(item, 'game');
            currentGame = item.dataset.game;
            currentFilter = 'all';
            currentSubcat = null;
            currentPage = 1;
            buildSubNav(currentGame);
            render();
        });
    });
}

// ─── 构建子分类导航 ───
function buildSubNav(gameId) {
    const game = games.find(g => g.id === gameId);
    const section = document.getElementById('sub-nav-section');
    const list = document.getElementById('sub-nav-list');

    if (!game || !game.subcategories || game.subcategories.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = `
        <li class="nav-item active" data-subcat="all">
            <span class="nav-icon">📂</span>
            <span>全部</span>
        </li>
    ` + game.subcategories.map(sc => `
        <li class="nav-item" data-subcat="${sc}">
            <span class="nav-icon">📄</span>
            <span>${sc}</span>
        </li>
    `).join('');

    list.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            list.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            currentSubcat = item.dataset.subcat === 'all' ? null : item.dataset.subcat;
            currentPage = 1;
            render();
        });
    });
}

function hideSubNav() {
    document.getElementById('sub-nav-section').style.display = 'none';
}

// ─── 导航高亮 ───
function setActiveNav(activeItem, type) {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    activeItem.classList.add('active');
}

// ─── 更新统计 ───
function updateStats(stats) {
    document.getElementById('stat-images').textContent = stats.images.toLocaleString();
    document.getElementById('stat-audio').textContent = stats.audio.toLocaleString();
    document.getElementById('stat-games').textContent = stats.games;
    document.getElementById('stat-total').textContent = stats.total.toLocaleString();

    document.getElementById('total-count').textContent = stats.total;
    document.getElementById('image-count').textContent = stats.images;
    document.getElementById('audio-count').textContent = stats.audio;
}

// ─── 筛选 & 排序 ───
function getFiltered() {
    let list = allAssets;

    if (currentGame) list = list.filter(a => a.game === currentGame);
    if (currentFilter !== 'all') list = list.filter(a => a.type === currentFilter);
    if (currentSubcat) list = list.filter(a => a.subcategory === currentSubcat);
    if (searchQuery) {
        list = list.filter(a =>
            a.name.toLowerCase().includes(searchQuery) ||
            a.path.toLowerCase().includes(searchQuery)
        );
    }

    // 排序
    list.sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'size') return b.size - a.size;
        if (sortBy === 'modified') return b.modified - a.modified;
        return 0;
    });

    return list;
}

// ─── 渲染 ───
function render() {
    const filtered = getFiltered();
    const total = filtered.length;
    const pages = Math.ceil(total / PAGE_SIZE);
    if (currentPage > pages) currentPage = Math.max(1, pages);

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    // 标题
    updateBreadcrumb();
    document.getElementById('section-title-text').textContent = getBreadcrumbTitle();
    document.getElementById('section-count').textContent = `(${total})`;

    // 渲染卡片
    const grid = document.getElementById('assets-grid');
    grid.className = `assets-grid ${viewMode === 'list' ? 'list-view' : ''}`;

    if (total === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📭</div>
                <div class="empty-text">${searchQuery ? '没有找到匹配的资产' : '该分类下没有资产'}</div>
            </div>`;
    } else {
        grid.innerHTML = pageItems.map(a => createCard(a)).join('');
    }

    // 分页
    renderPagination(total, pages);
}

// ─── 资产卡片 ───
function createCard(asset) {
    const gameInfo = games.find(g => g.id === asset.game) || { name: asset.game, icon: '📁' };
    const sizeStr = formatSize(asset.size);

    if (viewMode === 'list') {
        return createListItem(asset, gameInfo, sizeStr);
    }

    const isSelected = selectedAssets.has(asset.id);
    const selectedClass = isSelected ? 'selected' : '';
    const selectModeClass = selectMode ? 'select-mode' : '';
    
    // 多选模式显示复选框，否则显示删除按钮
    const selectControl = selectMode 
        ? `<input type="checkbox" class="asset-checkbox" ${isSelected ? 'checked' : ''} 
            onclick="toggleAssetSelection('${asset.id}', event)">`
        : `<button class="asset-delete-btn" onclick="deleteAsset(event, '${esc(asset.path)}', '${esc(asset.name)}')" title="删除">🗑</button>`;
    
    // 多选模式下点击卡片切换选择，非多选模式下打开预览
    const cardClick = selectMode 
        ? `onclick="toggleAssetSelection('${asset.id}')"`
        : `onclick="previewImage('${esc(asset.path)}', '${esc(asset.name)}', '${sizeStr}')"`;
    
    if (asset.type === 'image') {
        return `
        <div class="asset-card ${selectedClass} ${selectModeClass}" ${cardClick}>
            <div class="asset-preview">
                ${selectControl}
                <img src="/api/thumb/${encPath(asset.path)}" alt="${esc(asset.name)}" loading="lazy"
                     onerror="this.parentElement.innerHTML='<div class=asset-icon>🖼️</div>'" />
                <span class="asset-type-badge">${asset.ext}</span>
                <a class="asset-download-btn" href="/api/download/${encPath(asset.path)}" 
                   onclick="event.stopPropagation()" download>⬇</a>
            </div>
            <div class="asset-info">
                <div class="asset-name" title="${esc(asset.name)}">${esc(asset.name)}</div>
                <div class="asset-meta">
                    <span class="asset-size">${sizeStr}</span>
                    <span class="asset-game-tag">${gameInfo.icon} ${gameInfo.name}</span>
                </div>
            </div>
        </div>`;
    } else {
        const audioClick = selectMode 
            ? `onclick="toggleAssetSelection('${asset.id}')"`
            : `onclick="playAudio('${esc(asset.path)}', '${esc(asset.name)}')"`;
        return `
        <div class="asset-card ${selectedClass} ${selectModeClass}" ${audioClick}>
            <div class="asset-preview audio-preview">
                ${selectControl}
                <div class="asset-icon">🎵</div>
                <span class="asset-type-badge">${asset.ext}</span>
                <a class="asset-download-btn" href="/api/download/${encPath(asset.path)}" 
                   onclick="event.stopPropagation()" download>⬇</a>
            </div>
            <div class="asset-info">
                <div class="asset-name" title="${esc(asset.name)}">${esc(asset.name)}</div>
                <div class="asset-meta">
                    <span class="asset-size">${sizeStr}</span>
                    <span class="asset-game-tag">${gameInfo.icon} ${gameInfo.name}</span>
                </div>
            </div>
        </div>`;
    }
}

function createListItem(asset, gameInfo, sizeStr) {
    const previewHtml = asset.type === 'image'
        ? `<img src="/api/thumb/${encPath(asset.path)}" alt="" loading="lazy" 
               onerror="this.parentElement.innerHTML='<div class=asset-icon>🖼️</div>'" />`
        : '<div class="asset-icon">🎵</div>';

    const clickAction = asset.type === 'image'
        ? `previewImage('${esc(asset.path)}', '${esc(asset.name)}', '${sizeStr}')`
        : `playAudio('${esc(asset.path)}', '${esc(asset.name)}')`;

    return `
    <div class="asset-card" onclick="${clickAction}">
        <div class="asset-preview ${asset.type === 'audio' ? 'audio-preview' : ''}">
            ${previewHtml}
        </div>
        <div class="asset-info">
            <div class="asset-name" title="${esc(asset.name)}">${esc(asset.name)}</div>
            <div class="asset-meta">
                <span class="asset-size">${sizeStr}</span>
                <span>${asset.ext.toUpperCase()}</span>
                <span class="asset-game-tag">${gameInfo.icon} ${gameInfo.name}</span>
                <div class="list-actions">
                    <a class="btn-icon" href="/api/download/${encPath(asset.path)}" 
                       onclick="event.stopPropagation()" download title="下载">⬇</a>
                </div>
            </div>
        </div>
    </div>`;
}

// ─── 分页 ───
function renderPagination(total, pages) {
    const el = document.getElementById('pagination');
    if (pages <= 1) { el.innerHTML = ''; return; }

    let html = `<button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>‹</button>`;

    const range = getPageRange(currentPage, pages);
    for (const p of range) {
        if (p === '...') {
            html += `<span class="page-info">…</span>`;
        } else {
            html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
        }
    }

    html += `<button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage >= pages ? 'disabled' : ''}>›</button>`;
    html += `<span class="page-info">${total} 个资产</span>`;
    el.innerHTML = html;
}

function getPageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [];
    pages.push(1);
    if (current > 3) pages.push('...');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
        pages.push(i);
    }
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
}

function goPage(p) {
    const pages = Math.ceil(getFiltered().length / PAGE_SIZE);
    if (p < 1 || p > pages) return;
    currentPage = p;
    render();
    document.querySelector('.assets-section').scrollIntoView({ behavior: 'smooth' });
}

// ─── 面包屑 ───
function updateBreadcrumb() {
    const el = document.getElementById('breadcrumb');
    const crumbs = [{ label: '全部资产', action: 'resetAll()' }];
    const gameInfo = games.find(g => g.id === currentGame);

    if (currentGame && gameInfo) {
        crumbs.push({ label: gameInfo.name });
    }
    if (currentFilter !== 'all') {
        crumbs.push({ label: currentFilter === 'image' ? '图片' : '音频' });
    }
    if (currentSubcat) {
        crumbs.push({ label: currentSubcat });
    }

    el.innerHTML = crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        const sep = i > 0 ? '<span class="crumb-sep">/</span>' : '';
        if (isLast) return `${sep}<span class="crumb active">${c.label}</span>`;
        return `${sep}<span class="crumb" onclick="${c.action || ''}">${c.label}</span>`;
    }).join('');
}

function getBreadcrumbTitle() {
    const gameInfo = games.find(g => g.id === currentGame);
    if (currentSubcat) return currentSubcat;
    if (currentGame && gameInfo) return gameInfo.name;
    if (currentFilter === 'image') return '图片素材';
    if (currentFilter === 'audio') return '音频素材';
    return '全部资产';
}

function resetAll() {
    currentFilter = 'all';
    currentGame = null;
    currentSubcat = null;
    currentPage = 1;
    searchQuery = '';
    document.getElementById('search-input').value = '';
    hideSubNav();
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector('.nav-item[data-filter="all"]').classList.add('active');
    render();
}

// ─── 图片预览 ───
let currentPreviewPath = '';

function previewImage(path, name, sizeStr) {
    currentPreviewPath = path;
    const modal = document.getElementById('image-modal');
    document.getElementById('modal-image').src = `/api/file/${encPath(path)}`;
    document.getElementById('modal-title').textContent = name;
    document.getElementById('modal-path').textContent = path;
    document.getElementById('modal-size').textContent = sizeStr || '';
    document.getElementById('modal-download').href = `/api/download/${encPath(path)}`;
    modal.classList.add('active');
}

function closeModal() {
    document.getElementById('image-modal').classList.remove('active');
}

function copyLink() {
    const url = `${window.location.origin}/api/file/${encPath(currentPreviewPath)}`;
    navigator.clipboard.writeText(url).then(() => {
        alert('链接已复制！可以在局域网内其他设备打开');
    });
}

// ─── 音频播放 ───
function playAudio(path, name) {
    const player = document.getElementById('audio-player');
    const audio = document.getElementById('audio-element');
    document.getElementById('audio-name').textContent = name;
    document.getElementById('audio-download').href = `/api/download/${encPath(path)}`;
    audio.src = `/api/file/${encPath(path)}`;
    player.classList.add('active');
    audio.play();
}

function closeAudioPlayer() {
    const player = document.getElementById('audio-player');
    const audio = document.getElementById('audio-element');
    audio.pause();
    audio.src = '';
    player.classList.remove('active');
}

// ═══════════════════════════════════════
// 上传功能
// ═══════════════════════════════════════

let uploadQueue = [];

function showUploadModal() {
    document.getElementById('upload-modal').classList.add('active');
    uploadQueue = [];
    renderUploadFileList();
    setupUploadDragDrop();
}

function closeUploadModal() {
    document.getElementById('upload-modal').classList.remove('active');
    uploadQueue = [];
}

function setupUploadDragDrop() {
    const dropzone = document.getElementById('upload-dropzone');
    const input = document.getElementById('upload-input');
    
    // 点击选择文件
    dropzone.addEventListener('click', () => input.click());
    
    // 文件选择
    input.addEventListener('change', (e) => {
        addFilesToQueue(e.target.files);
        input.value = ''; // 清空，允许重复选择相同文件
    });
    
    // 拖拽事件
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });
    
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        addFilesToQueue(e.dataTransfer.files);
    });
}

function addFilesToQueue(files) {
    const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.ogg', '.m4a'];
    
    for (const file of files) {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (!allowedExts.includes(ext)) {
            showGitResult('❌ 不支持的文件类型', 'error', `${file.name} (${ext})`);
            continue;
        }
        
        uploadQueue.push({
            file: file,
            name: file.name,
            size: formatSize(file.size),
            status: 'pending', // pending, uploading, success, error
            progress: 0
        });
    }
    
    renderUploadFileList();
    updateUploadButton();
}

function renderUploadFileList() {
    const container = document.getElementById('upload-file-list');
    
    if (uploadQueue.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    container.innerHTML = uploadQueue.map((item, index) => {
        const icon = item.file.type.startsWith('image/') ? '🖼️' : '🎵';
        const statusText = {
            'pending': '等待中',
            'uploading': '上传中...',
            'success': '✓ 完成',
            'error': '✗ 失败'
        }[item.status];
        
        return `
            <div class="upload-file-item">
                <span class="upload-file-icon">${icon}</span>
                <div class="upload-file-info">
                    <div class="upload-file-name">${esc(item.name)}</div>
                    <div class="upload-file-size">${item.size}</div>
                </div>
                <span class="upload-file-status ${item.status}">${statusText}</span>
                ${item.status === 'pending' ? `
                    <button class="upload-file-remove" onclick="removeFromQueue(${index})">✕</button>
                ` : ''}
            </div>
        `;
    }).join('');
}

function removeFromQueue(index) {
    uploadQueue.splice(index, 1);
    renderUploadFileList();
    updateUploadButton();
}

function updateUploadButton() {
    const btn = document.getElementById('upload-btn');
    const pendingCount = uploadQueue.filter(i => i.status === 'pending').length;
    btn.disabled = pendingCount === 0;
    btn.textContent = pendingCount > 0 ? `开始上传 (${pendingCount})` : '开始上传';
}

async function startUpload() {
    const game = document.getElementById('upload-game').value;
    const subdir = document.getElementById('upload-subdir').value.trim();
    
    const pendingItems = uploadQueue.filter(i => i.status === 'pending');
    if (pendingItems.length === 0) return;
    
    const btn = document.getElementById('upload-btn');
    btn.disabled = true;
    
    let successCount = 0;
    let failCount = 0;
    
    for (const item of pendingItems) {
        item.status = 'uploading';
        renderUploadFileList();
        
        const formData = new FormData();
        formData.append('file', item.file);
        formData.append('game', game);
        if (subdir) formData.append('subdir', subdir);
        
        try {
            const resp = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            const result = await resp.json();
            
            if (result.success) {
                item.status = 'success';
                successCount++;
            } else {
                item.status = 'error';
                item.error = result.error;
                failCount++;
            }
        } catch (err) {
            item.status = 'error';
            item.error = err.message;
            failCount++;
        }
        
        renderUploadFileList();
    }
    
    // 显示结果
    if (failCount === 0) {
        showGitResult('✅ 上传完成', 'success', `成功上传 ${successCount} 个文件`);
        setTimeout(() => {
            closeUploadModal();
            refreshAssets();
            loadGitInfo();
        }, 1500);
    } else {
        showGitResult(`⚠️ 上传完成 (${successCount} 成功, ${failCount} 失败)`, 'error');
        updateUploadButton();
    }
}

// ═══════════════════════════════════════
// Git 功能
// ═══════════════════════════════════════

let gitInfo = null;

async function loadGitInfo() {
    try {
        const resp = await fetch('/api/git/info');
        gitInfo = await resp.json();
        renderGitPanel();
    } catch (err) {
        console.error('Git info load failed:', err);
        document.getElementById('git-panel').innerHTML = `
            <div class="git-not-repo">
                <div class="git-not-repo-icon">⚠️</div>
                <div>无法获取 Git 信息</div>
            </div>`;
    }
}

function renderGitPanel() {
    const panel = document.getElementById('git-panel');
    
    if (!gitInfo || !gitInfo.is_repo) {
        panel.innerHTML = `
            <div class="git-not-repo">
                <div class="git-not-repo-icon">📁</div>
                <div>未初始化 Git 仓库</div>
                <button class="git-btn primary" style="margin-top:10px;width:100%" onclick="gitInit()">
                    🔧 初始化 Git
                </button>
            </div>`;
        return;
    }
    
    const hasChanges = gitInfo.modified.length > 0 || gitInfo.untracked.length > 0;
    const canPush = gitInfo.ahead > 0;
    const canPull = gitInfo.behind > 0;
    
    let filesHtml = '';
    if (gitInfo.modified.length > 0 || gitInfo.untracked.length > 0) {
        const allFiles = [
            ...gitInfo.modified.map(f => ({ status: f.status, path: f.path })),
            ...gitInfo.untracked.map(f => ({ status: '??', path: f }))
        ];
        filesHtml = `
            <div class="git-files">
                ${allFiles.slice(0, 10).map(f => `
                    <div class="git-file-item">
                        <span class="git-file-status ${f.status.replace('?', 'Q')}">${f.status}</span>
                        <span class="git-file-path" title="${esc(f.path)}">${esc(f.path)}</span>
                    </div>
                `).join('')}
                ${allFiles.length > 10 ? `<div class="git-file-item">...还有 ${allFiles.length - 10} 个文件</div>` : ''}
            </div>
        `;
    }
    
    panel.innerHTML = `
        <div class="git-header">
            <span class="git-icon">🌿</span>
            <span class="git-branch">
                <span class="git-branch-icon">⎇</span>
                ${gitInfo.branch || 'unknown'}
            </span>
            ${gitInfo.commit ? `<span class="git-commit" title="${esc(gitInfo.commit.message)}">${gitInfo.commit.hash}</span>` : ''}
        </div>
        
        <div class="git-status">
            <div class="git-stat-row">
                <span class="git-stat-label">修改</span>
                <span class="git-stat-value modified">${gitInfo.modified.length}</span>
            </div>
            <div class="git-stat-row">
                <span class="git-stat-label">未跟踪</span>
                <span class="git-stat-value untracked">${gitInfo.untracked.length}</span>
            </div>
            <div class="git-stat-row">
                <span class="git-stat-label">领先远程</span>
                <span class="git-stat-value ahead">+${gitInfo.ahead}</span>
            </div>
            <div class="git-stat-row">
                <span class="git-stat-label">落后远程</span>
                <span class="git-stat-value behind">-${gitInfo.behind}</span>
            </div>
        </div>
        
        ${filesHtml}
        
        ${hasChanges ? `
            <input type="text" class="git-message-input" id="git-commit-msg" 
                   placeholder="提交信息..." value="Update assets">
            <div class="git-actions">
                <button class="git-btn primary" onclick="gitCommit()">💾 提交</button>
                <button class="git-btn" onclick="gitStatus()">📋 状态</button>
            </div>
        ` : ''}
        
        <div class="git-actions">
            <button class="git-btn ${canPull ? 'primary' : ''}" onclick="gitPull()" ${!canPull ? 'disabled' : ''}>
                ⬇️ 拉取${gitInfo.behind > 0 ? ` (${gitInfo.behind})` : ''}
            </button>
            <button class="git-btn ${canPush ? 'primary' : ''}" onclick="gitPush()" ${!canPush ? 'disabled' : ''}>
                ⬆️ 推送${gitInfo.ahead > 0 ? ` (${gitInfo.ahead})` : ''}
            </button>
        </div>
        
        <div class="git-actions">
            <button class="git-btn" onclick="gitLog()">📜 日志</button>
            <button class="git-btn" onclick="gitFetch()">🔄 获取</button>
        </div>
        
        ${gitInfo.remote ? `
            <div class="git-remote">
                📡 ${esc(gitInfo.remote.name)}: ${esc(gitInfo.remote.url)}
            </div>
        ` : ''}
    `;
}

// Git 操作
async function gitCommit() {
    const msg = document.getElementById('git-commit-msg')?.value || 'Update';
    showGitResult('提交中...', 'pending');
    
    try {
        const resp = await fetch('/api/git/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        const result = await resp.json();
        
        if (result.success) {
            showGitResult('✅ 提交成功', 'success', result.stdout || result.stderr);
            loadGitInfo();
        } else {
            showGitResult('❌ 提交失败', 'error', result.stderr || result.stdout);
        }
    } catch (err) {
        showGitResult('❌ 网络错误', 'error', err.message);
    }
}

async function gitPull() {
    showGitResult('拉取中...', 'pending');
    try {
        const resp = await fetch('/api/git/pull', { method: 'POST' });
        const result = await resp.json();
        
        if (result.success) {
            showGitResult('✅ 拉取成功', 'success', result.stdout || 'Already up to date');
            loadGitInfo();
            refreshAssets(); // 资产可能有更新
        } else {
            showGitResult('❌ 拉取失败', 'error', result.stderr);
        }
    } catch (err) {
        showGitResult('❌ 网络错误', 'error', err.message);
    }
}

async function gitPush() {
    showGitResult('推送中...', 'pending');
    try {
        const resp = await fetch('/api/git/push', { method: 'POST' });
        const result = await resp.json();
        
        if (result.success) {
            showGitResult('✅ 推送成功', 'success', result.stdout);
            loadGitInfo();
        } else {
            showGitResult('❌ 推送失败', 'error', result.stderr);
        }
    } catch (err) {
        showGitResult('❌ 网络错误', 'error', err.message);
    }
}

async function gitFetch() {
    showGitResult('获取远程信息...', 'pending');
    try {
        const resp = await fetch('/api/git/fetch', { method: 'POST' });
        const result = await resp.json();
        
        if (result.success) {
            showGitResult('✅ 获取成功', 'success', result.stdout || 'Done');
            loadGitInfo();
        } else {
            showGitResult('❌ 获取失败', 'error', result.stderr);
        }
    } catch (err) {
        showGitResult('❌ 网络错误', 'error', err.message);
    }
}

async function gitStatus() {
    showGitResult('查询状态...', 'pending');
    try {
        const resp = await fetch('/api/git/status');
        const result = await resp.json();
        showGitResult('📋 Git 状态', result.success ? 'success' : 'error', 
            result.stdout || result.stderr || 'No output');
    } catch (err) {
        showGitResult('❌ 错误', 'error', err.message);
    }
}

async function gitLog() {
    showGitResult('查询日志...', 'pending');
    try {
        const resp = await fetch('/api/git/log');
        const result = await resp.json();
        showGitResult('📜 提交日志', result.success ? 'success' : 'error', 
            result.stdout || result.stderr || 'No commits');
    } catch (err) {
        showGitResult('❌ 错误', 'error', err.message);
    }
}

function showGitResult(title, type, content) {
    // 移除旧的弹窗
    document.querySelectorAll('.git-result-modal').forEach(el => el.remove());
    
    const modal = document.createElement('div');
    modal.className = `git-result-modal ${type}`;
    modal.innerHTML = `
        <button class="git-result-close" onclick="this.parentElement.remove()">✕</button>
        <div class="git-result-header">${title}</div>
        ${content ? `<div class="git-result-content">${esc(content)}</div>` : ''}
    `;
    document.body.appendChild(modal);
    
    // 5秒后自动关闭
    if (type !== 'pending') {
        setTimeout(() => modal.remove(), 5000);
    }
}

// ═══════════════════════════════════════
// 删除功能
// ═══════════════════════════════════════

async function deleteAsset(event, path, name) {
    event.stopPropagation();
    
    if (!confirm(`确定要删除 "${name}" 吗？\n\n此操作不可恢复！`)) {
        return;
    }
    
    showGitResult('删除中...', 'pending');
    
    try {
        const resp = await fetch(`/api/delete/${encPath(path)}`, {
            method: 'DELETE'
        });
        const result = await resp.json();
        
        if (result.success) {
            showGitResult('✅ 删除成功', 'success', result.message);
            // 刷新资产列表
            refreshAssets();
            // 同时刷新 Git 状态（文件被删了）
            loadGitInfo();
        } else {
            showGitResult('❌ 删除失败', 'error', result.error);
        }
    } catch (err) {
        showGitResult('❌ 网络错误', 'error', err.message);
    }
}

// ─── 视图切换 ───
function setView(mode) {
    viewMode = mode;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
    render();
}

// ═══════════════════════════════════════
// 多选模式
// ═══════════════════════════════════════

function toggleSelectMode() {
    selectMode = !selectMode;
    const btn = document.getElementById('select-mode-btn');
    const deleteBtn = document.getElementById('batch-delete-btn');
    
    if (selectMode) {
        btn.textContent = '☑ 退出多选';
        btn.classList.add('active');
        deleteBtn.style.display = 'inline-flex';
        selectedAssets.clear();
        updateSelectedCount();
    } else {
        btn.textContent = '☐ 多选';
        btn.classList.remove('active');
        deleteBtn.style.display = 'none';
        selectedAssets.clear();
    }
    render();
}

function toggleAssetSelection(assetId, event) {
    if (event) event.stopPropagation();
    
    if (selectedAssets.has(assetId)) {
        selectedAssets.delete(assetId);
    } else {
        selectedAssets.add(assetId);
    }
    updateSelectedCount();
    render(); // 重新渲染以更新选中状态
}

function updateSelectedCount() {
    const count = selectedAssets.size;
    document.getElementById('selected-count').textContent = count;
    document.getElementById('batch-delete-btn').disabled = count === 0;
}

async function batchDelete() {
    if (selectedAssets.size === 0) {
        alert('请先选择要删除的文件');
        return;
    }
    
    const assetsToDelete = allAssets.filter(a => selectedAssets.has(a.id));
    const fileNames = assetsToDelete.map(a => a.name).join('\n');
    
    if (!confirm(`确定要删除以下 ${selectedAssets.size} 个文件吗？\n\n${fileNames.slice(0, 500)}${fileNames.length > 500 ? '\n...' : ''}\n\n此操作不可恢复！`)) {
        return;
    }
    
    showGitResult(`正在删除 ${selectedAssets.size} 个文件...`, 'pending');
    
    let successCount = 0;
    let failCount = 0;
    const errors = [];
    
    for (const assetId of selectedAssets) {
        const asset = allAssets.find(a => a.id === assetId);
        if (!asset) continue;
        
        try {
            const resp = await fetch(`/api/delete/${encPath(asset.path)}`, {
                method: 'DELETE'
            });
            const result = await resp.json();
            
            if (result.success) {
                successCount++;
            } else {
                failCount++;
                errors.push(`${asset.name}: ${result.error}`);
            }
        } catch (err) {
            failCount++;
            errors.push(`${asset.name}: ${err.message}`);
        }
    }
    
    // 清空选择
    selectedAssets.clear();
    updateSelectedCount();
    
    // 显示结果
    if (failCount === 0) {
        showGitResult('✅ 批量删除成功', 'success', `成功删除 ${successCount} 个文件`);
    } else {
        showGitResult(`⚠️ 删除完成 (${successCount} 成功, ${failCount} 失败)`, 'error', errors.slice(0, 5).join('\n'));
    }
    
    // 刷新
    refreshAssets();
    loadGitInfo();
}

// ─── 刷新 ───
function refreshAssets() {
    document.getElementById('assets-grid').innerHTML =
        '<div class="loading"><div class="spinner"></div><span>重新扫描中...</span></div>';
    loadAssets();
}

// ─── 侧边栏切换（移动端） ───
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ─── 工具函数 ───
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function esc(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function encPath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
}
