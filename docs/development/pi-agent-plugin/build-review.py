"""10 并发构建 Pi UI 便携审核包，禁止启动应用。"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
from tqdm import tqdm


# 构建当前源码并输出带轮次、哈希和许可的审核目录。
def main():
    root = Path(__file__).resolve().parents[3]
    target = root / "src-tauri/target/pi-ui-r16-clean"
    env = {**os.environ, "CARGO_BUILD_JOBS": "10", "CARGO_TARGET_DIR": str(target)}
    output = root / "artifacts/Codev-PiAgent-UI-r16"
    output.mkdir(parents=True, exist_ok=True)
    args = ["node", str(root / "node_modules/@tauri-apps/cli/tauri.js"), "build", "--no-bundle", "--config", "src-tauri/tauri.portable.conf.json", "--features", "opaque-window"]
    tail = []
    with tqdm(total=3, desc="Pi UI portable", unit="stage", ascii=True) as progress:
        process = subprocess.Popen(args, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        with (output / "build.log").open("w", encoding="utf-8") as log:
            for line in process.stdout:
                log.write(line)
                tail = (tail + [line])[-60:]
                if "built in" in line and progress.n == 0:
                    progress.update(1)
                    progress.set_description("Pi UI Rust (jobs=10)")
                if "Finished" in line and "release" in line:
                    progress.update(2 - progress.n)
                if "error" in line.lower():
                    tqdm.write(line.strip())
        if process.wait():
            raise RuntimeError("".join(tail))
        source = target / "release/codev.exe"
        binary = output / "Codev-0.9.1-PiAgent-UI-r16-Windows-x64-Portable.exe"
        shutil.copy2(source, binary)
        shutil.copy2(root / "src/modules/plugins/pi-agent/UPSTREAM-NOTICES.md", output / "UPSTREAM-NOTICES.md")
        digest = hashlib.sha256(binary.read_bytes()).hexdigest().upper()
        (output / "SHA256SUMS.txt").write_text(f"{digest}  {binary.name}\n", encoding="utf-8")
        progress.update(3 - progress.n)
    print(f"Artifact: {binary}\nSize: {binary.stat().st_size}\nSHA256: {digest}")


if __name__ == "__main__":
    main()
