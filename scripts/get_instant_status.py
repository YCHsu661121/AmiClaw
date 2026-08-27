import os
import shutil
import psutil
import sys
from datetime import datetime

# Configuration
AGENT_ACTIVITY_LOG = "logs/agent_activity.log"

def get_last_agent_activity():
    """Reads the last line from the agent activity log to see what the LLM was doing."""
    if not os.path.exists(AGENT_ACTIVITY_LOG):
        return "No recent activity logged."
    
    try:
        with open(AGENT_ACTIVITY_LOG, "r", encoding="utf-8") as f:
            lines = f.readlines()
            if not lines:
                return "No activity recorded."
            for line in reversed(lines):
                clean_line = line.strip()
                if clean_line:
                    return clean_line
        return "No recent activity logged."
    except Exception as e:
        return f"Error reading activity log: {str(e)}"

def get_system_status():
    try:
        total, used, free = shutil.disk_usage("/")
        disk_percent = (used / total) * 100
        memory = psutil.virtual_memory()
        mem_percent = memory.percent
        cpu_percent = psutil.cpu_percent(interval=0.5) # Shorter interval for instant response
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        last_activity = get_last_agent_activity()
        
        return (f"📊 *Instant System & Agent Status*\n"
                f"⏰ Time: {timestamp}\n"
                f"🤖 Last Agent Activity: {last_activity}\n"
                f"💻 CPU: {cpu_percent}%\n"
                f"🧠 MEM: {mem_percent}%\n"
                f"💾 DISK: {disk_percent:.2f}% used\n")
    except Exception as e:
        return f"❌ Error collecting stats: {str(e)}\n"

if __name__ == "__main__":
    # Ensure UTF-8 for Windows environments
    if sys.platform == "win32":
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
        
    print(get_system_status())
