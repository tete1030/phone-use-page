import importlib.util
import io
import json
import os
import tempfile
import sys
import unittest
from xml.sax.saxutils import quoteattr
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
    bounds = [10, 10, 500, 100]
    resource = 'package:id/input'
    parent_class = 'android.widget.LinearLayout'
    focused = True

    @property
    def jsonrpc(self):
        def native_text(selector):
            if selector.get('className') and selector['className'] != getattr(self, 'actual_class', 'android.widget.EditText'):
                raise RuntimeError('Native target no longer matches the old class')
            return self.text
        def write(selector, text):
            self.writes = getattr(self, 'writes', []) + [text]
            self.text = text
            if hasattr(self, 'on_write'):
                self.on_write()
            return True
        return SimpleNamespace(getText=native_text, setText=write, clearTextField=lambda selector: write(selector, ''), dumpWindowHierarchy=lambda *args, **kwargs: self.dump_hierarchy())

    def shell(self, command):
        value = 'mCurrentFocus=Window{' + self.window + '}' if isinstance(command, str) and 'mCurrentFocus' in command else 'mIsShowing=false' if isinstance(command, str) else 'mWakefulness=Awake'
        return SimpleNamespace(output=value)

    def dump_hierarchy(self, **kwargs):
        bounds = '[%d,%d][%d,%d]' % tuple(self.bounds)
        return ('<hierarchy><node class="' + self.parent_class + '" package="package" bounds="[0,0][1080,2400]" enabled="true" clickable="true">'
                '<node class="' + getattr(self, 'actual_class', 'android.widget.EditText') + '" resource-id="' + self.resource + '" package="package" text=' + quoteattr(self.text) +
                ' content-desc=' + quoteattr(self.text if self.resource else '') + ' focused="' + str(self.focused).lower() + '" password="' + str(self.password).lower() +
                '" enabled="true" bounds="' + bounds + '" /></node></hierarchy>')

    def __call__(self, **kwargs):
        left, top, right, bottom = self.bounds
        return SimpleNamespace(count=2 if getattr(self, 'ambiguous', False) else 1, selector=kwargs,
                               info={'className': getattr(self,'actual_class','android.widget.EditText'), 'resourceName': self.resource, 'packageName': 'package',
                                     'password': self.password, 'text': self.text, 'bounds': {'left': left, 'top': top, 'right': right, 'bottom': bottom}})


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.device = DeviceFixture()
        bridge.device = self.device
        bridge.power_cache['at'] = 0

    def identity_params(self, text):
        node = next(n for n in bridge.tree()['nodes'] if n['editable'])
        return {'nodeId': node['id'], 'selector': node['selector'], 'instance': node['instance'], 'bounds': node['bounds'], 'windowId': self.device.window, 'text': text}

    def test_own_write_and_clear_can_resize_the_same_field_without_losing_verification(self):
        for resource in ('package:id/input', ''):
            with self.subTest(resource=resource):
                self.device = DeviceFixture()
                bridge.device = self.device
                self.device.resource = resource
                self.device.text = ''
                self.device.on_write = lambda: setattr(self.device, 'bounds', [10, 10, 400 if self.device.text else 500, 100])
                for text in ('probe', '中文😀', ''):
                    result = bridge.invoke('setText', self.identity_params(text))
                    self.assertEqual(result['verification'], 'verified')
                    self.assertEqual(result['text'], text)
                self.assertEqual(self.device.writes, ['probe', '中文😀', ''])

    def test_write_rejects_changed_geometry_or_cached_identity_before_injection(self):
        params = self.identity_params('probe')
        self.device.bounds = [10, 10, 400, 100]
        with self.assertRaises(bridge.AppStateError):
            bridge.invoke('setText', params)
        self.assertFalse(getattr(self.device, 'writes', []))
        self.device.bounds = params['bounds']
        params['nodeId'] = 'missing'
        with self.assertRaises(bridge.AppStateError):
            bridge.invoke('setText', params)
        self.assertFalse(getattr(self.device, 'writes', []))

    def test_post_write_identity_rejects_window_parent_resource_and_password_changes(self):
        for attribute, value in [('window', 'other u0 package/Activity'), ('parent_class', 'android.widget.FrameLayout'),
                                 ('resource', 'package:id/other'), ('password', True), ('ambiguous', True), ('bounds', [600, 10, 1000, 100])]:
            with self.subTest(attribute=attribute):
                self.device = DeviceFixture()
                bridge.device = self.device
                params = self.identity_params('probe')
                self.device.on_write = lambda: setattr(self.device, attribute, value)
                result = bridge.invoke('setText', params)
                self.assertEqual(result['verification'], 'inconclusive')
                self.assertEqual(self.device.writes, ['probe'])

    def test_original_field_can_lose_focus_or_change_class_with_a_stable_resource(self):
        for attribute, value in [('focused', False), ('actual_class', 'miuix.androidbasewidget.widget.ClearableEditText')]:
            with self.subTest(attribute=attribute):
                self.device = DeviceFixture()
                bridge.device = self.device
                params = self.identity_params('probe')
                self.device.on_write = lambda: setattr(self.device, attribute, value)
                self.assertEqual(bridge.invoke('setText', params)['verification'], 'verified')

    def test_actual_content_mismatch_stays_failed_without_repeating_the_write(self):
        params = self.identity_params('probe')
        self.device.on_write = lambda: setattr(self.device, 'text', 'formatted')
        self.assertEqual(bridge.invoke('setText', params)['verification'], 'failed')
        self.assertEqual(self.device.writes, ['probe'])

    def test_one_shot_text_can_read_an_unfocused_unicode_field(self):
        self.device.text = '中文😀'
        params = {'selector': {'resourceId': 'package:id/input'}, 'instance': 0, 'bounds': [10, 10, 500, 100]}
        result = bridge.invoke('readText', params)
        self.assertEqual(result['text'], self.device.text)

    def test_one_shot_write_verifies_original_field_and_handles_lost_readback(self):
        params = {'selector': {'resourceId': 'package:id/input'}, 'instance': 0, 'bounds': [10, 10, 500, 100], 'text': '中文😀'}
        for mode, expected in [('advance', 'verified'), ('window', 'inconclusive'), ('missing', 'inconclusive'), ('format', 'failed')]:
            with self.subTest(mode=mode):
                self.device = DeviceFixture()
                bridge.device = self.device
                calls = []
                def write(selector, text):
                    calls.append(text)
                    self.device.text = 'formatted' if mode == 'format' else text
                    if mode == 'window':
                        self.device.window = 'different u0 package/Activity'
                    return True
                native = SimpleNamespace(setText=write, getText=lambda _: self.device.text)
                obj = SimpleNamespace(selector=params['selector'])
                lookup = [(obj, {'password': False}, params['bounds'])]
                lookup.append(RuntimeError('Target vanished') if mode == 'missing' else lookup[0])
                with patch.object(DeviceFixture, 'jsonrpc', native), patch.object(bridge, 'text_object', side_effect=lookup):
                    result = bridge.invoke('setText', params)
                self.assertEqual(result['verification'], expected)
                self.assertEqual(calls, [params['text']])

    def test_awake_covers_ac_usb_wireless_and_restores_only_owned_setting(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'awake.json'
            value = ['1']
            def shell(command):
                if command[1] == 'get':
                    return SimpleNamespace(output=value[0])
                value[0] = command[-1]
                return SimpleNamespace(output='')
            self.device.shell = shell
            with patch.dict(os.environ, {'CONSOLE_AWAKE_STATE': str(state)}):
                bridge.invoke('awake', {'enabled': True})
                self.assertEqual(value[0], '7')
                bridge.invoke('awake', {'enabled': False})
                self.assertEqual(value[0], '1')
                bridge.invoke('awake', {'enabled': True})
                value[0] = '3'
                bridge.invoke('awake', {'enabled': False})
                self.assertEqual(value[0], '3')
                state.write_text(json.dumps({'original': '0'}))
                bridge.invoke('awake', {'enabled': False})
                self.assertEqual(value[0], '0')

    def test_display_dimensions_use_native_fallback_instead_of_a_phone_model_default(self):
        self.device.info = {'displayRotation': 1}
        self.device.window_size = lambda: (1280, 720)
        result = bridge.tree()
        self.assertEqual((result['width'], result['height']), (1280, 720))

    def test_unavailable_display_dimensions_are_explicitly_rejected(self):
        self.device.info = {}
        self.device.window_size = lambda: (0, 0)
        with self.assertRaisesRegex(RuntimeError, 'display size'):
            bridge.tree()

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

    def test_queued_text_write_rechecks_bounds_before_mutating(self):
        params = {'selector': {'resourceId': 'package:id/input'}, 'bounds': [20, 20, 500, 100], 'text': 'draft'}
        with self.assertRaises(bridge.AppStateError) as error:
            bridge.invoke('setText', params)
        self.assertIn(error.exception.code, ('STALE_TARGET', 'FOCUS_CHANGED'))
        self.assertEqual(self.device.text, '原始文本')

    def test_queued_text_write_rejects_a_new_window(self):
        params = {'selector': {'resourceId': 'package:id/input'}, 'bounds': [10, 10, 500, 100], 'windowId': self.device.window, 'text': 'draft'}
        self.device.window = 'other u0 package/Activity'
        with self.assertRaises(bridge.AppStateError) as error:
            bridge.invoke('setText', params)
        self.assertEqual(error.exception.code, 'STALE_TARGET')
        self.assertEqual(self.device.text, '原始文本')

    def test_empty_root_is_reported_once_instead_of_retried_as_a_success(self):
        calls = []
        self.device.dump_hierarchy = lambda **kwargs: calls.append(1) or '<hierarchy rotation="0" />'
        with self.assertRaises(bridge.AppStateError) as error:
            bridge.tree()
        self.assertEqual(error.exception.code, 'UI_ROOT_UNAVAILABLE')
        self.assertEqual(len(calls), 1)

    def click_params(self):
        nodes = bridge.tree()['nodes']
        source, target = nodes[1], nodes[0]
        self.click_infos = {n['resourceId'] or n['className']: {
            'packageName': n['package'], 'className': n['className'], 'text': n['text'],
            'contentDescription': n['description'], 'enabled': n['enabled'], 'clickable': n['clickable'],
            'bounds': dict(zip(('left', 'top', 'right', 'bottom'), n['bounds']))
        } for n in nodes}
        return {'windowId': self.device.window, 'source': source, 'actionTarget': target, 'point': {'x': 100, 'y': 50}}

    def click_object(self, **selector):
        key = selector.get('resourceId') or selector.get('className')
        return SimpleNamespace(count=1, info=self.click_infos[key])

    def test_click_preflight_validates_the_label_and_ancestor_without_injecting(self):
        params = self.click_params()
        with patch.object(DeviceFixture, '__call__', self.click_object):
            self.assertEqual(bridge.invoke('validateNodeClick', params), {'valid': True})
        self.assertFalse(hasattr(self.device, 'writes'))

    def test_click_preflight_rejects_changed_native_text_or_disabled_row(self):
        for field, value in [('text', '其他条目'), ('enabled', False)]:
            with self.subTest(field=field):
                params = self.click_params()
                self.click_infos[params['source']['resourceId']][field] = value
                with patch.object(DeviceFixture, '__call__', self.click_object):
                    with self.assertRaises(bridge.AppStateError) as error:
                        bridge.invoke('validateNodeClick', params)
                self.assertEqual(error.exception.code, 'STALE_TARGET')
        params = self.click_params()
        self.click_infos[params['actionTarget']['className']]['clickable'] = False
        with patch.object(DeviceFixture, '__call__', self.click_object):
            with self.assertRaises(bridge.AppStateError) as error:
                bridge.invoke('validateNodeClick', params)
        self.assertEqual(error.exception.code, 'UNSUPPORTED_ACTION')

    def test_click_preflight_rejects_changed_window_cached_identity_and_outside_point(self):
        for change in ['window', 'fingerprint', 'point']:
            with self.subTest(change=change):
                params = self.click_params()
                if change == 'window':
                    params['windowId'] = 'other'
                elif change == 'fingerprint':
                    params['source'] = dict(params['source'], fingerprint='old')
                else:
                    params['point']['x'] = 900
                with patch.object(DeviceFixture, '__call__', self.click_object):
                    with self.assertRaises(bridge.AppStateError) as error:
                        bridge.invoke('validateNodeClick', params)
                self.assertEqual(error.exception.code, 'STALE_TARGET')

    def test_window_identity_supports_the_windows_dump_without_guessing_from_package(self):
        calls = []
        def shell(command):
            calls.append(command)
            return SimpleNamespace(output='mCurrentFocus = Window{fixture u0 package/Activity}' if ' windows' in command else '')
        self.device.shell = shell
        self.assertEqual(bridge.current_window(), 'fixture u0 package/Activity')
        self.assertEqual(len(calls), 2)
        self.device.shell = lambda command: SimpleNamespace(output='mFocusedApp=package/Activity')
        with patch.object(bridge.time, 'sleep'):
            with self.assertRaises(bridge.AppStateError) as error:
                bridge.current_window()
        self.assertEqual(error.exception.code, 'UI_WINDOW_UNAVAILABLE')


if __name__ == '__main__':
    unittest.main()
