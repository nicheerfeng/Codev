"""构建待审核的正式 Windows 双包，不启动程序或上传。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from tqdm import tqdm


# 依次构建独立标识便携包与标准 NSIS 安装包，保留日志和校验值。
def main():
    root = Path(__file__).resolve().parents[3]
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    output = root / "artifacts" / f"Codev-{version}-Windows-x64"
    output.mkdir(parents=True, exist_ok=True)
    target = root / "src-tauri/target/pi-ui-rebuild"
    env = {**os.environ, "CARGO_BUILD_JOBS": "10", "CARGO_TARGET_DIR": str(target)}
    base = ["node", str(root / "node_modules/@tauri-apps/cli/tauri.js"), "build", "--features", "opaque-window"]
    checksums = []
    with tqdm(total=2, desc="Codev release", unit="package", ascii=True) as progress:
        for kind, extra in [("Portable", ["--no-bundle", "--config", "src-tauri/tauri.portable.conf.json"]), ("Setup", ["--bundles", "nsis"])]:
            progress.set_description(f"Codev {kind} (jobs=10)")
            with (output / f"{kind}-build.log").open("w", encoding="utf-8") as log:
                process = subprocess.Popen(base + extra, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if process.wait():
                    raise RuntimeError(f"{kind} build failed; see {log.name}")
            if kind == "Portable":
                source = target / "release/codev.exe"
            else:
                candidates = list((target / "release/bundle/nsis").glob(f"*{version}*setup.exe"))
                if len(candidates) != 1:
                    raise RuntimeError(f"Expected one installer: {candidates}")
                source = candidates[0]
            destination = output / f"Codev-{version}-Windows-x64-{kind}.exe"
            shutil.copy2(source, destination)
            digest = hashlib.sha256(destination.read_bytes()).hexdigest().upper()
            checksums.append(f"{digest}  {destination.name}")
            tqdm.write(f"{destination.name}: {destination.stat().st_size} bytes; {digest}")
            progress.update(1)
    shutil.copy2(root / "src/modules/plugins/pi-agent/UPSTREAM-NOTICES.md", output / "UPSTREAM-NOTICES.md")
    (output / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
