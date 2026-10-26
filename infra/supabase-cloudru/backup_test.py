import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import backup
import offsite

spec = importlib.util.spec_from_file_location('restore', Path(__file__).with_name('verify-restore.py'))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class BackupTest(unittest.TestCase):
    def test_bootstrap_adaptation_preserves_alter_and_grants(self):
        sql = b'CREATE ROLE postgres;\nCREATE ROLE supabase_admin;\nALTER ROLE supabase_admin WITH SUPERUSER;\nGRANT anon TO postgres GRANTED BY supabase_admin;\n'
        actual = restore.roles_for_restore(sql)
        self.assertEqual(actual, sql.replace(b'CREATE ROLE supabase_admin;\n', b''))
        for invalid in (b'', sql + b'CREATE ROLE supabase_admin;\n'):
            with self.assertRaises(ValueError):
                restore.roles_for_restore(invalid)

    def test_sql_identifiers_and_snapshot_are_not_interpolated_unsafely(self):
        self.assertEqual(backup.quote_ident('a"b'), '"a""b"')
        with self.assertRaises(ValueError):
            backup.fingerprint('test', 'postgres', token="'; DELETE FROM auth.users; --")

    def test_fingerprint_reads_same_snapshot_and_preserves_rls(self):
        responses = [b'[["public","rooms"]]', b'[{"policyname":"read_room"}]', b'[["public","rooms",true,false]]']
        calls = []
        def query(container, db, sql, **kw):
            calls.append(sql)
            if kw.get('output'):
                kw['output'].write(b'{"a":1}\n{"a":2}\n')
                return None
            return responses.pop(0)
        with patch.object(backup, 'psql', side_effect=query):
            result = backup.fingerprint('test', 'postgres', token='00000001-00000001-1')
        self.assertEqual(result['tables']['public.rooms']['rows'], 2)
        self.assertEqual(result['policies'], [{'policyname': 'read_room'}])
        self.assertEqual(result['rls'], [['public', 'rooms', True, False]])
        self.assertTrue(all("SET TRANSACTION SNAPSHOT '00000001-00000001-1'" in q for q in calls))
        self.assertTrue(all('READ ONLY' in q for q in calls))
        self.assertTrue(all('SET LOCAL extra_float_digits = 3' in q for q in calls))

    def test_command_errors_do_not_expose_private_sql(self):
        with patch.object(backup.subprocess, 'run', return_value=subprocess.CompletedProcess(['docker'], 1, b'', b'private password value')):
            with self.assertRaises(RuntimeError) as caught:
                backup.run(['docker', 'exec'])
        self.assertNotIn('private password', str(caught.exception))

    def test_source_directory_is_not_a_restore_target(self):
        with self.assertRaises(ValueError):
            restore.verify(Path(__file__).parent)

    def test_upload_rejects_paths_outside_completed_backup_root(self):
        with self.assertRaises(ValueError):
            offsite.upload(Path(__file__).parent)

    def test_retention_only_removes_proven_uploaded_generated_copies(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for day in range(1, 10):
                name = f'backup-202610{day:02}T031500Z'
                (root/name).mkdir()
                (root/(name+'-offsite.json')).write_text(json.dumps({'ok': day != 2}))
            (root/'backup-recovered-abc').mkdir()
            (root/'.pending-test').mkdir()
            with patch.object(backup, 'ROOT', root), patch.object(offsite, 'restic') as remote:
                offsite.retain(root/'test.log')
            self.assertFalse((root/'backup-20261001T031500Z').exists())
            self.assertTrue((root/'backup-20261002T031500Z').exists())
            self.assertTrue((root/'backup-recovered-abc').exists())
            self.assertTrue((root/'.pending-test').exists())
            args = remote.call_args_list[0].args[0]
            self.assertIn('host,tags', args)
            self.assertIn('lpmview-cloudru-db', args)

    def test_remote_retention_failure_preserves_local_copies(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(backup, 'ROOT', Path(temp)), patch.object(offsite, 'restic', side_effect=RuntimeError('offline')), patch.object(offsite.shutil, 'rmtree') as remove:
                with self.assertRaises(RuntimeError):
                    offsite.retain(Path(temp)/'log')
                remove.assert_not_called()


if __name__ == '__main__':
    unittest.main()
