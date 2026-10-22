import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from policy_store import decode, default_path, snapshot, update, validate


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'config' / 'browser-policy.json'

    def tearDown(self):
        self.temp.cleanup()

    def test_migration_keeps_existing_grants_and_uses_private_atomic_file(self):
        value = update(self.path, None, {'migrate': {'version': 1, 'sites': {'https://docs.google.com': 'allow', 'https://colab.research.google.com': 'allow'}}})
        self.assertEqual(value['policy']['sites']['https://colab.research.google.com'], 'allow')
        self.assertEqual(snapshot(self.path), value)
        if os.name != 'nt':
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(list(self.path.parent.glob('.browser-policy-*')), [])
        with self.assertRaises(ValueError):
            update(self.path, value['revision'], {'migrate': {'version': 1, 'sites': {}}})

    def test_stale_concurrent_browser_edit_cannot_overwrite_other_profile(self):
        value = update(self.path, None, {'replace': {'version': 1, 'sites': {}}})
        barrier = threading.Barrier(2)
        outcomes = []
        def edit(host):
            barrier.wait()
            try:
                outcomes.append(update(self.path, value['revision'], {'site': {'origin': host, 'mode': 'ask'}}))
            except ValueError:
                outcomes.append('conflict')
        threads = [threading.Thread(target=edit, args=('https://' + host + '.example',)) for host in ('one', 'two')]
        for thread in threads: thread.start()
        for thread in threads: thread.join(5)
        self.assertEqual(outcomes.count('conflict'), 1)
        self.assertEqual(len(snapshot(self.path)['policy']['sites']), 1)

    def test_remove_and_preferences_preserve_unrelated_rules(self):
        value = update(self.path, None, {'replace': {'version': 1, 'sites': {'https://one.example': 'ask', 'https://two.example': 'block'}}})
        value = update(self.path, value['revision'], {'site': {'origin': 'https://one.example', 'mode': None}})
        value = update(self.path, value['revision'], {'preferences': {'showCursor': False}})
        self.assertEqual(value['policy']['sites'], {'https://two.example': 'block'})
        self.assertEqual(value['policy']['preferences'], {'background': True, 'showCursor': False})

    def test_untrusted_policy_never_adds_wildcards_credentials_or_hidden_scopes(self):
        for host in ('https://*.example.com', 'https://user:secret@example.com', 'http://example.com', 'https://example.com/path', 'https://EXAMPLE.com', 'https://example.com:443', 'https://example.com/', 'https://example.com.', 'https://example.com?x=1', 'https://example.com#fragment'):
            with self.subTest(host=host), self.assertRaises(ValueError):
                validate({'version': 1, 'sites': {host: 'allow'}})
        self.assertEqual(validate({'version': 1, 'sites': {'http://127.0.0.1:9191': 'allow'}})['sites'], {'http://127.0.0.1:9191': 'allow'})

    def test_protected_hosts_stay_blocked_even_when_file_edited(self):
        for host in ('https://paypal.com', 'https://sub.chase.com', 'https://my.bank.example', 'https://accounts.google.com'):
            for mode in ('allow', 'ask'):
                with self.subTest(host=host, mode=mode), self.assertRaises(ValueError):
                    validate({'version': 1, 'sites': {host: mode}})
            self.assertEqual(validate({'version': 1, 'sites': {host: 'block'}})['sites'][host], 'block')

    def test_malformed_duplicate_oversize_and_unknown_fields_fail_closed(self):
        for data in (b'{', b'{"version":1,"version":1,"sites":{}}', b' ' * 65537,
                     b'{"version":true,"sites":{}}', b'{"version":1,"sites":{},"tokens":"private"}',
                     b'{"version":1,"sites":{},"preferences":{"showCursor":1}}',
                     b'{"version":1,"sites":{},"preferences":{"__proto__":true}}',
                     b'{"version":1,"sites":{},"preferences":null}'):
            with self.subTest(data=data[:90]), self.assertRaises(ValueError): decode(data)
        with self.assertRaises(ValueError):
            validate({'version': 1, 'sites': {'https://s%d.example' % i: 'ask' for i in range(201)}})

    def test_symlink_policy_and_lock_refused_without_modifying_target(self):
        self.path.parent.mkdir()
        target = self.path.parent / 'secret'
        target.write_text('preserve me')
        self.path.symlink_to(target)
        with self.assertRaises(PermissionError): snapshot(self.path)
        with self.assertRaises(PermissionError): update(self.path, None, {'replace': {'version': 1, 'sites': {}}})
        self.assertEqual(target.read_text(), 'preserve me')
        self.path.unlink()
        self.path.with_name(self.path.name + '.lock').unlink()
        self.path.with_name(self.path.name + '.lock').symlink_to(target)
        with self.assertRaises(PermissionError): update(self.path, None, {'replace': {'version': 1, 'sites': {}}})
        self.assertEqual(target.read_text(), 'preserve me')

    def test_default_and_override_paths_have_no_machine_specific_names(self):
        with patch.dict(os.environ, {'MEHTAGENT_BROWSER_POLICY': str(self.path)}):
            self.assertEqual(default_path(), self.path)
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.path.parent)}, clear=True):
            self.assertEqual(default_path(), self.path.parent / 'mehtagent/browser-policy.json')


if __name__ == '__main__': unittest.main()
