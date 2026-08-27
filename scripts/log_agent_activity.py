import os
from datetime import datetime

# Configuration
ACTIVITY_LOG = "logs/agent_activity.log"

def log_activity(message):
    """Logs a message representing the Agent's current task or thought process."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    os.makedirs(os.path.dirname(ACTIVITY_LOG), exist_ok=True)
    try:
        with open(ACTIVITY_LOG, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] {message}\n")
    except Exception:
        with open(ACTIVITY_LOG, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] {message}\n")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        log_activity(sys.argv[1])
