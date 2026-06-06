#!/usr/bin/env python3
"""
游戏资产管理服务器
- 自动扫描 game_assets 目录
- 提供图片/音频文件的 HTTP 访问
- 生成缩略图加速浏览
- 支持文件下载
- 局域网共享（0.0.0.0 监听）
"""

import os
import json
import socket
import hashlib
import mimetypes
from pathlib import Path
from io import BytesIO
from functools import lru_cache

from flask import Flask, jsonify, send_file, request, abort, render_template, Response
from flask_cors import CORS

import video_tools as vt

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# ─── 配置 ───────────────────────────────────────────────────────
ASSET_ROOT = Path('/Users/huyi/dk_proj/game_assets')
THUMB_DIR = Path('/Users/huyi/dk_proj/asset_manager/.thumbs')
THUMB_SIZE = (300, 300)
PORT = int(os.environ.get('PORT', '5050'))
HOST = os.environ.get('HOST', '0.0.0.0')

# Git 仓库路径（资产目录，而非代码目录）
PROJECT_ROOT = ASSET_ROOT  # 管理 game_assets 的 Git

# 允许执行的 Git 命令白名单
GIT_COMMANDS = {
    'status': ['git', 'status', '--short'],
    'log': ['git', 'log', '--oneline', '-20'],
    'branch': ['git', 'branch', '-v'],
    'remote': ['git', 'remote', '-v'],
    'diff': ['git', 'diff', '--stat'],
}

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'}
AUDIO_EXTS = {'.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'}

GAME_META = {
    'huahua': {'name': '花花', 'icon': '🌸', 'desc': '花店经营合成游戏'},
    'jrpg':   {'name': 'JRPG', 'icon': '⚔️', 'desc': '日式角色扮演游戏'},
    'xiaochu': {'name': '消除', 'icon': '🧩', 'desc': '五行消除冒险游戏'},
    'wujin_wenzhang': {'name': '无尽纹章', 'icon': '🛡️', 'desc': '无尽纹章游戏'},
}
VALID_GAME_IDS = frozenset(GAME_META.keys())

# ─── Flask App ──────────────────────────────────────────────────
app = Flask(__name__, static_folder='static', template_folder='.')
CORS(app)

# ─── 工具函数 ──────────────────────────────────────────────────

def get_local_ip():
    """获取局域网 IP（优先 192.168.x.x 或 10.x.x.x 真实网卡）"""
    try:
        # 方法1: 通过 UDP 连接外网获取（排除回环和 VPN）
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        
        # 如果获取到的是 127.x 或 169.254.x，尝试方法2
        if ip.startswith('127.') or ip.startswith('169.254.'):
            raise ValueError("Got loopback or link-local")
        
        # 优先选择真实局域网（排除 VPN 192.168.255.x）
        if ip.startswith('192.168.255.'):
            raise ValueError("Got VPN address")
        if ip.startswith('192.168.') or ip.startswith('10.'):
            return ip
            
        return ip
    except Exception:
        pass
    
    # 方法2: 遍历所有网卡找最佳局域网 IP
    try:
        import subprocess
        result = subprocess.run(['ifconfig'], capture_output=True, text=True)
        output = result.stdout
        
        # 按优先级匹配：192.168.x.x > 10.x.x.x > 其他
        import re
        
        # 先找 192.168.x.x（排除 192.168.255.x VPN）
        matches = re.findall(r'inet (192\.168\.(?!255)\d+\.\d+)', output)
        if matches:
            return matches[0]
        
        # 再找 10.x.x.x
        matches = re.findall(r'inet (10\.\d+\.\d+\.\d+)', output)
        if matches:
            return matches[0]
            
        # 最后找任何非回环、非链路本地、非 VPN 段
        matches = re.findall(r'inet (\d+\.\d+\.\d+\.\d+)', output)
        for m in matches:
            if m.startswith('127.') or m.startswith('169.254.'):
                continue
            if m.startswith('192.168.255.'):
                continue
            return m
    except Exception:
        pass
    
    return '127.0.0.1'


def classify_file(ext):
    """根据扩展名判断文件类别"""
    ext = ext.lower()
    if ext in IMAGE_EXTS:
        return 'image'
    if ext in AUDIO_EXTS:
        return 'audio'
    return None


def scan_assets():
    """扫描 game_assets 目录，返回所有资产列表"""
    assets = []
    
    for game_dir in sorted(ASSET_ROOT.iterdir()):
        if not game_dir.is_dir():
            continue
        game_name = game_dir.name
        if game_name.startswith('.'):
            continue
        
        for fpath in sorted(game_dir.rglob('*')):
            if not fpath.is_file():
                continue
            if fpath.name.startswith('.'):
                continue
            
            ext = fpath.suffix.lower()
            ftype = classify_file(ext)
            if ftype is None:
                continue
            
            rel = fpath.relative_to(ASSET_ROOT)
            # 子分类：取 game 目录下的第一层子目录名
            parts = rel.parts
            subcategory = parts[1] if len(parts) > 2 else ''
            # 更细分类：如果在 images/ 下还有子目录
            sub_sub = parts[2] if len(parts) > 3 else ''
            
            stat = fpath.stat()
            
            assets.append({
                'id': hashlib.md5(str(rel).encode()).hexdigest()[:12],
                'name': fpath.name,
                'path': str(rel),           # 相对路径
                'game': game_name,
                'type': ftype,
                'ext': ext.lstrip('.'),
                'category': subcategory,     # assets / audio 等
                'subcategory': sub_sub,      # hero / pets / ui 等
                'size': stat.st_size,
                'modified': stat.st_mtime,
            })
    
    return assets


def make_thumbnail(rel_path):
    """生成缩略图并缓存到 .thumbs 目录"""
    if not HAS_PIL:
        return None
    
    src = ASSET_ROOT / rel_path
    if not src.exists():
        return None
    
    thumb_name = hashlib.md5(str(rel_path).encode()).hexdigest() + '.jpg'
    thumb_path = THUMB_DIR / thumb_name
    
    if thumb_path.exists() and thumb_path.stat().st_mtime >= src.stat().st_mtime:
        return thumb_path
    
    try:
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        img = Image.open(src)
        img.thumbnail(THUMB_SIZE, Image.Resampling.LANCZOS)
        # 转换为 RGB（处理 RGBA/P 模式）
        if img.mode in ('RGBA', 'P', 'LA'):
            bg = Image.new('RGB', img.size, (30, 41, 59))  # 暗色背景
            if img.mode == 'P':
                img = img.convert('RGBA')
            bg.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        img.save(thumb_path, 'JPEG', quality=85)
        return thumb_path
    except Exception as e:
        print(f"  Thumbnail error for {rel_path}: {e}")
        return None


def format_size(size_bytes):
    """格式化文件大小"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


# ─── Git 工具函数 ───────────────────────────────────────────────

def run_git_command(cmd_list, cwd=None):
    """安全执行 Git 命令"""
    import subprocess
    try:
        result = subprocess.run(
            cmd_list,
            cwd=cwd or PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=30
        )
        return {
            'success': result.returncode == 0,
            'stdout': result.stdout,
            'stderr': result.stderr,
            'code': result.returncode
        }
    except subprocess.TimeoutExpired:
        return {'success': False, 'stdout': '', 'stderr': 'Command timeout', 'code': -1}
    except Exception as e:
        return {'success': False, 'stdout': '', 'stderr': str(e), 'code': -1}


def get_git_info():
    """获取 Git 仓库基本信息"""
    info = {
        'is_repo': False,
        'branch': None,
        'commit': None,
        'remote': None,
        'modified': [],
        'untracked': [],
        'ahead': 0,
        'behind': 0,
    }
    
    # 检查是否是 git 仓库
    check = run_git_command(['git', 'rev-parse', '--git-dir'])
    if not check['success']:
        return info
    
    info['is_repo'] = True
    
    # 当前分支
    branch_result = run_git_command(['git', 'branch', '--show-current'])
    if branch_result['success']:
        info['branch'] = branch_result['stdout'].strip()
    
    # 最新 commit
    commit_result = run_git_command(['git', 'log', '-1', '--format=%h|%s|%an|%ar'])
    if commit_result['success']:
        parts = commit_result['stdout'].strip().split('|', 3)
        if len(parts) >= 4:
            info['commit'] = {
                'hash': parts[0],
                'message': parts[1],
                'author': parts[2],
                'time': parts[3]
            }
    
    # 远程仓库
    remote_result = run_git_command(['git', 'remote', '-v'])
    if remote_result['success'] and remote_result['stdout']:
        lines = remote_result['stdout'].strip().split('\n')
        if lines:
            parts = lines[0].split()
            if len(parts) >= 2:
                info['remote'] = {'name': parts[0], 'url': parts[1]}
    
    # 文件状态
    status_result = run_git_command(['git', 'status', '--porcelain'])
    if status_result['success']:
        for line in status_result['stdout'].strip().split('\n'):
            if not line:
                continue
            status = line[:2]
            filepath = line[3:]
            if status.startswith('??'):
                info['untracked'].append(filepath)
            else:
                info['modified'].append({'status': status, 'path': filepath})
    
    # 与远程的差异（只在有远程仓库时检查）
    if info['branch'] and info['remote']:
        # 先 fetch 更新远程信息
        run_git_command(['git', 'fetch', '--quiet'])
        
        # 尝试获取 ahead/behind
        rev_result = run_git_command(['git', 'rev-list', '--left-right', '--count', f'origin/{info["branch"]}...HEAD'])
        if rev_result['success']:
            counts = rev_result['stdout'].strip().split()
            if len(counts) == 2:
                info['behind'] = int(counts[0])  # 本地落后远程
                info['ahead'] = int(counts[1])   # 本地领先远程
    
    return info


# ─── API 路由 ──────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/styles.css')
def serve_css():
    return send_file('styles.css', mimetype='text/css')


@app.route('/app.js')
def serve_js():
    return send_file('app.js', mimetype='application/javascript')


@app.route('/video_tool.js')
def serve_video_tool_js():
    return send_file('video_tool.js', mimetype='application/javascript')


@app.route('/video_tool.css')
def serve_video_tool_css():
    return send_file('video_tool.css', mimetype='text/css')


@app.route('/api/scan')
def api_scan():
    """扫描资产目录，返回完整资产列表"""
    assets = scan_assets()
    
    # 统计
    games = {}
    for a in assets:
        g = a['game']
        if g not in games:
            meta = GAME_META.get(g, {'name': g, 'icon': '📁', 'desc': ''})
            games[g] = {
                'id': g,
                'name': meta['name'],
                'icon': meta['icon'],
                'desc': meta['desc'],
                'image_count': 0,
                'audio_count': 0,
                'total_size': 0,
                'subcategories': set(),
            }
        games[g][f"{a['type']}_count"] += 1
        games[g]['total_size'] += a['size']
        if a['subcategory']:
            games[g]['subcategories'].add(a['subcategory'])
    
    # 补全 GAME_META 中尚无资产文件的游戏（空目录也显示在侧栏）
    for game_id, meta in GAME_META.items():
        if game_id not in games:
            games[game_id] = {
                'id': game_id,
                'name': meta['name'],
                'icon': meta['icon'],
                'desc': meta['desc'],
                'image_count': 0,
                'audio_count': 0,
                'total_size': 0,
                'subcategories': [],
            }

    meta_order = list(GAME_META.keys())
    game_list = sorted(
        games.values(),
        key=lambda g: meta_order.index(g['id']) if g['id'] in meta_order else len(meta_order),
    )

    for g in game_list:
        if isinstance(g.get('subcategories'), set):
            g['subcategories'] = sorted(g['subcategories'])
        g['total_size_str'] = format_size(g['total_size'])

    return jsonify({
        'assets': assets,
        'games': game_list,
        'stats': {
            'total': len(assets),
            'images': sum(1 for a in assets if a['type'] == 'image'),
            'audio': sum(1 for a in assets if a['type'] == 'audio'),
            'games': len(game_list),
        }
    })


@app.route('/api/file/<path:rel_path>')
def api_file(rel_path):
    """直接提供资产文件（图片/音频原始文件）"""
    fpath = ASSET_ROOT / rel_path
    if not fpath.exists() or not fpath.is_file():
        abort(404)
    # 安全检查：不允许路径穿越
    try:
        fpath.resolve().relative_to(ASSET_ROOT.resolve())
    except ValueError:
        abort(403)
    return send_file(fpath)


@app.route('/api/thumb/<path:rel_path>')
def api_thumb(rel_path):
    """提供缩略图"""
    fpath = ASSET_ROOT / rel_path
    if not fpath.exists():
        abort(404)
    
    thumb = make_thumbnail(rel_path)
    if thumb and thumb.exists():
        return send_file(thumb, mimetype='image/jpeg')
    
    # 降级：直接发送原图
    return send_file(fpath)


@app.route('/api/download/<path:rel_path>')
def api_download(rel_path):
    """下载文件"""
    fpath = ASSET_ROOT / rel_path
    if not fpath.exists() or not fpath.is_file():
        abort(404)
    try:
        fpath.resolve().relative_to(ASSET_ROOT.resolve())
    except ValueError:
        abort(403)
    return send_file(fpath, as_attachment=True, download_name=fpath.name)


@app.route('/api/info')
def api_info():
    """服务器信息"""
    local_ip = get_local_ip()
    ffmpeg = vt.check_ffmpeg()
    return jsonify({
        'asset_root': str(ASSET_ROOT),
        'local_ip': local_ip,
        'port': PORT,
        # 浏览器请用 localhost；0.0.0.0 仅作服务绑定，不能作为访问地址
        'url': f'http://localhost:{PORT}',
        'lan_url': f'http://{local_ip}:{PORT}',
        'has_pil': HAS_PIL,
        'ffmpeg': ffmpeg,
        'video_max_mb': vt.VIDEO_MAX_MB,
    })


@app.route('/api/games')
def api_games():
    """游戏列表（供视频截帧导出等工具使用）"""
    return jsonify({
        'games': [
            {'id': gid, **meta}
            for gid, meta in GAME_META.items()
        ],
    })


# ─── 视频截帧工具 API ───────────────────────────────────────────

@app.route('/api/video/status')
def api_video_status():
    return jsonify({
        'ffmpeg': vt.check_ffmpeg(),
        'video_max_mb': vt.VIDEO_MAX_MB,
        'max_extract_frames': vt.MAX_EXTRACT_FRAMES,
        'supported_exts': sorted(vt.VIDEO_EXTS),
    })


@app.route('/api/video/list')
def api_video_list():
    return jsonify({'videos': vt.list_videos()})


@app.route('/api/video/upload', methods=['POST'])
def api_video_upload():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file provided'}), 400
    file = request.files['file']
    if not file.filename:
        return jsonify({'success': False, 'error': 'Empty filename'}), 400
    try:
        meta = vt.save_upload(file, file.filename)
        return jsonify({'success': True, 'video': meta})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400


@app.route('/api/video/<video_id>/stream')
def api_video_stream(video_id):
    try:
        path = vt.get_video_path(video_id)
    except FileNotFoundError:
        abort(404)
    mime = mimetypes.guess_type(path.name)[0] or 'video/mp4'
    return send_file(path, mimetype=mime, conditional=True)


@app.route('/api/video/<video_id>/meta')
def api_video_meta(video_id):
    try:
        return jsonify(vt.get_meta(video_id))
    except FileNotFoundError:
        return jsonify({'error': 'Video not found'}), 404


@app.route('/api/video/<video_id>/extract', methods=['POST'])
def api_video_extract(video_id):
    data = request.get_json() or {}
    try:
        result = vt.extract_frames(
            video_id,
            mode=data.get('mode', 'single'),
            fmt=data.get('format', 'png'),
            quality=int(data.get('quality', 85)),
            prefix=data.get('prefix', ''),
            timestamp_ms=data.get('timestamp_ms'),
            interval_sec=data.get('interval_sec'),
            start_ms=int(data.get('start_ms', 0)),
            end_ms=data.get('end_ms'),
            count=data.get('count'),
            timestamps_ms=data.get('timestamps_ms'),
        )
        return jsonify({'success': True, **result})
    except FileNotFoundError:
        return jsonify({'success': False, 'error': 'Video not found'}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400


@app.route('/api/video/<video_id>/frames')
def api_video_frames(video_id):
    batch_id = request.args.get('batch_id')
    return jsonify({'frames': vt.list_frames(video_id, batch_id)})


@app.route('/api/video/frame/<path:rel_path>')
def api_video_frame(rel_path):
    thumb = request.args.get('thumb') == '1'
    try:
        path = vt.resolve_workspace_path(rel_path)
    except ValueError:
        abort(403)
    if not path.exists() or not path.is_file():
        abort(404)
    if thumb:
        t = vt.make_frame_thumbnail(rel_path)
        if t and t.exists():
            return send_file(t, mimetype='image/jpeg')
    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    if request.args.get('download') == '1':
        return send_file(path, mimetype=mime, as_attachment=True, download_name=path.name)
    return send_file(path, mimetype=mime)


@app.route('/api/video/<video_id>/export', methods=['POST'])
def api_video_export(video_id):
    data = request.get_json() or {}
    frame_paths = data.get('frame_paths') or []
    game = data.get('game', '')
    subdir = data.get('subdir', '')
    rename_prefix = data.get('rename', '')
    if not frame_paths:
        return jsonify({'success': False, 'error': 'No frames selected'}), 400
    try:
        vt.get_meta(video_id)
        exported = vt.export_frames_to_game_assets(
            frame_paths, ASSET_ROOT, game, set(VALID_GAME_IDS), subdir, rename_prefix,
        )
        return jsonify({'success': True, 'exported': exported, 'game': game})
    except FileNotFoundError as e:
        return jsonify({'success': False, 'error': str(e)}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400


@app.route('/api/video/<video_id>/download-batch', methods=['POST'])
def api_video_download_batch(video_id):
    data = request.get_json() or {}
    frame_paths = data.get('frame_paths') or []
    if not frame_paths:
        return jsonify({'success': False, 'error': 'No frames selected'}), 400
    try:
        buf = vt.create_frames_zip(frame_paths)
        return send_file(
            buf,
            mimetype='application/zip',
            as_attachment=True,
            download_name=f'{video_id}_frames.zip',
        )
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400


@app.route('/api/video/<video_id>/delete-frames', methods=['POST'])
def api_video_delete_frames(video_id):
    data = request.get_json() or {}
    frame_paths = data.get('frame_paths') or []
    if not frame_paths:
        return jsonify({'success': False, 'error': 'No frames selected'}), 400
    try:
        vt.get_meta(video_id)
        deleted = vt.delete_frames(video_id, frame_paths)
        return jsonify({'success': True, 'deleted': deleted})
    except FileNotFoundError as e:
        return jsonify({'success': False, 'error': str(e)}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400


@app.route('/api/video/<video_id>', methods=['DELETE'])
def api_video_delete(video_id):
    try:
        vt.delete_video(video_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ─── Git API ───────────────────────────────────────────────────

@app.route('/api/git/info')
def api_git_info():
    """获取 Git 仓库信息"""
    return jsonify(get_git_info())


@app.route('/api/git/<command>')
def api_git_command(command):
    """执行 Git 查询命令"""
    if command not in GIT_COMMANDS:
        return jsonify({'error': 'Unknown command'}), 400
    
    result = run_git_command(GIT_COMMANDS[command])
    return jsonify(result)


@app.route('/api/git/pull', methods=['POST'])
def api_git_pull():
    """执行 git pull"""
    result = run_git_command(['git', 'pull'])
    return jsonify(result)


@app.route('/api/git/push', methods=['POST'])
def api_git_push():
    """执行 git push"""
    result = run_git_command(['git', 'push'])
    return jsonify(result)


@app.route('/api/git/fetch', methods=['POST'])
def api_git_fetch():
    """执行 git fetch"""
    result = run_git_command(['git', 'fetch'])
    return jsonify(result)


@app.route('/api/git/commit', methods=['POST'])
def api_git_commit():
    """执行 git commit -am <message>"""
    data = request.get_json() or {}
    message = data.get('message', 'Update from asset manager')
    
    # 先 add 所有修改
    run_git_command(['git', 'add', '-A'])
    # 再 commit
    result = run_git_command(['git', 'commit', '-m', message])
    return jsonify(result)


@app.route('/api/git/checkout', methods=['POST'])
def api_git_checkout():
    """切换分支"""
    data = request.get_json() or {}
    branch = data.get('branch')
    if not branch:
        return jsonify({'error': 'Branch name required'}), 400
    
    result = run_git_command(['git', 'checkout', branch])
    return jsonify(result)


# ─── 文件删除 API ───────────────────────────────────────────────

@app.route('/api/delete/<path:rel_path>', methods=['DELETE'])
def api_delete_file(rel_path):
    """删除资产文件"""
    fpath = ASSET_ROOT / rel_path
    
    # 安全检查：路径必须在 ASSET_ROOT 下
    try:
        resolved = fpath.resolve()
        root_resolved = ASSET_ROOT.resolve()
        resolved.relative_to(root_resolved)
    except (ValueError, RuntimeError):
        return jsonify({'success': False, 'error': 'Invalid path'}), 403
    
    if not fpath.exists():
        return jsonify({'success': False, 'error': 'File not found'}), 404
    
    if not fpath.is_file():
        return jsonify({'success': False, 'error': 'Not a file'}), 400
    
    try:
        # 删除文件
        fpath.unlink()
        
        # 同时删除对应的缩略图缓存
        thumb_name = hashlib.md5(str(rel_path).encode()).hexdigest() + '.jpg'
        thumb_path = THUMB_DIR / thumb_name
        if thumb_path.exists():
            thumb_path.unlink()
        
        return jsonify({
            'success': True,
            'message': f'Deleted: {fpath.name}'
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# ─── 文件上传 API ───────────────────────────────────────────────

@app.route('/api/upload', methods=['POST'])
def api_upload_file():
    """上传资产文件"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'Empty filename'}), 400
    
    # 获取上传参数
    game = request.form.get('game', 'huahua')  # 默认上传到 huahua
    subdir = request.form.get('subdir', '')    # 子目录
    
    # 验证游戏目录
    if game not in VALID_GAME_IDS:
        return jsonify({'success': False, 'error': 'Invalid game directory'}), 400
    
    # 安全检查文件名
    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({'success': False, 'error': 'Invalid filename'}), 400
    
    # 检查文件类型
    ext = Path(filename).suffix.lower()
    if ext not in IMAGE_EXTS and ext not in AUDIO_EXTS:
        return jsonify({'success': False, 'error': f'Unsupported file type: {ext}'}), 400
    
    # 构建目标路径
    target_dir = ASSET_ROOT / game
    if subdir:
        # 清理子目录路径，防止路径穿越
        subdir = secure_filename(subdir)
        target_dir = target_dir / subdir
    
    # 确保目标目录存在
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # 如果文件已存在，添加数字后缀
    target_path = target_dir / filename
    counter = 1
    original_stem = Path(filename).stem
    original_ext = Path(filename).suffix
    while target_path.exists():
        new_name = f"{original_stem}_{counter}{original_ext}"
        target_path = target_dir / new_name
        counter += 1
    
    try:
        # 保存文件
        file.save(target_path)
        
        # 计算相对路径
        rel_path = target_path.relative_to(ASSET_ROOT)
        
        return jsonify({
            'success': True,
            'message': f'Uploaded: {target_path.name}',
            'path': str(rel_path),
            'size': target_path.stat().st_size
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# 安全的文件名处理
def secure_filename(filename):
    """清理文件名，移除危险字符"""
    import re
    # 移除路径分隔符和危险字符
    filename = re.sub(r'[\\/:*?"<>|]', '', filename)
    # 移除前导点和空格
    filename = filename.strip('. ')
    return filename


# ─── 启动 ──────────────────────────────────────────────────────

if __name__ == '__main__':
    vt.ensure_workspace()
    removed = vt.cleanup_stale_workspace()
    if removed:
        print(f'  🧹 视频工作区清理: 删除 {removed} 个过期任务')

    local_ip = get_local_ip()
    ffmpeg = vt.check_ffmpeg()
    print("=" * 60)
    print("  🎮  游戏资产管理服务器")
    print("=" * 60)
    print(f"  📁 资产目录: {ASSET_ROOT}")
    print(f"  🔌 监听地址: {HOST}:{PORT}")
    print(f"  🌐 局域网访问: http://{local_ip}:{PORT}")
    print(f"  🖼️ 缩略图缓存: {THUMB_DIR}")
    print(f"  📷 PIL 支持: {'✅' if HAS_PIL else '❌ pip install Pillow'}")
    print(f"  🎬 ffmpeg: {'✅' if ffmpeg['available'] else '❌ brew install ffmpeg'}")
    
    # debug=True 开启后端代码变更自动重载
    # 生产环境下设 ASSET_DEBUG=0 关闭
    use_debug = os.environ.get('ASSET_DEBUG', '1') == '1'
    if use_debug:
        print("  🔥 Debug 模式: 已开启（代码修改后自动重载）")
    else:
        print("  🔒 Debug 模式: 已关闭")
    print("=" * 60)
    
    app.run(host=HOST, port=PORT, debug=use_debug, use_reloader=use_debug)
