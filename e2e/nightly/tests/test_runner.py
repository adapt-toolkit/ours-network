"""Fault checks for the full gate, without starting any services."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('run_all',Path(__file__).resolve().parents[1]/'run_all.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
class RunnerChecks(unittest.TestCase):
 def test_inventory(self):
  cases=list(runner.cases())
  self.assertEqual(len(cases),32)
  self.assertEqual(sum(2 if c[0]=='smoke' else 1 for c in cases),37)
  self.assertEqual(len(set((c[0],c[1],c[3]) for c in cases)),32)
  self.assertEqual(sum(c[0]=='rooms-agents' for c in cases),5)
  self.assertEqual(len(list(runner.cases('todo'))),6)
  self.assertEqual(len(list(runner.cases('withdrawn'))),2)
  self.assertEqual(sum(c[0]=='regressions-client' for c in cases),2)
 def test_missing_invalid_failed_skipped_reports(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)
   self.assertIn('evidence_error',runner.summarize(p))
   (p/'x.xml').write_text('broken')
   self.assertIn('evidence_error',runner.summarize(p))
   (p/'x.xml').write_text('<testsuite><testcase/><testcase><failure/></testcase><testcase><skipped/></testcase></testsuite>')
   self.assertEqual(runner.summarize(p),dict(tests=3,failed=1,skipped=1))
if __name__=='__main__':unittest.main()

class AggregateChecks(unittest.TestCase):
 def test_failed_xml_and_cleanup_fail_full_gate_but_all_cases_run(self):
  from unittest.mock import patch
  from types import SimpleNamespace
  import json
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d)/'run'
   calls=[]
   def fake_run(command, **kwargs):
    target=Path(command[command.index('--report-dir')+1]);calls.append(target.name)
    failed=target.name.startswith('01-')
    (target/'result.xml').write_text('<testsuite><testcase>'+('<failure/>' if failed else '')+'</testcase></testsuite>')
    (target/'cleanup.json').write_text(json.dumps({'exit_code':0 if failed else 1}))
    return SimpleNamespace(returncode=0)
   with patch.object(runner,'cases',side_effect=lambda disposition='active': iter([('security',3,'failed regression',False),('security',10,'cleanup failure',False)] if disposition=='active' else [])),patch.object(runner.subprocess,'run',side_effect=fake_run),patch('sys.argv',['run_all.py','--jobs','1','--report-dir',str(directory)]):
    self.assertEqual(runner.main(),1)
   self.assertEqual(len(calls),2)
   results=json.loads((directory/'results.json').read_text())
   self.assertTrue(all(r['code']==1 for r in results))
