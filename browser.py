#!/usr/bin/env python3
"""Control the browser profile where the Local Browser Bridge is connected."""
import argparse
import base64
import json
import mimetypes
import hashlib
from pathlib import Path
import sys
import time
import uuid

from bridge import DEFAULT_STATE, connect, connections, recover, validate_target
from policy_store import MAX_BYTES, default_path as default_policy_path, decode as decode_policy, snapshot as policy_snapshot


def request(command, state=DEFAULT_STATE, session=None, timeout=30, agent=None,
            connection=None, request_id=None):
    db = connect(state)
    ident = request_id or uuid.uuid4().hex
    inserted = False
    try:
        command = dict(command)
        action = command["action"]
        if action == "upload":
            files = []; total = 0
            for value in command.get("files", []):
                path = Path(value).expanduser().resolve(strict=True)
                if not path.is_file() or path.stat().st_size > 500000:
                    raise ValueError("Upload supports regular files up to 500 KB total")
                data = path.read_bytes(); total += len(data)
                if total > 500000: raise ValueError("Upload supports up to 500 KB total")
                files.append({"name": path.name, "type": mimetypes.guess_type(path.name)[0] or "application/octet-stream", "sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode()})
            command["files"] = files
        if action not in ("tabs", "current") and not agent:
            raise ValueError("Use an explicit --agent ID for tab ownership and recovery")
        target = None
        if "tab" in command and action != "claim":
            target = db.execute("SELECT * FROM leases WHERE id=? AND released=0", (str(command["tab"]),)).fetchone()
            if not target:
                raise RuntimeError("Use claim TAB_ID first, then pass the returned t_ target ID")
            if target["agent"] != agent:
                raise RuntimeError("Target belongs to another agent")
            if connection and not target["connection"].startswith(connection):
                raise RuntimeError("Target belongs to a different browser connection")
            connection = target["connection"]
        active = connections(db, online_only=True)
        if connection:
            active = [s for s in active if s["id"].startswith(connection)]
        if session:
            active = [s for s in active if s["session"].startswith(session)]
        if len(active) != 1:
            raise RuntimeError(
                "No connected browser profile. Click the extension and Connect."
                if not active else "Multiple profiles connected; select one with --connection ID."
            )
        c = active[0]
        if target:
            validate_target(db, target["id"], agent, c["id"], c["epoch"])
            if action not in ("read", "screenshot"):
                uncertain = db.execute(
                    "SELECT j.id FROM journal j JOIN leases l ON j.target=l.id "
                    "WHERE l.connection=? AND l.epoch=? AND l.tab=? AND j.status='unknown' LIMIT 1",
                    (c["id"], c["epoch"], target["tab"]),
                ).fetchone()
                if uncertain:
                    raise RuntimeError("Inspect the page, then resolve uncertain operation " + uncertain["id"] + " before another action")
        command["_bridge"] = {"connection": c["id"], "epoch": c["epoch"], "agent": agent or "",
                              "target": target["id"] if target else None}
        expires = time.time() + timeout
        encoded = json.dumps(command)
        if len(encoded.encode()) > 1000000:
            raise ValueError("Command too large")
        with db:
            old = db.execute("SELECT status FROM journal WHERE id=?", (ident,)).fetchone()
            if old:
                raise RuntimeError("Request ID already recorded as " + old["status"] + "; recover and inspect before issuing a new action")
            db.execute("INSERT INTO journal VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)",
                       (ident, c["id"], c["epoch"], c["session"], agent or "", target["id"] if target else None,
                        action, time.time(), time.time()))
            db.execute("INSERT INTO requests VALUES (?, ?, ?, 'pending', ?, NULL)",
                       (ident, c["session"], expires, encoded))
            inserted = True
        while time.time() < expires:
            row = db.execute("SELECT * FROM requests WHERE id=?", (ident,)).fetchone()
            if row and row["status"] == "done":
                reply = json.loads(row["response"])
                if not reply.get("ok"):
                    raise RuntimeError(reply.get("error", "Browser command failed"))
                return reply.get("result")
            time.sleep(0.1)
        raise TimeoutError("Browser command timed out. Operation " + ident +
                           ": run recover with the same --agent ID; inspect before retrying.")
    finally:
        if inserted:
            with db:
                row = db.execute("SELECT status FROM requests WHERE id=?", (ident,)).fetchone()
                if row and row["status"] in ("pending", "sent"):
                    db.execute("UPDATE journal SET status=?, updated=? WHERE id=? AND status IN ('pending','sent')",
                               ("unknown" if row["status"] == "sent" else "cancelled", time.time(), ident))
                db.execute("DELETE FROM requests WHERE id=?", (ident,))
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE))
    parser.add_argument("--session", help="Ephemeral native-host transport ID; prefer --connection for recovery")
    parser.add_argument("--connection", help="Persistent browser/profile connection ID or unique prefix")
    parser.add_argument("--agent", help="Stable logical agent/task ID; reuse it after an interruption")
    parser.add_argument("--request-id", help="Unique operation ID; repeated IDs are never executed again")
    parser.add_argument("--timeout", type=float, default=30)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("policy", help="Read or validate the same local policy used by every agent")
    p.add_argument("operation", choices=["show", "validate", "example"], nargs="?", default="show")
    p.add_argument("file", nargs="?", help="Policy path; MEHTAGENT_BROWSER_POLICY overrides the default")
    sub.add_parser("status")
    sub.add_parser("tabs")
    sub.add_parser("current")
    sub.add_parser("recover")
    p = sub.add_parser("claim"); p.add_argument("tab", type=int)
    p = sub.add_parser("release"); p.add_argument("target")
    p = sub.add_parser("resolve"); p.add_argument("operation"); p.add_argument("outcome", choices=["completed", "not-run"])
    p = sub.add_parser("open"); p.add_argument("url"); p.add_argument("--foreground", action="store_true", help="Explicitly activate the new tab and its window")
    for action in ["activate", "close", "read", "screenshot", "eval", "navigate", "click", "type", "key", "scroll", "upload", "cdp"]:
        p = sub.add_parser(action)
        p.add_argument("tab", help="Owned t_ target ID from open or claim")
        if action == "screenshot":
            p.add_argument("output"); p.add_argument("--full-page", action="store_true")
        if action == "eval": p.add_argument("expression")
        if action == "navigate": p.add_argument("url")
        if action in ["click", "type", "upload"]: p.add_argument("selector", **({"nargs":"?"} if action=="click" else {}))
        if action in ("read", "scroll"): p.add_argument("--selector", help="CSS selector; use ' >>> ' to enter an open shadow root or same-origin frame")
        if action in ("read", "click"):
            p.add_argument("--role", help="Exact DOM/ARIA role")
            p.add_argument("--name", help="Exact DOM accessible name")
        if action == "read":
            p.add_argument("--offset", type=int, default=0)
            p.add_argument("--limit", type=int, default=20000)
            p.add_argument("--element-offset", type=int, default=0)
            p.add_argument("--element-limit", type=int, default=180)
            p.add_argument("--html", action="store_true", help="Include bounded sanitized HTML")
        if action == "type":
            p.add_argument("text"); p.add_argument("--append", action="store_true")
        if action == "key":
            p.add_argument("key"); p.add_argument("--modifiers", type=int, default=0,
                                                  help="CDP bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8")
        if action == "scroll":
            p.add_argument("y", type=int); p.add_argument("--x", type=int, default=0)
        if action == "upload": p.add_argument("files", nargs="+")
        if action == "cdp":
            p.add_argument("method"); p.add_argument("params", nargs="?", default="{}")
    args = parser.parse_args()
    if args.action == "policy":
        policy_path = Path(args.file).expanduser() if args.file else default_policy_path()
        if args.operation == "example":
            print((Path(__file__).parent / "browser-policy.example.json").read_text())
        elif args.operation == "validate":
            with policy_path.open("rb") as stream:
                document = decode_policy(stream.read(MAX_BYTES + 1))
            print(json.dumps({"valid": True, "policy": document}, indent=2))
        else:
            print(json.dumps(policy_snapshot(policy_path), indent=2))
        return
    if args.action in ("status", "recover", "release", "resolve"):
        db = connect(args.state_dir)
        try:
            if args.action == "status":
                result = {"connections": connections(db)}
            else:
                if not args.agent:
                    parser.error("--agent is required")
                if args.action == "recover":
                    result = recover(db, args.agent)
                elif args.action == "release":
                    with db:
                        # An action already in flight must be reconciled before another owner acts.
                        busy = db.execute("SELECT id FROM journal WHERE target=? AND status IN ('sent','unknown') LIMIT 1", (args.target,)).fetchone()
                        if busy:
                            raise RuntimeError("Resolve operation " + busy["id"] + " before releasing this target")
                        count = db.execute("UPDATE leases SET released=1 WHERE id=? AND agent=? AND released=0",
                                           (args.target, args.agent)).rowcount
                    if not count:
                        raise RuntimeError("Target is missing or owned by another agent")
                    result = {"released": args.target}
                else:
                    with db:
                        count = db.execute("UPDATE journal SET status=?, updated=? WHERE id=? AND agent=? AND status='unknown'",
                                           ("resolved-" + args.outcome, time.time(), args.operation, args.agent)).rowcount
                    if not count:
                        raise RuntimeError("Unknown operation not found for this agent")
                    result = {"operation": args.operation, "outcome": args.outcome}
            print(json.dumps(result, indent=2))
        finally:
            db.close()
        return
    command = vars(args).copy()
    for key in ["state_dir", "session", "timeout", "output", "agent", "connection", "request_id"]:
        command.pop(key, None)
    if args.action == "upload":
        command["files"] = [str(Path(f).expanduser().resolve(strict=True)) for f in args.files]
    if args.action == "cdp": command["params"] = json.loads(args.params)
    result = request(command, args.state_dir, args.session, args.timeout, args.agent, args.connection, args.request_id)
    if args.action == "screenshot":
        path = Path(args.output).expanduser()
        path.write_bytes(base64.b64decode(result["data"]))
        print(json.dumps({"screenshot": str(path.resolve())}))
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, TimeoutError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
