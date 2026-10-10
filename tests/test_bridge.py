import importlib.util
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


old_argv, old_stdin = sys.argv, sys.stdin
sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
sys.argv, sys.stdin = ['worker.py', 'fixture'], io.StringIO('')
spec = importlib.util.spec_from_file_location('console_bridge', Path(__file__).parents[1] / 'bridge' / 'worker.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
sys.argv, sys.stdin = old_argv, old_stdin


class DeviceFixture:
    settings = {}
    info = {'displayRotation': 0, 'displayWidth': 1080, 'displayHeight': 2400, 'screenOn': True}
    window = 'fixture u0 package/Activity'
    text = '原始文本'
    password = False

    @property
    def jsonrpc(self):
        def native_text(selector):
            if selector.get('className') and selector['className'] != getattr(self, 'actual_class', 'android.widget.EditText'):
                raise RuntimeError('Native target no longer matches the old class')
            return self.text
        return SimpleNamespace(getText=native_text, dumpWindowHierarchy=lambda *args, **kwargs: self.dump_hierarchy())

    def shell(self, command):
        value = 'mCurrentFocus=Window{' + self.window + '}' if isinstance(command, str) and 'mCurrentFocus' in command else 'mIsShowing=false' if isinstance(command, str) else 'mWakefulness=Awake'
        return SimpleNamespace(output=value)

    def dump_hierarchy(self, **kwargs):
        return '<hierarchy><node class="android.widget.LinearLayout" package="package" bounds="[0,0][1080,2400]" enabled="true" clickable="true"><node class="android.widget.EditText" resource-id="package:id/input" package="package" text="' + self.text + '" content-desc="' + self.text + '" focused="true" password="' + str(self.password).lower() + '" enabled="true" bounds="[10,10][500,100]" /></node></hierarchy>'

    def __call__(self, **kwargs):
        return SimpleNamespace(count=1, selector=kwargs, info={'className': getattr(self,'actual_class','android.widget.EditText'), 'resourceName': 'package:id/input', 'packageName': 'package', 'text': self.text, 'bounds': {'left': 10, 'top': 10, 'right': 500, 'bottom': 100}})


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.device = DeviceFixture()
        bridge.device = self.device
        bridge.power_cache['at'] = 0

    def test_editing_keeps_node_identity_but_invalidates_old_action_signature(self):
        first = bridge.tree()['nodes'][-1]
        self.device.text = '更新文本'
        second = bridge.tree()['nodes'][-1]
        self.assertEqual(first['id'], second['id'])
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])

    def test_window_changes_invalidate_even_identical_fields(self):
        first = bridge.tree()['nodes'][-1]
        self.device.window = 'different u0 package/Activity'
        second = bridge.tree()['nodes'][-1]
        self.assertNotEqual(first['id'], second['id'])

    def test_native_text_repairs_lossy_xml_emoji(self):
        self.device.text = '中文😀'
        dump = self.device.dump_hierarchy
        self.device.dump_hierarchy = lambda **kwargs: dump(**kwargs).replace('😀', '..')
        node = bridge.tree()['nodes'][-1]
        self.assertEqual(node['text'], '中文😀')
        focus = bridge.focused()['node']
        self.assertEqual(focus['text'], node['text'])
        self.assertEqual(focus['fingerprint'], node['fingerprint'])

    def test_password_text_and_description_are_not_exposed(self):
        self.device.password = True
        node = bridge.tree()['nodes'][-1]
        self.assertEqual(node['text'], '')
        self.assertEqual(node['description'], '')
        focus = bridge.focused()
        self.assertEqual(focus['text'], '')
        self.assertTrue(focus['password'])
        self.assertIsNone(focus['node'])

    def test_webview_editable_focus_does_not_require_edittext_class(self):
        original = self.device.dump_hierarchy
        self.device.actual_class = 'android.view.View'
        self.device.dump_hierarchy = lambda **kwargs: original(**kwargs).replace('android.widget.EditText', 'android.view.View').replace('focused="true"', 'focused="true" editable="true"')
        bridge.tree()
        result = bridge.focused()
        self.assertTrue(result['editable'])
        self.assertEqual(result['node']['className'], 'android.view.View')

    def test_stable_resource_does_not_depend_on_transient_class(self):
        bridge.tree()
        self.device.actual_class = 'miuix.androidbasewidget.widget.ClearableEditText'
        result = bridge.focused()
        self.assertTrue(result['editable'])
        self.assertEqual(result['node']['className'], self.device.actual_class)
        self.assertEqual(result['text'], self.device.text)

    def test_multiple_editable_foci_are_not_guessed(self):
        bridge.tree()
        bridge.last_nodes.append(dict(bridge.last_nodes[-1], id='different'))
        self.assertEqual(bridge.focused()['reason'], 'AMBIGUOUS_FOCUS')

    def test_parent_signatures_change_when_recycled_child_content_changes(self):
        first = bridge.tree()['nodes'][0]
        self.device.text = '另一个联系人'
        second = bridge.tree()['nodes'][0]
        self.assertEqual(first['id'], second['id'])
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])

    def test_window_query_recovers_from_a_brief_transition(self):
        values = iter(['mCurrentFocus=null', 'mCurrentFocus=Window{new u0 package/Activity}'])
        self.device.shell = lambda command: SimpleNamespace(output=next(values))
        with patch.object(bridge.time, 'sleep'):
            self.assertEqual(bridge.current_window(), 'new u0 package/Activity')

    def test_missing_window_never_reuses_an_old_identity(self):
        self.device.shell = lambda command: SimpleNamespace(output='mCurrentFocus=null')
        with patch.object(bridge.time, 'sleep'), self.assertRaises(RuntimeError):
            bridge.current_window()

    def test_queued_text_write_rechecks_native_text_before_mutating(self):
        node = bridge.tree()['nodes'][-1]
        self.device.text = '来自其他输入路径'
        with self.assertRaises(bridge.AppStateError) as error:
            bridge.invoke('setText', {'requireFocus': True, 'targetId': node['id'], 'expectedText': node['text']})
        self.assertEqual(error.exception.code, 'TEXT_CONFLICT')

    def test_queued_text_write_rejects_a_new_window(self):
        node = bridge.tree()['nodes'][-1]
        self.device.window = 'other u0 package/Activity'
        with self.assertRaises(bridge.AppStateError) as error:
            bridge.invoke('setText', {'requireFocus': True, 'targetId': node['id'], 'expectedText': node['text']})
        self.assertEqual(error.exception.code, 'FOCUS_CHANGED')

    def test_empty_root_is_reported_once_instead_of_retried_as_a_success(self):
        calls = []
        self.device.dump_hierarchy = lambda **kwargs: calls.append(1) or '<hierarchy rotation="0" />'
        with self.assertRaises(bridge.AppStateError) as error:
            bridge.tree()
        self.assertEqual(error.exception.code, 'UI_ROOT_UNAVAILABLE')
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
