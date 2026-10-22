#!/usr/bin/env python3
"""Local, file-backed transport shared by the CLI and browser native host."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent
HOST = "com.mehtagent.browser_bridge"
# Browser-launched native hosts cannot assume access to Documents/Desktop.
# Persistent state survives agent exits, reconnects, and OS temporary cleanup.
DEFAULT_STATE = (Path.home() / "Library/Application Support/LocalBrowserBridge/state"
                 if sys.platform == "darwin" else Path.home() / ".local/state/mehtagent-browser-bridge")


def extension_id():
    manifest = json.loads((ROOT / "extension/manifest.json").read_text())
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return "".join(chr(97 + int(n, 16)) for n in digest)


def connect(state=DEFAULT_STATE):
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state.is_symlink() or state.stat().st_uid != os.getuid():
        raise PermissionError("Bridge state must be a directory owned by the current user, not a symlink")
    os.chmod(state, 0o700)
    path = state / "bridge.sqlite3"
    if path.is_symlink():
        raise PermissionError("Bridge database must not be a symlink")
    db = sqlite3.connect(str(path), timeout=5)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA secure_delete=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, heartbeat REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY, session TEXT NOT NULL, expires REAL NOT NULL,
            status TEXT NOT NULL, command TEXT NOT NULL, response TEXT
        );
        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY, epoch TEXT NOT NULL, session TEXT NOT NULL,
            label TEXT NOT NULL, heartbeat REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS leases (
            id TEXT PRIMARY KEY, connection TEXT NOT NULL, epoch TEXT NOT NULL,
            tab INTEGER NOT NULL, agent TEXT NOT NULL, expires REAL NOT NULL,
            released INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS active_tab_owner
            ON leases(connection, epoch, tab) WHERE released=0;
        CREATE TABLE IF NOT EXISTS journal (
            id TEXT PRIMARY KEY, connection TEXT NOT NULL, epoch TEXT NOT NULL,
            session TEXT NOT NULL, agent TEXT NOT NULL, target TEXT,
            action TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL,
            updated REAL NOT NULL, detail TEXT
        );
    """)
    with db:
        # Expired IPC bodies are discarded on any access, even after a crash.
        db.execute("UPDATE journal SET status=CASE status WHEN 'sent' THEN 'unknown' ELSE 'cancelled' END, updated=? "
                   "WHERE status IN ('pending','sent') AND id IN (SELECT id FROM requests WHERE expires<?)",
                   (time.time(), time.time()))
        db.execute("DELETE FROM requests WHERE expires<?", (time.time(),))
        # Older versions kept arbitrary browser exception text in the journal.
        db.execute("UPDATE journal SET detail='failure-detail-redacted' WHERE detail IS NOT NULL "
                   "AND detail NOT IN ('command-failed','command-not-executed','failure-detail-redacted')")
    return db


def sessions(db):
    return [dict(row) for row in db.execute(
        "SELECT * FROM sessions WHERE heartbeat > ? ORDER BY heartbeat DESC",
        (time.time() - 5,),
    )]


def register_connection(db, ident, epoch, session, label=""):
    if not ident or not epoch or len(ident) > 100 or len(epoch) > 100:
        raise ValueError("Invalid browser identity")
    with db:
        db.execute("INSERT OR REPLACE INTO connections VALUES (?, ?, ?, ?, ?)",
                   (ident, epoch, session, str(label)[:80], time.time()))


def connections(db, online_only=False):
    now = time.time()
    rows = [dict(r) for r in db.execute("SELECT * FROM connections ORDER BY label, id")]
    live = {r["id"] for r in sessions(db)}
    for row in rows:
        row["online"] = row["heartbeat"] > now - 5 and row["session"] in live
    return [r for r in rows if r["online"]] if online_only else rows


def acquire(db, connection, epoch, tab, agent, ttl=900):
    if not agent:
        raise ValueError("An explicit --agent ID is required")
    now = time.time()
    db.execute("BEGIN IMMEDIATE")
    try:
        old = db.execute("SELECT * FROM leases WHERE connection=? AND epoch=? AND tab=? AND released=0",
                         (connection, epoch, tab)).fetchone()
        if old and old["agent"] != agent and old["expires"] > now:
            raise RuntimeError("Tab is reserved by agent " + old["agent"])
        if old and old["agent"] == agent:
            ident = old["id"]
            db.execute("UPDATE leases SET expires=? WHERE id=?", (now + ttl, ident))
        else:
            if old:
                db.execute("UPDATE leases SET released=1 WHERE id=?", (old["id"],))
            ident = "t_" + uuid.uuid4().hex
            db.execute("INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?, 0)",
                       (ident, connection, epoch, tab, agent, now + ttl))
        db.commit()
        return dict(db.execute("SELECT * FROM leases WHERE id=?", (ident,)).fetchone())
    except Exception:
        db.rollback()
        raise


def validate_target(db, target, agent, connection, epoch, renew_until=None):
    db.execute("BEGIN IMMEDIATE")
    try:
        lease = db.execute("SELECT * FROM leases WHERE id=? AND released=0", (target,)).fetchone()
        if not lease or lease["agent"] != agent:
            raise RuntimeError("Target is missing, released, or owned by another agent; claim the tab explicitly")
        if lease["connection"] != connection or lease["epoch"] != epoch:
            raise RuntimeError("Browser identity changed; list tabs and claim the intended tab again")
        # An expired owner can resume only if nobody else has claimed the tab.
        if renew_until:
            db.execute("UPDATE leases SET expires=MAX(expires, ?) WHERE id=?", (renew_until, target))
        db.commit()
        return dict(lease)
    except Exception:
        db.rollback()
        raise


def recover(db, agent):
    now = time.time()
    live = {s["id"] for s in sessions(db)}
    with db:
        for row in db.execute("SELECT * FROM journal WHERE status IN ('pending','sent')").fetchall():
            request = db.execute("SELECT expires FROM requests WHERE id=?", (row["id"],)).fetchone()
            if row["session"] not in live or not request or request["expires"] < now:
                db.execute("UPDATE journal SET status=?, updated=? WHERE id=?",
                           ("unknown" if row["status"] == "sent" else "cancelled", now, row["id"]))
    active = {r["id"]: r for r in connections(db)}
    targets = [dict(r) for r in db.execute("SELECT * FROM leases WHERE agent=? AND released=0", (agent,))]
    for t in targets:
        c = active.get(t["connection"])
        t["recoverable"] = bool(c and c["online"] and c["epoch"] == t["epoch"])
        t["expired"] = t["expires"] < now
    ops = [dict(r) for r in db.execute("SELECT * FROM journal WHERE agent=? ORDER BY created DESC LIMIT 100", (agent,))]
    return {"agent": agent, "targets": targets, "operations": ops,
            "instruction": "Inspect any unknown outcome on the page before issuing a new action; no actions are replayed automatically."}


def claim(db, session):
    """Atomically claim one unexpired request, scoped to one browser connection."""
    now = time.time()
    with db:
        db.execute("DELETE FROM requests WHERE expires < ?", (now,))
        db.execute("DELETE FROM sessions WHERE heartbeat < ?", (now - 60,))
        db.execute("INSERT OR REPLACE INTO sessions VALUES (?, ?)", (session, now))
        row = db.execute(
            "SELECT * FROM requests WHERE session=? AND status='pending' AND expires>? "
            "ORDER BY rowid LIMIT 1", (session, now),
        ).fetchone()
        if row:
            changed = db.execute(
                "UPDATE requests SET status='sent' WHERE id=? AND status='pending'", (row["id"],)
            ).rowcount
            if changed:
                return dict(row)
    return None
