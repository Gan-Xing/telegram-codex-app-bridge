#!/usr/bin/env python3
import argparse
import base64
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


REPO_URL_DEFAULT = "https://github.com/Gan-Xing/telegram-codex-app-bridge.git"
REPO_REF_DEFAULT = "main"
NODE_INDEX_URL = "https://nodejs.org/dist/index.json"
NODE_MAJOR_DEFAULT = 24


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bootstrap telegram-codex-app-bridge on macOS.")
    parser.add_argument("--config-b64")
    parser.add_argument("--repo-url")
    parser.add_argument("--repo-ref")
    parser.add_argument("--install-dir")
    parser.add_argument("--default-cwd")
    parser.add_argument("--tg-bot-token")
    parser.add_argument("--tg-allowed-user-id")
    parser.add_argument("--tg-allowed-chat-id")
    parser.add_argument("--tg-allowed-topic-id")
    parser.add_argument("--code-approval-policy")
    parser.add_argument("--default-sandbox-mode")
    parser.add_argument("--node-major", type=int)
    parser.add_argument("--no-start", action="store_const", const=True, default=None)
    return parser.parse_args()


def merged_config(args: argparse.Namespace) -> dict:
    defaults = {
        "repo_url": REPO_URL_DEFAULT,
        "repo_ref": REPO_REF_DEFAULT,
        "install_dir": os.path.expanduser("~/telegram-codex-app-bridge"),
        "default_cwd": os.path.expanduser("~/telegram-codex-app-bridge"),
        "tg_bot_token": None,
        "tg_allowed_user_id": None,
        "tg_allowed_chat_id": None,
        "tg_allowed_topic_id": None,
        "code_approval_policy": "on-request",
        "default_sandbox_mode": "workspace-write",
        "node_major": NODE_MAJOR_DEFAULT,
        "no_start": False,
    }
    if args.config_b64:
        payload = json.loads(base64.b64decode(args.config_b64).decode("utf-8"))
        defaults.update(payload)
    cli = {
        "repo_url": args.repo_url,
        "repo_ref": args.repo_ref,
        "install_dir": args.install_dir,
        "default_cwd": args.default_cwd,
        "tg_bot_token": args.tg_bot_token,
        "tg_allowed_user_id": args.tg_allowed_user_id,
        "tg_allowed_chat_id": args.tg_allowed_chat_id,
        "tg_allowed_topic_id": args.tg_allowed_topic_id,
        "code_approval_policy": args.code_approval_policy,
        "default_sandbox_mode": args.default_sandbox_mode,
        "node_major": args.node_major,
        "no_start": args.no_start,
    }
    for key, value in cli.items():
        if value is not None:
            defaults[key] = value
    defaults["install_dir"] = os.path.abspath(os.path.expanduser(defaults["install_dir"]))
    defaults["default_cwd"] = os.path.abspath(os.path.expanduser(defaults["default_cwd"]))
    defaults["node_major"] = int(defaults["node_major"])
    defaults["no_start"] = bool(defaults["no_start"])
    return defaults


def require(value: str, name: str) -> str:
    if value is None or str(value).strip() == "":
        raise SystemExit(f"{name} is required")
    return str(value).strip()


def log(message: str) -> None:
    print(f"[chat-to-codex] {message}", flush=True)


def run(cmd, env=None, cwd=None, check=True, capture_output=False) -> subprocess.CompletedProcess:
    kwargs = {
        "env": env,
        "cwd": cwd,
        "check": check,
        "text": True,
    }
    if capture_output:
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
    return subprocess.run(cmd, **kwargs)


def command_output(cmd, env=None, cwd=None) -> str:
    result = run(cmd, env=env, cwd=cwd, capture_output=True)
    return result.stdout.rstrip()


def detect_arch() -> tuple:
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        return "osx-arm64-tar", "darwin-arm64"
    if machine in ("x86_64", "amd64"):
        return "osx-x64-tar", "darwin-x64"
    raise SystemExit(f"Unsupported macOS architecture: {machine}")


def ensure_local_node(node_major: int, tools_root: str) -> str:
    file_key, archive_suffix = detect_arch()
    os.makedirs(tools_root, exist_ok=True)
    with urllib.request.urlopen(NODE_INDEX_URL) as response:
        releases = json.load(response)
    selected = None
    for release in releases:
        version = str(release.get("version", ""))
        if not version.startswith(f"v{node_major}."):
            continue
        files = set(release.get("files", []))
        if file_key in files:
            selected = version
            break
    if selected is None:
        raise SystemExit(f"Unable to find a Node.js v{node_major} macOS build")

    install_root = os.path.join(tools_root, f"node-{selected}-{archive_suffix}")
    node_bin = os.path.join(install_root, "bin", "node")
    if os.path.exists(node_bin):
        return install_root

    url = f"https://nodejs.org/dist/{selected}/node-{selected}-{archive_suffix}.tar.gz"
    log(f"Installing Node.js {selected} into {install_root}")
    with urllib.request.urlopen(url) as response:
        data = response.read()
    parent_dir = os.path.dirname(install_root)
    os.makedirs(parent_dir, exist_ok=True)
    with tempfile.NamedTemporaryFile(delete=False) as archive_file:
        archive_file.write(data)
        archive_path = archive_file.name
    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            tar.extractall(parent_dir)
    finally:
        os.unlink(archive_path)
    if not os.path.exists(node_bin):
        raise SystemExit(f"Node install failed: {node_bin} not found")
    return install_root


def parse_major(version_text: str) -> int:
    version = version_text.strip().lstrip("v")
    return int(version.split(".", 1)[0])


def ensure_node(config: dict, tools_root: str) -> tuple:
    system_node = shutil.which("node")
    if system_node:
        try:
            version = command_output([system_node, "-v"])
            if parse_major(version) >= config["node_major"]:
                return system_node, os.path.dirname(system_node)
        except Exception:
            pass

    install_root = ensure_local_node(config["node_major"], os.path.join(tools_root, "node"))
    node_bin_dir = os.path.join(install_root, "bin")
    return os.path.join(node_bin_dir, "node"), node_bin_dir


def ensure_codex(env: dict, tools_root: str) -> str:
    existing = shutil.which("codex", path=env.get("PATH"))
    if existing:
        return existing

    npm_global = os.path.join(tools_root, "npm-global")
    os.makedirs(npm_global, exist_ok=True)
    install_env = env.copy()
    install_env["NPM_CONFIG_PREFIX"] = npm_global
    install_env["PATH"] = os.path.join(npm_global, "bin") + os.pathsep + install_env["PATH"]
    log("Installing Codex CLI with npm")
    run(["npm", "install", "-g", "@openai/codex"], env=install_env)
    codex_bin = os.path.join(npm_global, "bin", "codex")
    if not os.path.exists(codex_bin):
        raise SystemExit(f"Codex CLI install failed: {codex_bin} not found")
    env["PATH"] = os.path.join(npm_global, "bin") + os.pathsep + env["PATH"]
    return codex_bin


def ensure_codex_wrapper(codex_bin: str, node_bin_dir: str, tools_root: str) -> str:
    wrapper_dir = os.path.join(tools_root, "bin")
    os.makedirs(wrapper_dir, exist_ok=True)
    wrapper_path = os.path.join(wrapper_dir, "codex-wrapper")
    wrapper = "\n".join([
        "#!/bin/sh",
        f'export PATH="{node_bin_dir}:{os.path.dirname(codex_bin)}:$PATH"',
        f'exec "{codex_bin}" "$@"',
        "",
    ])
    with open(wrapper_path, "w", encoding="utf-8") as handle:
        handle.write(wrapper)
    os.chmod(wrapper_path, 0o755)
    return wrapper_path


def ensure_repo(config: dict) -> None:
    install_dir = config["install_dir"]
    parent_dir = os.path.dirname(install_dir)
    os.makedirs(parent_dir, exist_ok=True)
    git_dir = os.path.join(install_dir, ".git")
    if not os.path.isdir(git_dir):
        log(f"Cloning bridge repo into {install_dir}")
        run([
            "git",
            "clone",
            "--depth",
            "1",
            "--branch",
            config["repo_ref"],
            config["repo_url"],
            install_dir,
        ])
        return

    status = command_output(["git", "-C", install_dir, "status", "--porcelain"])
    if status:
        allowed = {".env", "dist/", "dist", "package-lock.json"}
        lines = [line for line in status.splitlines() if line.strip()]
        paths = [line[3:] for line in lines if len(line) >= 4]
        if any(path not in allowed for path in paths):
            raise SystemExit(f"Refusing to update dirty repo: {install_dir}")
        if any(path == "package-lock.json" for path in paths):
            run(["git", "-C", install_dir, "checkout", "--", "package-lock.json"])
        shutil.rmtree(os.path.join(install_dir, "dist"), ignore_errors=True)
        env_path = os.path.join(install_dir, ".env")
        if os.path.exists(env_path):
            os.remove(env_path)
    log(f"Updating bridge repo in {install_dir}")
    run(["git", "-C", install_dir, "remote", "set-url", "origin", config["repo_url"]])
    run(["git", "-C", install_dir, "fetch", "origin", config["repo_ref"], "--depth", "1"])
    run(["git", "-C", install_dir, "checkout", "-B", "chat-to-codex-deploy", "FETCH_HEAD"])


def write_env_file(config: dict, codex_bin: str) -> str:
    env_path = os.path.join(config["install_dir"], ".env")
    lines = [
        f"TG_BOT_TOKEN={config['tg_bot_token']}",
        f"TG_ALLOWED_USER_ID={config['tg_allowed_user_id']}",
        f"TG_ALLOWED_CHAT_ID={config['tg_allowed_chat_id'] or ''}",
        f"TG_ALLOWED_TOPIC_ID={config['tg_allowed_topic_id'] or ''}",
        "CODEX_APP_AUTOLAUNCH=true",
        f"CODEX_APP_LAUNCH_CMD={codex_bin} app",
        "CODEX_APP_SYNC_ON_OPEN=true",
        "CODEX_APP_SYNC_ON_TURN_COMPLETE=false",
        "STORE_PATH=",
        "LOG_LEVEL=info",
        f"DEFAULT_CWD={config['default_cwd']}",
        f"DEFAULT_APPROVAL_POLICY={config['code_approval_policy']}",
        f"DEFAULT_SANDBOX_MODE={config['default_sandbox_mode']}",
        "TELEGRAM_POLL_INTERVAL_MS=1200",
        "TELEGRAM_PREVIEW_THROTTLE_MS=800",
        "THREAD_LIST_LIMIT=10",
        f"CODEX_CLI_BIN={codex_bin}",
    ]
    with open(env_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.chmod(env_path, 0o600)
    return env_path


def check_codex_login(codex_bin: str, env: dict) -> str:
    try:
        result = run([codex_bin, "login", "status"], env=env, capture_output=True)
        output = (result.stdout or "").strip()
        return output or "Codex login status returned no output"
    except subprocess.CalledProcessError as error:
        combined = "\n".join(part for part in [error.stdout, error.stderr] if part)
        return combined.strip() or "Codex login status failed"


def install_bridge(config: dict, env: dict) -> None:
    install_dir = config["install_dir"]
    log("Installing npm dependencies")
    run(["npm", "ci"], env=env, cwd=install_dir)
    log("Building bridge")
    run(["npm", "run", "build"], env=env, cwd=install_dir)
    log("Running doctor checks")
    run(["npm", "run", "doctor"], env=env, cwd=install_dir)


def maybe_install_launchd(config: dict, env: dict) -> bool:
    if config["no_start"]:
        log("Skipping launchd install because --no-start was set")
        return False
    log("Installing launchd service")
    run(["bash", "scripts/launchd/install.sh"], env=env, cwd=config["install_dir"])
    return True


def main() -> None:
    if platform.system() != "Darwin":
        raise SystemExit("This bootstrap currently supports macOS only")

    args = parse_args()
    config = merged_config(args)
    config["tg_bot_token"] = require(config["tg_bot_token"], "TG_BOT_TOKEN")
    config["tg_allowed_user_id"] = require(config["tg_allowed_user_id"], "TG_ALLOWED_USER_ID")
    os.makedirs(config["default_cwd"], exist_ok=True)

    tools_root = os.path.expanduser("~/.local/chat-to-codex")
    node_bin, node_bin_dir = ensure_node(config, tools_root)
    env = os.environ.copy()
    env["PATH"] = node_bin_dir + os.pathsep + env.get("PATH", "")
    npm_global_bin = os.path.join(tools_root, "npm-global", "bin")
    if os.path.isdir(npm_global_bin):
        env["PATH"] = npm_global_bin + os.pathsep + env["PATH"]

    installed_codex_bin = ensure_codex(env, tools_root)
    codex_dir = os.path.dirname(installed_codex_bin)
    env["PATH"] = codex_dir + os.pathsep + env["PATH"]
    codex_bin = ensure_codex_wrapper(installed_codex_bin, node_bin_dir, tools_root)

    ensure_repo(config)
    env_path = write_env_file(config, codex_bin)
    install_bridge(config, env)
    started = maybe_install_launchd(config, env)
    login_status = check_codex_login(codex_bin, env)

    summary = {
        "installDir": config["install_dir"],
        "envPath": env_path,
        "defaultCwd": config["default_cwd"],
        "nodeBin": node_bin,
        "codexBin": codex_bin,
        "started": started,
        "loginStatus": login_status,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
