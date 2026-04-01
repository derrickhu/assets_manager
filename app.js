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
const PAGE_SIZE = 80;

// ─── 初始化 ───
document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    loadAssets();
    loadServerInfo();
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

    if (asset.type === 'image') {
        return `
        <div class="asset-card" onclick="previewImage('${esc(asset.path)}', '${esc(asset.name)}', '${sizeStr}')">
            <div class="asset-preview">
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
        return `
        <div class="asset-card" onclick="playAudio('${esc(asset.path)}', '${esc(asset.name)}')">
            <div class="asset-preview audio-preview">
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

// ─── 视图切换 ───
function setView(mode) {
    viewMode = mode;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
    render();
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
