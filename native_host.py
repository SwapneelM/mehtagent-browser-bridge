#!/usr/bin/env python3
"""The browser starts this process. stdout carries native-messaging frames."""
import argparse
import json
import struct
import sys
import threading
import time
import uuid

from bridge import DEFAULT_STATE, acquire, claim, connect, extension_id, register_connection, validate_target

MAX_INBOUND = 64 * 1024 * 1024
MAX_OUTBOUND = 1024 * 1024


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            if not result:
                return None
            raise EOFError("Truncated native message")
        result.extend(part)
    return bytes(result)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack("=I", header)[0]
    if size > MAX_INBOUND:
        raise ValueError("Native message exceeds 64 MiB")
    data = read_exact(stream, size)
    if data is None:
        raise EOFError("Missing native message body")
    return json.loads(data)


def write_message(stream, value):
    data = json.dumps(value, separators=(",", ":")).encode()
    if len(data) > MAX_OUTBOUND:
        raise ValueError("Command exceeds native messaging's 1 MiB limit")
    stream.write(struct.pack("=I", len(data)) + data)
    stream.flush()


def serve(state):
    session = uuid.uuid4().hex
    stop = threading.Event()
    identified = threading.Event()
    identity = {}
    output_lock = threading.Lock()
    inflight = set()
    inflight_lock = threading.Lock()

    def send(value):
        with output_lock:
            write_message(sys.stdout.buffer, value)

    def finish(db, msg):
        record = db.execute("SELECT * FROM journal WHERE id=? AND session=?",
                            (msg.get("id"), session)).fetchone()
        row = db.execute("SELECT * FROM requests WHERE id=? AND session=?",
                         (msg.get("id"), session)).fetchone()
        if not record:
            return
        if msg.get("ok") and record["action"] in ("open", "claim"):
            try:
                current = db.execute("SELECT * FROM connections WHERE id=?", (record["connection"],)).fetchone()
                if not current or current["epoch"] != record["epoch"]:
                    raise RuntimeError("Browser identity changed during tab creation")
                lease = acquire(db, record["connection"], record["epoch"], msg["result"]["id"], record["agent"])
                msg["result"].update(target=lease["id"], connection=record["connection"], epoch=record["epoch"])
                with db:
                    db.execute("UPDATE journal SET target=? WHERE id=?", (lease["id"], record["id"]))
            except Exception as error:
                msg = {"type": "response", "id": record["id"], "ok": False, "error": str(error)}
        # A browser-side failure can follow a partial action (e.g. the page
        # navigated but the load check failed, or typing cleared an input first).
        readonly = record["action"] in ("tabs", "current", "read", "screenshot", "claim")
        status = "completed" if msg.get("ok") else ("unknown" if record["status"] in ("sent", "unknown") and not readonly and not msg.get("not_run") else "failed")
        if record["status"] == "resolved-completed":
            status = record["status"]
        elif record["status"] == "resolved-not-run":
            status = "unknown" # A late response invalidates an earlier not-run assumption.
        with db:
            # Outcomes survive caller exits. Full response bodies do not enter the journal.
            db.execute("UPDATE journal SET status=?, updated=?, detail=? WHERE id=?",
                       (status, time.time(), None if msg.get("ok") else str(msg.get("error"))[:400], record["id"]))
            if row:
                db.execute("UPDATE requests SET status='done', response=? WHERE id=?",
                           (json.dumps(msg), record["id"]))
        with inflight_lock:
            inflight.discard(record["id"])

    def dispatch():
        db = connect(state)
        try:
            send({"type": "connected", "session": session})
            while not stop.is_set():
                if not identified.wait(.2):
                    continue
                with db:
                    db.execute("UPDATE connections SET heartbeat=? WHERE id=? AND session=?",
                               (time.time(), identity["id"], session))
                    db.execute("INSERT OR REPLACE INTO sessions VALUES (?, ?)", (session, time.time()))
                with inflight_lock:
                    busy = bool(inflight)
                if busy:
                    stop.wait(.1)
                    continue
                row = claim(db, session)
                if row:
                    command = json.loads(row["command"])
                    try:
                        context = command["_bridge"]
                        current = db.execute("SELECT * FROM connections WHERE id=?", (context["connection"],)).fetchone()
                        if not current or current["session"] != session or current["epoch"] != context["epoch"]:
                            raise RuntimeError("Connection was replaced; recover before continuing")
                        if context.get("target"):
                            target = validate_target(db, context["target"], context["agent"], context["connection"],
                                                     context["epoch"], max(time.time() + 900, row["expires"] + 60))
                            command["tab"] = target["tab"]
                            if command["action"] not in ("read", "screenshot"):
                                unknown = db.execute(
                                    "SELECT j.id FROM journal j JOIN leases l ON j.target=l.id "
                                    "WHERE l.connection=? AND l.epoch=? AND l.tab=? AND j.status='unknown' LIMIT 1",
                                    (context["connection"], context["epoch"], target["tab"]),
                                ).fetchone()
                                if unknown:
                                    raise RuntimeError("Resolve uncertain operation " + unknown["id"] + " before another action")
                        elif command["action"] == "open":
                            unknown = db.execute("SELECT id FROM journal WHERE connection=? AND epoch=? AND agent=? "
                                                 "AND action='open' AND status='unknown' LIMIT 1",
                                                 (context["connection"], context["epoch"], context["agent"])).fetchone()
                            if unknown:
                                raise RuntimeError("Inspect tabs and resolve uncertain open operation " + unknown["id"])
                        with db:
                            db.execute("UPDATE journal SET status='sent', updated=? WHERE id=?", (time.time(), row["id"]))
                        with inflight_lock:
                            inflight.add(row["id"])
                        send({"type": "command", "id": row["id"], "expires": row["expires"], "command": command})
                    except Exception as error:
                        finish(db, {"type": "response", "id": row["id"], "ok": False, "error": str(error)})
                stop.wait(0.1 if row else 0.3)
        except (BrokenPipeError, OSError, ValueError):
            stop.set()
        finally:
            with db:
                db.execute("DELETE FROM sessions WHERE id=?", (session,))
                db.execute("UPDATE connections SET heartbeat=0 WHERE session=?", (session,))
                db.execute("UPDATE journal SET status='unknown', updated=? WHERE session=? AND status='sent'",
                           (time.time(), session))
            db.close()

    worker = threading.Thread(target=dispatch, daemon=True)
    worker.start()
    db = connect(state)
    try:
        while not stop.is_set():
            msg = read_message(sys.stdin.buffer)
            if msg is None:
                break
            if msg.get("type") == "identify" and not identified.is_set():
                identity.update(id=msg["connection"], epoch=msg["epoch"])
                register_connection(db, identity["id"], identity["epoch"], session, msg.get("label", ""))
                send({"type": "ready", "session": session, "connection": identity["id"], "epoch": identity["epoch"]})
                identified.set()
            elif msg.get("type") == "response":
                finish(db, msg)
    finally:
        stop.set()
        worker.join(timeout=2)
        db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE))
    parser.add_argument("origin")
    args = parser.parse_args()
    if args.origin != "chrome-extension://" + extension_id() + "/":
        parser.error("Unrecognized extension origin")
    serve(args.state_dir)


if __name__ == "__main__":
    try:
        main()
    except (EOFError, ValueError, BrokenPipeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
