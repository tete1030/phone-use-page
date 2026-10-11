import hashlib
import json
import io
import os
from pathlib import Path
import re
import sys
import time
import xml.etree.ElementTree as ET

import uiautomator2 as u2
from app_state import AppState, AppStateError

device = None
serial = sys.argv[1]
power_cache = {'at': 0, 'awake': False, 'locked': None}
last_nodes = []
last_window = ''


def current_window():
    for attempt in range(4):
        value = connect().shell('dumpsys window displays | grep -m 1 mCurrentFocus').output
        match = re.search(r'mCurrentFocus=Window\{([^}]+)\}', value)
        if match:
            return match.group(1)
        time.sleep(0.08)
    raise RuntimeError('Cannot establish active Android window identity')


def stamp(node):
    fields = {k: v for k, v in node.items() if k not in ('id', 'instance', 'selector', 'fingerprint')}
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()[:24]


def connect():
    global device
    if device is None:
        device = u2.connect(serial)
        device.settings['wait_timeout'] = 0.2
    return device


def read_power():
    d = connect()
    power = d.shell(['dumpsys', 'power']).output
    wake = re.search(r'mWakefulness=(\w+)', power)
    if not wake:
        raise RuntimeError('Cannot establish Android screen power state')
    keyguard = d.shell('dumpsys window policy | grep -m 1 mIsShowing').output
    lock = re.search(r'mIsShowing=(true|false)', keyguard)
    power_cache.update(at=time.monotonic(), awake=wake[1] == 'Awake', locked=lock[1] == 'true' if lock else None)
    return {'screenOn': power_cache['awake'], 'locked': power_cache['locked']}


def tree():
    global last_nodes, last_window
    d = connect()
    start = time.monotonic()
    for attempt in range(3):
        window = current_window()
        content = d.jsonrpc.dumpWindowHierarchy(False, 80, True, http_timeout=8)
        if not content:
            raise AppStateError('UI_ROOT_UNAVAILABLE', '当前应用没有可读 UI 根节点；视频和应用导航仍可用', 503)
        root = ET.fromstring(content)
        if len(root) == 0:
            raise AppStateError('UI_ROOT_UNAVAILABLE', '当前应用没有可读 UI 根节点；视频和应用导航仍可用', 503)
        if current_window() == window:
            break
    else:
        raise RuntimeError('Active window changed during UI capture')
    info = d.info
    width, height = info.get('displayWidth'), info.get('displayHeight')
    if not width or not height:
        width, height = d.window_size()
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise RuntimeError('Cannot establish Android display size')
    if time.monotonic() - power_cache['at'] > 5:
        read_power()
    nodes = []
    instances = {}

    def walk(element, parent, depth):
        counts = {}
        for child in element:
            a = child.attrib
            cls = a.get('class', '')
            editable = 'EditText' in cls or a.get('editable') == 'true'
            password = a.get('password') == 'true'
            label = '' if password else a.get('text', '')
            resource = a.get('resource-id', '')
            desc = '' if password else a.get('content-desc', '')
            package = a.get('package', '')
            structural = resource or (cls + '|' + desc)
            counts[structural] = counts.get(structural, 0) + 1
            identity = window + '|' + package + '|' + str(parent) + '|' + structural + '|' + str(counts[structural])
            key = hashlib.sha256(identity.encode()).hexdigest()[:16]
            raw = re.findall(r'-?\d+', a.get('bounds', '[0,0][0,0]'))
            bounds = list(map(int, raw[:4])) if len(raw) >= 4 else [0, 0, 0, 0]
            selector = {'className': cls, 'packageName': package}
            if resource:
                selector['resourceId'] = resource
            elif desc:
                selector['description'] = desc
            elif label and not editable:
                selector['text'] = label
            selector_key = json.dumps(selector, sort_keys=True)
            instance = instances.get(selector_key, 0)
            instances[selector_key] = instance + 1
            flags = {name: a.get(xml_name) == 'true' for name, xml_name in (
                ('enabled', 'enabled'), ('clickable', 'clickable'),
                ('longClickable', 'long-clickable'), ('checkable', 'checkable'),
                ('checked', 'checked'), ('focused', 'focused'), ('scrollable', 'scrollable'))}
            node = dict(id=key, parentId=parent, depth=depth, index=int(a.get('index', 0)),
                        text=label, description=desc, resourceId=resource, className=cls,
                        package=package, bounds=bounds, editable=editable, password=password,
                        visible=a.get('visible-to-user') != 'false' and min(bounds[2], width) > max(bounds[0], 0) and min(bounds[3], height) > max(bounds[1], 0),
                        selector=selector, instance=instance, **flags)
            # Ignore selection and input focus in identity; retain them in the action signature.
            node['fingerprint'] = stamp(node)
            nodes.append(node)
            walk(child, key, depth + 1)

    walk(root, None, 0)
    last_nodes = nodes
    last_window = window
    # Android's XML dump may replace non-BMP characters; getText preserves them.
    if any(n['focused'] and n['editable'] and not n['password'] for n in nodes):
        focus = focused()
        if focus and focus.get('node'):
            for index, node in enumerate(nodes):
                if node['id'] == focus['node']['id']:
                    nodes[index] = focus['node']
                    break
    children = {}
    for node in nodes:
        children.setdefault(node['parentId'], []).append(node)
    for node in reversed(nodes):
        child_content = [(n['text'], n['description'], n['resourceId'], n.get('childSignature', ''))
                         for n in children.get(node['id'], [])]
        node['childSignature'] = hashlib.sha256(json.dumps(child_content, ensure_ascii=True).encode()).hexdigest()[:24] if child_content and node['clickable'] and not node['editable'] and not node['checkable'] else ''
        node['fingerprint'] = stamp(node)
    return {'nodes': nodes, 'rotation': info.get('displayRotation', int(root.attrib.get('rotation', 0))),
            'width': width, 'height': height,
            'screenOn': power_cache['awake'], 'locked': power_cache['locked'], 'windowId': window, 'elapsedMs': round((time.monotonic() - start) * 1000, 1)}


def text_object(selector, instance=0, bounds=None, strict_bounds=True):
    selector = dict(selector)
    # Editable widgets can change their reported class when their value changes.
    if selector.get('resourceId'):
        selector.pop('className', None)
    obj = connect()(**selector)
    count = getattr(obj, 'count', 1)
    if count > 40:
        raise AppStateError('AMBIGUOUS_TARGET', 'Too many matching text targets')
    candidates = [obj] if count == 1 else [connect()(**dict(selector, instance=i)) for i in range(count)]
    matches = []
    for candidate in candidates:
        info = candidate.info
        b = info.get('visibleBounds') or info.get('bounds')
        actual = [b['left'], b['top'], b['right'], b['bottom']] if b else None
        if bounds is None or (count == 1 and not strict_bounds) or actual == bounds:
            matches.append((candidate, info, actual))
    if len(matches) != 1:
        raise AppStateError('AMBIGUOUS_TARGET' if matches else 'FOCUS_CHANGED', 'Cannot uniquely confirm the text target')
    return matches[0]


def focused():
    d = connect()
    window = current_window()
    if window != last_window:
        return {'editable': False, 'reason': 'WINDOW_CHANGED'}
    candidates = [n for n in last_nodes if n['editable'] and n['focused']]
    if len(candidates) != 1:
        return {'editable': False, 'reason': 'AMBIGUOUS_FOCUS' if candidates else 'NO_EDITABLE_FOCUS'}
    candidate = candidates[0]
    if candidate['password']:
        return {'editable': False, 'password': True, 'reason': 'PASSWORD_FIELD', 'text': '', 'node': None}
    selector = dict(candidate['selector'], focused=True)
    try:
        obj, info, actual = text_object(selector, candidate['instance'], candidate['bounds'], False)
        bounds = info.get('visibleBounds') or info.get('bounds')
        if current_window() != window:
            return {'editable': False, 'reason': 'FOCUS_CHANGED'}
        node = dict(candidate)
        node.update(text=d.jsonrpc.getText(obj.selector) or '', focused=True, bounds=actual, className=info.get('className', candidate['className']))
        for name in ('enabled', 'clickable', 'longClickable', 'checkable', 'checked', 'scrollable'):
            if name in info:
                node[name] = bool(info[name])
        node['fingerprint'] = stamp(node)
        return {'text': node['text'], 'className': node['className'], 'resourceId': node['resourceId'],
                'package': node['package'], 'bounds': bounds, 'editable': True, 'password': False, 'node': node, 'reason': None}
    except u2.exceptions.UiObjectNotFoundError:
        return {'editable': False, 'reason': 'FOCUS_CHANGED'}
    except Exception:
        return {'editable': False, 'reason': 'TEXT_READ_UNSUPPORTED'}


def restore_awake():
    state_path = Path(os.environ.get('CONSOLE_AWAKE_STATE', '/tmp/android-console-awake.json'))
    if not state_path.exists():
        return {'enabled': False}
    saved = json.loads(state_path.read_text())
    current = connect().shell(['settings', 'get', 'global', 'stay_on_while_plugged_in']).output.strip()
    if current == saved.get('applied', '3'):
        command = ['settings', 'delete', 'global', 'stay_on_while_plugged_in'] if saved['original'] == 'null' else ['settings', 'put', 'global', 'stay_on_while_plugged_in', saved['original']]
        connect().shell(command)
    state_path.unlink()
    return {'enabled': False}


def invoke(method, params):
    d = connect()
    if method == 'awake':
        if not params.get('enabled'):
            return restore_awake()
        path = Path(os.environ.get('CONSOLE_AWAKE_STATE', '/tmp/android-console-awake.json'))
        if not path.exists():
            original = d.shell(['settings', 'get', 'global', 'stay_on_while_plugged_in']).output.strip()
            if original != 'null' and not original.isdigit():
                raise RuntimeError('Cannot establish original power setting')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({'original': original, 'applied': '7'}))
            path.chmod(0o600)
        saved = json.loads(path.read_text())
        saved['applied'] = '7'
        path.write_text(json.dumps(saved))
        d.shell(['settings', 'put', 'global', 'stay_on_while_plugged_in', '7'])
        actual = d.shell(['settings', 'get', 'global', 'stay_on_while_plugged_in']).output.strip()
        if actual != '7':
            raise RuntimeError('Phone did not accept stay-awake setting')
        return {'enabled': True}
    if method == 'summary':
        battery = d.shell(['dumpsys', 'battery']).output
        level = re.search(r'level: (\d+)', battery)
        scale = re.search(r'scale: (\d+)', battery)
        network = d.shell(['cmd', 'connectivity', 'get-active-network']).output.strip()
        if re.search(r'Unknown|Error|usage', network, re.I):
            dump = d.shell(['dumpsys', 'connectivity']).output
            active = re.search(r'Active default network: (\d+)', dump)
            block = next((part for part in dump.split('NetworkAgentInfo') if active and re.search(r'network\{' + active[1] + r'\}', part)), '')
            network = 'Wi-Fi' if re.search(r'WIFI|Wi-Fi', block) else '移动网络' if re.search(r'CELLULAR|MOBILE', block) else '以太网' if 'ETHERNET' in block else '未知'

        return {'battery': round(int(level[1])*100/int(scale[1])) if level and scale and int(scale[1]) else None,
                'charging': bool(re.search(r'(?:AC|USB|Wireless) powered: true', battery)),
                'inputMethod': d.shell(['settings', 'get', 'secure', 'default_input_method']).output.strip(),
                'network': network[:160]}
    if method == 'keyboardPresent':
        return 'Android Console Keyboard' in d.shell(['dumpsys', 'input']).output
    if method == 'clipboard':
        if params.get('write'):
            d.set_clipboard(params.get('text', ''))
            return {'status': 'sent', 'verification': 'not_verified'}
        value = d.clipboard
        if value is None:
            raise AppStateError('CLIPBOARD_UNAVAILABLE', 'No readable clipboard text: it may be empty or restricted by Android')
        return {'text': value}
    if method == 'power':
        return read_power()
    if method == 'unlock':
        result = d.shell(['wm', 'dismiss-keyguard'])
        if getattr(result, 'exit_code', 0) != 0:
            raise AppStateError('UNLOCK_REQUIRED', '请在手机上完成解锁')
        return read_power()
    if method == 'appState':
        return applications.inventory(bool(params.get('refreshCatalog')))
    if method == 'navigation':
        return applications.navigation()
    if method == 'switchTask':
        return applications.switch_task(params['taskId'], params['fingerprint'])
    if method == 'snapshot':
        return tree()
    if method == 'focus':
        return focused()
    if method == 'info':
        return {'model': d.shell(['getprop', 'ro.product.model']).output.strip(),
                'android': d.shell(['getprop', 'ro.build.version.release']).output.strip(),
                'system': d.shell(['getprop', 'ro.build.version.incremental']).output.strip()}
    if method == 'clickNode':
        obj, info, bounds = text_object(params['selector'], params.get('instance', 0), params['bounds'])
        obj.click()
        return {'execution': 'sent'}
    if method in ('readText', 'setText'):
        window = current_window()
        if params.get('windowId') and window != params['windowId']:
            raise AppStateError('STALE_TARGET', 'Target window changed before text operation')
        obj, info, bounds = text_object(params['selector'], params.get('instance', 0), params['bounds'])
        if info.get('password'):
            raise AppStateError('PASSWORD_FIELD', 'Password fields cannot use text replacement or readback')
        if bounds != params['bounds']:
            raise AppStateError('STALE_TARGET', 'Target bounds changed before text operation')
        if current_window() != window:
            raise AppStateError('STALE_TARGET', 'Window changed before text operation')
        if method == 'readText':
            text = d.jsonrpc.getText(obj.selector) or ''
            if current_window() != window:
                raise AppStateError('STALE_TARGET', 'Window changed during text read')
            return {'text': text}
        if params['text']:
            if d.jsonrpc.setText(obj.selector, params['text']) is False:
                raise AppStateError('TEXT_WRITE_UNSUPPORTED', 'This widget does not support replacing text')
        else:
            d.jsonrpc.clearTextField(obj.selector)
        # Read the original target; autofocus advancing to another field is not a failed write.
        try:
            if current_window() != window:
                return {'written': True, 'verification': 'inconclusive'}
            obj, info, actual = text_object(params['selector'], params.get('instance', 0), params['bounds'], False)
            if actual != params['bounds'] or info.get('password'):
                return {'written': True, 'verification': 'inconclusive'}
            text = d.jsonrpc.getText(obj.selector) or ''
            if current_window() != window:
                return {'written': True, 'verification': 'inconclusive'}
            return {'written': True, 'text': text, 'verification': 'verified' if text == params['text'] else 'failed'}
        except Exception:
            return {'written': True, 'verification': 'inconclusive'}
    if method == 'openApp':
        return applications.open_app(params['packageName'], params.get('component'))
    if method == 'screenshot':
        import base64
        buffer = io.BytesIO()
        d.screenshot(format='pillow').save(buffer, format='PNG')
        data = buffer.getvalue()
        return {'mime': 'image/png' if data.startswith(b'\x89PNG') else 'image/jpeg', 'data': base64.b64encode(data).decode()}
    raise ValueError('Unsupported bridge method: ' + method)


applications = AppState(connect)

for line in sys.stdin:
    try:
        request = json.loads(line)
        result = invoke(request['method'], request.get('params', {}))
        response = {'id': request['id'], 'ok': True, 'result': result}
    except Exception as exc:
        response = {'id': locals().get('request', {}).get('id'), 'ok': False,
                    'error': str(exc), 'kind': type(exc).__name__,
                    'code': getattr(exc, 'code', 'BRIDGE_ERROR'), 'status': getattr(exc, 'status', 503)}
        if 'offline' in str(exc).lower() or 'device not found' in str(exc).lower():
            device = None
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + '\n')
    sys.stdout.flush()
