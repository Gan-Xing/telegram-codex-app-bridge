#!/usr/bin/env python3
import argparse
import base64
import json
import os
import subprocess
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run chat-to-codex bootstrap on a remote Mac over SSH.")
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--repo-url", default="https://github.com/Gan-Xing/telegram-codex-app-bridge.git")
    parser.add_argument("--repo-ref", default="main")
    parser.add_argument("--install-dir", default="~/telegram-codex-app-bridge")
    parser.add_argument("--default-cwd", required=True)
    parser.add_argument("--tg-bot-token", required=True)
    parser.add_argument("--tg-allowed-user-id", required=True)
    parser.add_argument("--tg-allowed-chat-id")
    parser.add_argument("--tg-allowed-topic-id")
    parser.add_argument("--code-approval-policy", default="on-request")
    parser.add_argument("--default-sandbox-mode", default="workspace-write")
    parser.add_argument("--node-major", type=int, default=24)
    parser.add_argument("--no-start", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    script_path = os.path.join(os.path.dirname(__file__), "bootstrap_host.py")
    with open(script_path, "rb") as handle:
        script_bytes = handle.read()

    payload = {
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
    payload_b64 = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")

    command = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        args.ssh_host,
        "python3",
        "-",
        "--config-b64",
        payload_b64,
    ]
    result = subprocess.run(command, input=script_bytes)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
