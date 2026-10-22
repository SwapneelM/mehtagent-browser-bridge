import io
import json
from pathlib import Path
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from bridge import acquire, claim, connect, connections, extension_id, recover, register_connection, sessions, validate_target
from browser import request
from install import default_host_dir, install
from native_host import read_message, write_message


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state"
        self.db = connect(self.state)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def online(self, ident="b_test", epoch="epoch", session="transport"):
        claim(self.db, session)
        register_connection(self.db, ident, epoch, session)

    def test_framing_handles_fragmented_reads(self):
        class Fragmented(io.BytesIO):
            def read(self, n=-1):
                return super().read(min(n, 2))
        out = io.BytesIO()
        write_message(out, {"hello": "हैलो"})
        self.assertEqual(read_message(Fragmented(out.getvalue())), {"hello": "हैलो"})
        self.assertIsNone(read_message(io.BytesIO()))

    def test_truncated_and_oversized_frames_fail(self):
        for data in [b"\x00\x01", struct.pack("=I", 4) + b"{}"]:
            with self.assertRaises(EOFError):
                read_message(io.BytesIO(data))
        with self.assertRaises(ValueError):
            read_message(io.BytesIO(struct.pack("=I", 64 * 1024 * 1024 + 1)))

    def test_expired_commands_never_dispatch(self):
        with self.db:
            self.db.execute("INSERT INTO requests VALUES ('old','profile',?,'pending','{}',NULL)",
                            (time.time() - 1,))
        self.assertIsNone(claim(self.db, "profile"))
        self.assertEqual(self.db.execute("SELECT count(*) FROM requests").fetchone()[0], 0)

    def test_other_profile_cannot_claim_and_no_duplicate_claim(self):
        with self.db:
            self.db.execute("INSERT INTO requests VALUES ('req','A',?,'pending','{}',NULL)",
                            (time.time() + 10,))
        self.assertIsNone(claim(self.db, "B"))
        self.assertEqual(claim(self.db, "A")["id"], "req")
        self.assertIsNone(claim(self.db, "A"))

    def test_no_silent_profile_selection(self):
        with self.assertRaisesRegex(RuntimeError, "No connected"):
            request({"action": "tabs"}, self.state, timeout=.2)
        self.online("profile-a", session="a")
        self.online("profile-b", session="b")
        with self.assertRaisesRegex(RuntimeError, "Multiple profiles"):
            request({"action": "tabs"}, self.state, timeout=.2)

    def test_timeout_cleans_up_payload(self):
        self.online()
        with self.assertRaises(TimeoutError):
            request({"action": "open", "url": "https://example.com/", "text": "private"}, self.state, timeout=.15, agent="agent-a")
        self.assertEqual(self.db.execute("SELECT count(*) FROM requests").fetchone()[0], 0)

    def test_native_host_rejects_wrong_origin(self):
        p = subprocess.run([sys.executable, str(ROOT / "native_host.py"), "--state-dir",
                            str(self.state), "chrome-extension://wrong/"], capture_output=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b"Unrecognized extension origin", p.stderr)

    def test_installer_quotes_paths_and_limits_origin(self):
        dest = Path(self.temp.name) / "host dir"
        runtime = Path(self.temp.name) / "runtime dir"
        install(dest, self.state, sys.executable, runtime)
        manifest = json.loads(next(dest.glob("*.json")).read_text())
        self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + extension_id() + "/"])
        self.assertTrue(Path(manifest["path"]).is_file())
        p = subprocess.run(["sh", "-n", manifest["path"]], capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        # The installed host must not read scripts or its manifest in Documents.
        p = subprocess.Popen([manifest["path"], "chrome-extension://" + extension_id() + "/"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd="/", env={"PATH": "/usr/bin:/bin"})
        try:
            hello = read_message(p.stdout)
            self.assertEqual(hello["type"], "connected")
            p.stdin.close()
            p.wait(timeout=5)
            self.assertEqual(p.returncode, 0, p.stderr.read().decode())
        finally:
            if p.poll() is None:
                p.kill(); p.wait(timeout=5)
            for stream in [p.stdin, p.stdout, p.stderr]: stream.close()

    def test_brave_macos_uses_chrome_native_host_directory(self):
        self.assertEqual(default_host_dir(), Path.home() /
                         "Library/Application Support/Google/Chrome/NativeMessagingHosts")

    def test_private_state_rejects_symlink(self):
        target = Path(self.temp.name) / "target"
        target.mkdir()
        link = Path(self.temp.name) / "linked-state"
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(PermissionError):
            connect(link)

    def test_real_native_host_round_trip_and_disconnect(self):
        host = subprocess.Popen([sys.executable, str(ROOT / "native_host.py"), "--state-dir",
                                 str(self.state), "chrome-extension://" + extension_id() + "/"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        incoming = queue.Queue()
        def receive():
            try:
                while True:
                    msg = read_message(host.stdout)
                    if msg is None:
                        return
                    incoming.put(msg)
            except Exception as e:
                incoming.put(e)
        reader = threading.Thread(target=receive, daemon=True)
        reader.start()
        try:
            hello = incoming.get(timeout=5)
            self.assertEqual(hello["type"], "connected")
            write_message(host.stdin, {"type": "identify", "connection": "b_live", "epoch": "epoch"})
            self.assertEqual(incoming.get(timeout=5)["type"], "ready")
            for _ in range(50):
                if sessions(self.db): break
                time.sleep(.02)
            target_id = None
            for ok in [True, False]:
                outcome = queue.Queue()
                def run_request():
                    try: outcome.put(request({"action": "open", "url": "https://example.com/"}, self.state, timeout=3, agent="agent-a"))
                    except Exception as e: outcome.put(e)
                client = threading.Thread(target=run_request)
                client.start()
                msg = incoming.get(timeout=3)
                self.assertEqual(msg["command"]["action"], "open")
                write_message(host.stdin, {"type": "response", "id": msg["id"], "ok": ok,
                                         "result": {"id": 42}, "error": "test failure"})
                result = outcome.get(timeout=3)
                client.join(timeout=1)
                if ok:
                    self.assertEqual(result["id"], 42)
                    self.assertTrue(result["target"].startswith("t_"))
                    target_id = result["target"]
                else: self.assertIsInstance(result, RuntimeError)
                self.assertEqual(self.db.execute("SELECT count(*) FROM requests").fetchone()[0], 0)
            # An agent can time out while the browser still runs the first
            # command. A queued second write must wait, then fail closed if the
            # late reply reports a partial failure. It must never reach Chrome.
            outcomes = queue.Queue()
            def click_request(ident, timeout):
                try:
                    outcomes.put((ident, request({"action": "click", "tab": target_id, "selector": "#submit"},
                                                self.state, timeout=timeout, agent="agent-a", request_id=ident)))
                except Exception as error:
                    outcomes.put((ident, error))
            first = threading.Thread(target=click_request, args=("late-first", .6))
            first.start()
            sent = incoming.get(timeout=3)
            second = threading.Thread(target=click_request, args=("late-second", 3))
            second.start()
            first.join(timeout=2)
            self.assertFalse(first.is_alive())
            self.assertEqual(self.db.execute("SELECT status FROM journal WHERE id='late-first'").fetchone()[0], "unknown")
            write_message(host.stdin, {"type": "response", "id": sent["id"], "ok": False,
                                      "error": "connection lost after partial click"})
            second.join(timeout=4)
            self.assertFalse(second.is_alive())
            results = dict([outcomes.get(timeout=1), outcomes.get(timeout=1)])
            self.assertIsInstance(results["late-first"], TimeoutError)
            self.assertIsInstance(results["late-second"], RuntimeError)
            self.assertIn("uncertain", str(results["late-second"]))
            self.assertTrue(incoming.empty(), "Second write was sent to the browser")
            self.assertEqual(self.db.execute("SELECT status FROM journal WHERE id='late-first'").fetchone()[0], "unknown")
            # A trusted pre-execution denial has a known no-effect outcome.
            # Reconcile the deliberately partial failure before the next case.
            with self.db:
                self.db.execute("UPDATE journal SET status='resolved-not-run' WHERE id='late-first'")
            denied_client = threading.Thread(target=click_request, args=("denied-site", 3))
            denied_client.start()
            denied_message = incoming.get(timeout=3)
            write_message(host.stdin, {"type":"response", "id":denied_message["id"], "ok":False,
                                      "not_run":True, "error":"Site permission denied before execution"})
            denied_client.join(timeout=4)
            self.assertIsInstance(outcomes.get(timeout=1)[1], RuntimeError)
            self.assertEqual(self.db.execute("SELECT status FROM journal WHERE id='denied-site'").fetchone()[0], "failed")
            host.stdin.close()
            host.wait(timeout=5)
            self.assertEqual(host.returncode, 0, host.stderr.read().decode())
            self.assertEqual(sessions(self.db), [])
        finally:
            if host.poll() is None:
                host.kill()
                host.wait(timeout=5)
            for stream in [host.stdin, host.stdout, host.stderr]: stream.close()

    def test_agent_ownership_and_expired_takeover(self):
        a = acquire(self.db, "browser", "epoch", 42, "agent-a")
        b = acquire(self.db, "browser", "epoch", 43, "agent-b")
        self.assertNotEqual(a["id"], b["id"])
        with self.assertRaisesRegex(RuntimeError, "reserved by agent"):
            acquire(self.db, "browser", "epoch", 42, "agent-b")
        with self.assertRaisesRegex(RuntimeError, "another agent"):
            validate_target(self.db, a["id"], "agent-b", "browser", "epoch")
        with self.db:
            self.db.execute("UPDATE leases SET expires=0 WHERE id=?", (a["id"],))
        replacement = acquire(self.db, "browser", "epoch", 42, "agent-b")
        self.assertNotEqual(a["id"], replacement["id"])
        with self.assertRaises(RuntimeError):
            validate_target(self.db, a["id"], "agent-a", "browser", "epoch")

    def test_targets_survive_transport_reconnect_but_reject_new_browser_epoch(self):
        self.online()
        target = acquire(self.db, "b_test", "epoch", 42, "agent-a")
        self.online(session="new-transport")
        self.assertEqual(connections(self.db, True)[0]["session"], "new-transport")
        self.assertEqual(validate_target(self.db, target["id"], "agent-a", "b_test", "epoch")["tab"], 42)
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            validate_target(self.db, target["id"], "agent-a", "b_test", "new-epoch")

    def test_recovery_records_uncertain_action_without_replay(self):
        target = acquire(self.db, "b_test", "epoch", 42, "agent-a")
        now = time.time()
        with self.db:
            self.db.execute("INSERT INTO journal VALUES ('op', 'b_test', 'epoch', 'gone', 'agent-a', ?, 'click', 'sent', ?, ?, NULL)",
                            (target["id"], now, now))
        recovered = recover(self.db, "agent-a")
        self.assertEqual(recovered["operations"][0]["status"], "unknown")
        self.assertFalse(recovered["targets"][0]["recoverable"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM requests").fetchone()[0], 0)

    def test_duplicate_request_id_never_deletes_or_replays_original(self):
        self.online()
        now = time.time()
        with self.db:
            self.db.execute("INSERT INTO journal VALUES ('op', 'b_test', 'epoch', 'transport', 'agent-a', NULL, 'tabs', 'pending', ?, ?, NULL)", (now, now))
            self.db.execute("INSERT INTO requests VALUES ('op', 'transport', ?, 'pending', '{}', NULL)", (now+30,))
        with self.assertRaisesRegex(RuntimeError, "already recorded"):
            request({"action": "tabs"}, self.state, agent="agent-a", request_id="op")
        self.assertIsNotNone(self.db.execute("SELECT id FROM requests WHERE id='op'").fetchone())


if __name__ == "__main__":
    unittest.main()
