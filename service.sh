#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  游戏资产管理服务器 - 服务管理脚本
#  用法: ./service.sh {start|stop|restart|status|log}
# ═══════════════════════════════════════════════════════════

set -e

# ─── 配置 ───
APP_NAME="asset-manager"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_SCRIPT="$APP_DIR/server.py"
PID_FILE="$APP_DIR/.server.pid"
LOG_FILE="$APP_DIR/.server.log"
PORT=5050

# ─── 颜色 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# ─── 获取局域网 IP ───
get_lan_ip() {
    python3 -c "
import socket
import re
import subprocess

def get_ip():
    # 方法1: UDP 连接
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        if ip.startswith('192.168.') and not ip.startswith('192.168.255.'):
            return ip
        if ip.startswith('10.'):
            return ip
    except:
        pass
    
    # 方法2: ifconfig 解析
    try:
        result = subprocess.run(['ifconfig'], capture_output=True, text=True)
        output = result.stdout
        
        # 优先 192.168.x.x（排除 192.168.255.x VPN）
        matches = re.findall(r'inet (192\.168\.(?!255)\d+\.\d+)', output)
        if matches:
            return matches[0]
        
        # 其次 10.x.x.x
        matches = re.findall(r'inet (10\.\d+\.\d+\.\d+)', output)
        if matches:
            return matches[0]
            
        # 最后任何非回环
        matches = re.findall(r'inet (\d+\.\d+\.\d+\.\d+)', output)
        for m in matches:
            if not m.startswith('127.') and not m.startswith('169.254.'):
                return m
    except:
        pass
    
    return '127.0.0.1'

print(get_ip())
" 2>/dev/null
}

# ─── 检查是否运行中 ───
is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        else
            # PID 文件过期，清理
            rm -f "$PID_FILE"
            return 1
        fi
    fi
    return 1
}

get_pid() {
    if [ -f "$PID_FILE" ]; then
        cat "$PID_FILE"
    fi
}

# ─── 启动 ───
do_start() {
    if is_running; then
        local pid
        pid=$(get_pid)
        echo -e "${YELLOW}⚠  服务已在运行中 (PID: $pid)${NC}"
        echo -e "   如需重启请使用: ${CYAN}$0 restart${NC}"
        return 1
    fi

    echo -e "${CYAN}🚀 启动 $APP_NAME ...${NC}"

    # 检查端口占用
    local port_pid
    port_pid=$(lsof -ti:"$PORT" 2>/dev/null || true)
    if [ -n "$port_pid" ]; then
        echo -e "${YELLOW}⚠  端口 $PORT 被占用 (PID: $port_pid)，正在释放...${NC}"
        kill "$port_pid" 2>/dev/null || true
        sleep 1
    fi

    # 后台启动，日志输出到文件
    cd "$APP_DIR"
    nohup python3 "$SERVER_SCRIPT" >> "$LOG_FILE" 2>&1 &
    local new_pid=$!
    echo "$new_pid" > "$PID_FILE"

    # 等待启动确认
    sleep 1.5
    if is_running; then
        local lan_ip
        lan_ip=$(get_lan_ip)
        echo ""
        echo -e "${GREEN}${BOLD}  ✅ 服务启动成功！${NC}"
        echo -e "  ─────────────────────────────────────"
        echo -e "  ${BOLD}PID:${NC}        $new_pid"
        echo -e "  ${BOLD}访问地址:${NC}   ${CYAN}http://${lan_ip}:${PORT}${NC}"
        echo -e "  ${BOLD}日志文件:${NC}   $LOG_FILE"
        echo -e "  ─────────────────────────────────────"
        echo ""
    else
        echo -e "${RED}❌ 启动失败，请查看日志: ${NC}"
        echo -e "   ${CYAN}tail -20 $LOG_FILE${NC}"
        rm -f "$PID_FILE"
        return 1
    fi
}

# ─── 停止 ───
do_stop() {
    if ! is_running; then
        echo -e "${YELLOW}⚠  服务未运行${NC}"
        # 额外清理：端口可能被残留进程占用
        local port_pid
        port_pid=$(lsof -ti:"$PORT" 2>/dev/null || true)
        if [ -n "$port_pid" ]; then
            echo -e "   清理残留进程 (PID: $port_pid)..."
            kill "$port_pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
        return 0
    fi

    local pid
    pid=$(get_pid)
    echo -e "${CYAN}🛑 停止服务 (PID: $pid)...${NC}"

    # 优雅停止
    kill "$pid" 2>/dev/null || true

    # 等待进程退出（最多 5 秒）
    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
        sleep 0.5
        count=$((count + 1))
    done

    # 如果还在运行，强制 kill
    if kill -0 "$pid" 2>/dev/null; then
        echo -e "${YELLOW}   优雅停止超时，强制终止...${NC}"
        kill -9 "$pid" 2>/dev/null || true
        sleep 0.5
    fi

    rm -f "$PID_FILE"
    echo -e "${GREEN}✅ 服务已停止${NC}"
}

# ─── 重启 ───
do_restart() {
    echo -e "${CYAN}🔄 重启 $APP_NAME ...${NC}"
    do_stop
    sleep 0.5
    do_start
}

# ─── 状态 ───
do_status() {
    echo ""
    echo -e "  ${BOLD}📊 $APP_NAME 服务状态${NC}"
    echo -e "  ─────────────────────────────────────"

    if is_running; then
        local pid
        pid=$(get_pid)
        local lan_ip
        lan_ip=$(get_lan_ip)
        echo -e "  状态:     ${GREEN}${BOLD}● 运行中${NC}"
        echo -e "  PID:      $pid"
        echo -e "  端口:     $PORT"
        echo -e "  访问地址: ${CYAN}http://${lan_ip}:${PORT}${NC}"
        echo -e "  日志:     $LOG_FILE"
        
        # 显示进程信息
        local mem
        mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1f MB", $1/1024}')
        local uptime_info
        uptime_info=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)
        echo -e "  内存:     $mem"
        echo -e "  运行时间: $uptime_info"
    else
        echo -e "  状态:     ${RED}${BOLD}● 已停止${NC}"
    fi
    echo -e "  ─────────────────────────────────────"
    echo ""
}

# ─── 查看日志 ───
do_log() {
    local lines=${1:-50}
    if [ ! -f "$LOG_FILE" ]; then
        echo -e "${YELLOW}⚠  日志文件不存在${NC}"
        return 0
    fi
    echo -e "${CYAN}📋 最近 ${lines} 行日志 ($LOG_FILE):${NC}"
    echo ""
    tail -"$lines" "$LOG_FILE"
}

# ─── 实时日志 ───
do_follow() {
    if [ ! -f "$LOG_FILE" ]; then
        echo -e "${YELLOW}⚠  日志文件不存在，等待创建...${NC}"
    fi
    echo -e "${CYAN}📋 实时日志 (Ctrl+C 退出):${NC}"
    echo ""
    tail -f "$LOG_FILE" 2>/dev/null
}

# ─── 主入口 ───
case "${1:-}" in
    start)
        do_start
        ;;
    stop)
        do_stop
        ;;
    restart)
        do_restart
        ;;
    status|st)
        do_status
        ;;
    log)
        do_log "${2:-50}"
        ;;
    follow|tail)
        do_follow
        ;;
    *)
        echo ""
        echo -e "  ${BOLD}🎮 游戏资产管理服务器${NC}"
        echo ""
        echo -e "  用法: ${CYAN}$0 <command>${NC}"
        echo ""
        echo -e "  ${BOLD}命令:${NC}"
        echo -e "    ${GREEN}start${NC}     启动服务（后台运行）"
        echo -e "    ${RED}stop${NC}      停止服务"
        echo -e "    ${YELLOW}restart${NC}   重启服务"
        echo -e "    ${CYAN}status${NC}    查看服务状态"
        echo -e "    ${CYAN}log${NC} [n]   查看最近 n 行日志（默认 50）"
        echo -e "    ${CYAN}follow${NC}    实时跟踪日志"
        echo ""
        exit 1
        ;;
esac
