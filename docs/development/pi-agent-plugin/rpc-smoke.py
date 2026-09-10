"""只读验证本机 Pi RPC，不发送提示词、不写模型和会话。"""
import argparse
import json
import queue
import subprocess
import threading
from tqdm import tqdm


# 将严格 JSONL stdout 放入队列，等待时保持可超时。
def read_events(stream, events):
    for line in stream:
        try:
            events.put(json.loads(line))
        except json.JSONDecodeError:
            continue


# 通过本机 CLI 验证面板使用的只读命令及响应字段。
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pi-cli", required=True)
    args = parser.parse_args()
    process = subprocess.Popen(
        ["node", args.pi_cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    events = queue.Queue()
    threading.Thread(target=read_events, args=(process.stdout, events), daemon=True).start()
    commands = ["get_state", "get_messages", "get_available_models", "get_available_thinking_levels", "get_session_stats"]
    try:
        for command in tqdm(commands, desc="Pi RPC read-only", ascii=True):
            process.stdin.write(json.dumps({"id": command, "type": command}) + "\n")
            process.stdin.flush()
            while True:
                event = events.get(timeout=45)
                if event.get("type") == "response" and event.get("id") == command:
                    if not event.get("success"):
                        raise RuntimeError(f"{command} failed: {event.get('error')}")
                    data = event.get("data", {})
                    print(command, "OK", "keys=" + ",".join(data) if isinstance(data, dict) else type(data).__name__)
                    break
    finally:
        process.terminate()
        process.wait(timeout=10)


if __name__ == "__main__":
    main()
