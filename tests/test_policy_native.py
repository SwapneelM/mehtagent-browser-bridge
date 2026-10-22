"""Two actual native hosts observe one user policy without sharing identities."""
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from bridge import extension_id
from native_host import read_message, write_message


class NativePolicyTests(unittest.TestCase):
    def test_shared_file_updates_reach_separate_hosts_and_invalid_file_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            policy=Path(temp)/'shared.json'
            hosts=[]
            def receive_until(incoming,kind):
                while True:
                    msg=incoming.get(timeout=5)
                    if isinstance(msg,Exception): raise msg
                    if msg['type']==kind: return msg
            try:
                for ident in ('one','two'):
                    host=subprocess.Popen([sys.executable,str(ROOT/'native_host.py'),'--state-dir',str(Path(temp)/ident),'--policy-file',str(policy),'chrome-extension://'+extension_id()+'/'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                    incoming=queue.Queue();hosts.append((host,incoming))
                    def receive(process=host,messages=incoming):
                        try:
                            while True:
                                msg=read_message(process.stdout)
                                if msg is None:return
                                messages.put(msg)
                        except Exception as exc: messages.put(exc)
                    threading.Thread(target=receive,daemon=True).start()
                    self.assertEqual(receive_until(incoming,'connected')['type'],'connected')
                    write_message(host.stdin,{'type':'identify','connection':'b_'+ident,'epoch':'epoch_'+ident})
                    ready=receive_until(incoming,'ready')
                    self.assertEqual(ready['connection'],'b_'+ident)
                    self.assertIsNone(ready['policy']['policy'])
                document={'version':1,'sites':{'https://docs.google.com':'allow'},'preferences':{'background':True,'showCursor':False}}
                first,q1=hosts[0];second,q2=hosts[1]
                write_message(first.stdin,{'type':'policy_update','id':'edit1','revision':None,'operation':{'migrate':document}})
                result=receive_until(q1,'policy_result')
                self.assertNotIn('error',result)
                changed=receive_until(q2,'policy')
                self.assertEqual(changed['policy'],document)
                # The second browser started with a missing file but cannot
                # migrate its stale settings over the first browser's policy.
                write_message(second.stdin,{'type':'policy_update','id':'edit2','revision':None,'operation':{'migrate':{'version':1,'sites':{}}}})
                rejected=receive_until(q2,'policy_result')
                self.assertIn('error',rejected)
                self.assertEqual(rejected['policy'],document)
                policy.write_text('{"PRIVATE_MARKER":')
                invalid=receive_until(q2,'policy')
                self.assertIsNone(invalid['policy'])
                self.assertIn('error',invalid)
                self.assertNotIn('PRIVATE_MARKER',json.dumps(invalid))
                policy.write_text(json.dumps(document))
                restored=receive_until(q2,'policy')
                self.assertEqual(restored['policy'],document)
            finally:
                for host,_ in hosts:
                    host.stdin.close()
                    try: host.wait(timeout=5)
                    except subprocess.TimeoutExpired: host.kill();host.wait(timeout=5)
                    self.assertEqual(host.stderr.read(),b'')
                    for stream in (host.stdout,host.stderr):stream.close()
