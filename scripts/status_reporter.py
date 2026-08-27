import os
import shutil
import psutil
import time
import sys
from datetime import datetime

# Configuration
LOG_FILE = "logs/system_report.log"
AGENT_ACTIVITY_LOG = "logs/agent_activity.log"
INTERVAL = 600  # 10 minutes in seconds

def get_last_agent_activity():
    """Reads the last line from the agent activity log to see what the LLM was doing."""
    if not os.path.exists(AGENT_ACTIVITY_LOG):
        return "No recent activity logged."
    
    try:
        with open(AGENT_ACTIVITY_LOG, "r", encoding="utf-8") as f:
            lines = f.readlines()
            if not lines:
                return "No activity recorded."
            # Return the last non-empty line stripped of whitespace
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
        cpu_percent = psutil.cpu_percent(interval=1)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # Get LLM/Agent progress
        last_activity = get_last_agent_activity()
        
        return (f"[System & Agent Status Report]\n"
                f"⏰ Time: {timestamp}\n"
                f"🤖 Last Agent Activity: {last_activity}\n"
                f"💻 CPU: {cpu_percent}%\n"
                f"🧠 MEM: {mem_percent}%\n"
                f"💾 DISK: {disk_percent:.2f}% used\n")
    except Exception as e:
        return f"[Error] Error collecting stats: {str(e)}\n"

def main():
    if sys.platform == "win32":
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    print(f"System Status Reporter started. Logging to {LOG_FILE}")
    
    while True:
        report = get_system_status()
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {report}")
        
        print(report)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
