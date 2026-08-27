import os
import sys
from datetime import datetime

# Configuration
TODO_FILE = "ToDo.md"
ACTIVITY_LOG = "logs/agent_activity.log"

def log_activity(message):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    os.makedirs(os.path.dirname(ACTIVITY_LOG), exist_ok=True)
    with open(ACTIVITY_LOG, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] {message}\n")

def cleanup_todo():
    if not os.path.exists(TODO_FILE):
        return "Todo file not found."

    with open(TODO_FILE, "r", encoding="utf-8") as f:
        lines = f.readlines()

    new_lines = []
    completed_count = 0
    removed_count = 0

    for line in lines:
        # Check if task is marked as done [x]
        if line.strip().startswith("- [x]"):
            completed_count += 1
            # We keep it but we could also 'remove' it by not adding to new_lines
            # However, for visibility, let's just mark completed tasks as 'archived' or removed
            removed_count += 1
            log_activity(f"Auto-cleaned completed task: {line.strip()}")
            continue 
        new_lines.append(line)

    with open(TODO_FILE, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

    return f"Cleanup complete. Removed {removed_count} completed tasks. {completed_count} were tracked."

if __name__ == "__main__":
    log_activity("Running Auto-Todo Cleanup Task")
    result = cleanup_todo()
    print(result)
