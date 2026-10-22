#!/usr/bin/env python3
"""Register the native host for Chrome and Brave on macOS."""
import argparse
import json
from pathlib import Path
import shlex
import shutil
import sys

from bridge import DEFAULT_STATE, HOST, ROOT, connect, extension_id
from policy_store import default_path


def default_host_dir():
    # BraveMainDelegate::PreSandboxStartup explicitly uses Chrome's locations
    # on macOS, independently of the Brave profile directory.
    return Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts"


def default_runtime_dir():
    return Path.home() / "Library/Application Support/LocalBrowserBridge"


def install(destination, state, python, runtime, host_name=HOST, policy_file=None):
    destination.mkdir(parents=True, exist_ok=True)
    connect(state).close()
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime.chmod(0o700)
    (runtime / "extension").mkdir(exist_ok=True, mode=0o700)
    for name in ["native_host.py", "bridge.py", "policy_store.py", "extension/manifest.json", "extension/protected-hosts.json"]:
        shutil.copyfile(ROOT / name, runtime / name)
        (runtime / name).chmod(0o600)
    log = runtime / "native-host.log"
    log.touch(mode=0o600, exist_ok=True)
    launcher = runtime / "native-host.sh"
    policy_file = Path(policy_file) if policy_file else (default_path() if state == DEFAULT_STATE else state.parent / "browser-policy.json")
    launcher.write_text("#!/bin/sh\nexec " + " ".join(shlex.quote(str(x)) for x in [
        python, runtime / "native_host.py", "--state-dir", state, "--policy-file", policy_file,
    ]) + ' "$@" 2>>' + shlex.quote(str(log)) + '\n')
    launcher.chmod(0o700)
    manifest = destination / (host_name + ".json")
    manifest.write_text(json.dumps({
        "name": host_name, "description": "Local Browser Bridge",
        "path": str(launcher.resolve()), "type": "stdio",
        "allowed_origins": ["chrome-extension://" + extension_id() + "/"],
    }, indent=2) + "\n")
    print("Native host:", manifest)
    print("Extension ID:", extension_id())
    print("Load unpacked:", ROOT / "extension")
    print("Native runtime:", runtime)
    print("Private queue:", state)
    print("Shared policy:", policy_file)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-dir", type=Path, default=default_host_dir())
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--runtime-dir", type=Path, default=default_runtime_dir())
    parser.add_argument("--policy-file", type=Path, help="Shared policy file used by every connected profile")
    args = parser.parse_args()
    if sys.platform != "darwin" and args.host_dir == parser.get_default("host_dir"):
        parser.error("Specify --host-dir for your browser on this OS")
    install(args.host_dir.expanduser().resolve(), args.state_dir.expanduser().absolute(),
            sys.executable, args.runtime_dir.expanduser().resolve(),
            policy_file=args.policy_file.expanduser().absolute() if args.policy_file else None)


if __name__ == "__main__":
    main()
