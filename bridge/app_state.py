import hashlib
import json
import re
import time


COMPONENT = r'[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+'
RECORD = r'ActivityRecord\{(\S+) u(\d+) (' + COMPONENT + r') t(-?\d+)\b'


class AppStateError(RuntimeError):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code = code
        self.status = status


def parse_navigation(recents, activities, user_id):
    if 'ACTIVITY MANAGER RECENT TASKS' not in recents or 'ACTIVITY MANAGER ACTIVITIES' not in activities:
        raise RuntimeError('Unsupported or unavailable Android task dump')
    details = {}
    histories = list(re.finditer(r'^\s*\* Hist #(\d+): ' + RECORD, activities, re.M))
    for index, match in enumerate(histories):
        end = histories[index + 1].start() if index + 1 < len(histories) else len(activities)
        state = re.search(r'\bstate=([A-Z_]+)', activities[match.end():end])
        details[match[2]] = {'index': int(match[1]), 'token': match[2], 'userId': int(match[3]),
                            'component': match[4], 'state': state[1] if state else 'UNKNOWN'}
    resumed = re.search(r'^\s*(?:topResumedActivity|ResumedActivity): ' + RECORD, activities, re.M)
    if not resumed:
        candidates = list(re.finditer(r'^\s*mResumedActivity: ' + RECORD, activities, re.M))
        resumed = candidates[0] if len(candidates) == 1 else None
    current = {'taskId': int(resumed[4]), 'userId': int(resumed[2]), 'component': resumed[3]} if resumed else None
    heads = list(re.finditer(r'^\s*\* Recent #\d+: Task\{(\S+) #(\d+) ([^\n]+)', recents, re.M))
    tasks = []
    for index, match in enumerate(heads):
        end = heads[index + 1].start() if index + 1 < len(heads) else len(recents)
        block = recents[match.end():end].split('\n  Visible recent tasks')[0]
        user = re.search(r'\buserId=(\d+)', block)
        if not user or int(user[1]) != user_id:
            continue
        base = re.search(r'\bintent=\{[^\n]*\bcmp=(' + COMPONENT + r')', block)
        records_line = re.search(r'^\s*Activities=\[(.*)\]', block, re.M)
        records = []
        if records_line:
            for record in re.finditer(RECORD, records_line[1]):
                records.append(details.get(record[1], {'token': record[1], 'userId': int(record[2]),
                               'component': record[3], 'state': 'UNKNOWN', 'index': len(records)}))
        task_id = int(match[2])
        component = base[1] if base else (records[0]['component'] if records else '')
        kind = re.search(r'\btype=(\w+)', match[3])
        available = bool(re.search(r'\bisAvailable=true\b', block))
        identity = [match[1], task_id, user_id, component]
        tasks.append({'taskId': task_id, 'userId': user_id, 'type': kind[1] if kind else 'unknown',
                      'baseComponent': component, 'packageName': component.split('/')[0],
                      'activities': records, 'topComponent': records[-1]['component'] if records else None,
                      'foreground': bool(current and current['taskId'] == task_id and current['userId'] == user_id),
                      'available': available, 'switchable': available and bool(records),
                      'fingerprint': hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]})
    return {'userId': user_id, 'tasks': tasks, 'current': current, 'internalStack': 'unknown'}


def parse_processes(output, packages, user_id=0):
    if not re.match(r'\s*PID\s+UID\s+NAME', output):
        raise RuntimeError('Unsupported Android process listing')
    result = {}
    for line in output.splitlines()[1:]:
        fields = line.split()
        if len(fields) != 3 or not fields[0].isdigit():
            continue
        uid_user = int(fields[1]) // 100000 if fields[1].isdigit() else None
        if uid_user != user_id:
            continue
        package = fields[2].split(':', 1)[0]
        if package in packages:
            result.setdefault(package, []).append({'pid': int(fields[0]), 'uid': fields[1], 'name': fields[2]})
    return result


class AppState:
    def __init__(self, connect):
        self.connect = connect
        self.catalog_cache = None
        self.catalog_at = 0

    def shell(self, args):
        result = self.connect().shell(args)
        if getattr(result, 'exit_code', 0) != 0 or re.search(r'Permission Denial|SecurityException|^Error:', result.output, re.M):
            raise RuntimeError('Android command unavailable: ' + result.output.strip()[:300])
        return result.output

    def user(self):
        value = self.shell(['am', 'get-current-user']).strip()
        if not value.isdigit():
            raise RuntimeError('Cannot establish current Android user')
        return int(value)

    def catalog(self, refresh=False):
        user = self.user()
        if not refresh and self.catalog_cache and self.catalog_cache['userId'] == user and time.monotonic() - self.catalog_at < 60:
            return self.catalog_cache
        def packages(args):
            output = self.shell(args)
            return set(re.findall(r'^package:([^\s]+)', output, re.M))
        all_packages = packages(['pm', 'list', 'packages', '--user', str(user)])
        third_party = packages(['pm', 'list', 'packages', '-3', '--user', str(user)])
        output = self.shell(['cmd', 'package', 'query-activities', '--brief', '--components', '--user', str(user),
                             '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'])
        launchers = {}
        for line in output.splitlines():
            component = line.strip()
            if re.fullmatch(COMPONENT, component):
                launchers.setdefault(component.split('/')[0], set()).add(component)
        if self.user() != user:
            raise RuntimeError('Android user changed during catalog capture')
        self.catalog_cache = {'userId': user, 'collectedAt': int(time.time() * 1000),
                              'apps': [{'packageName': package, 'thirdParty': package in third_party,
                                        'launchers': sorted(launchers.get(package, []))} for package in sorted(all_packages)]}
        self.catalog_at = time.monotonic()
        return self.catalog_cache

    def navigation(self):
        user = self.user()
        recents = self.shell(['dumpsys', 'activity', 'recents'])
        activities = self.shell(['dumpsys', 'activity', 'activities'])
        result = parse_navigation(recents, activities, user)
        policy = self.shell(['dumpsys', 'window', 'policy'])
        locked = re.search(r'\bmIsShowing=(true|false)', policy)
        if self.user() != user:
            raise RuntimeError('Android user changed during task capture')
        result.update(locked=locked[1] == 'true' if locked else None, collectedAt=int(time.time() * 1000))
        return result

    def inventory(self, refresh=False):
        catalog = self.catalog(refresh)
        navigation = self.navigation()
        if catalog['userId'] != navigation['userId']:
            raise RuntimeError('Android user changed during app capture')
        processes = parse_processes(self.shell(['ps', '-A', '-o', 'PID,UID,NAME']), {a['packageName'] for a in catalog['apps']}, catalog['userId'])
        if self.user() != catalog['userId']:
            raise RuntimeError('Android user changed during process capture')
        return {'catalog': catalog, 'navigation': navigation,
                'processes': [{'packageName': package, 'processes': rows} for package, rows in sorted(processes.items())],
                'collectedAt': int(time.time() * 1000),
                'processScope': 'Visible processes matched by package name; cached/services included, custom/isolated names may be missing'}

    def open_app(self, package, component=None):
        if not isinstance(package, str) or not re.fullmatch(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+', package):
            raise ValueError('Invalid package name')
        catalog = self.catalog(True)
        app = next((a for a in catalog['apps'] if a['packageName'] == package), None)
        if not app or not app['launchers']:
            raise AppStateError('NO_LAUNCHER', 'Package has no available launcher entry for the current user')
        if component is None:
            output = self.shell(['cmd', 'package', 'resolve-activity', '--brief', '--user', str(catalog['userId']),
                                 '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', package])
            component = next((line.strip() for line in output.splitlines() if line.strip() in app['launchers']), None)
        if component not in app['launchers']:
            raise AppStateError('STALE_COMPONENT', 'Choose a valid launcher component for this package')
        nav = self.navigation()
        if nav['locked'] is not False or nav['userId'] != catalog['userId']:
            raise AppStateError('DEVICE_LOCKED', 'Unlock the phone and verify its current user before launching')
        output = self.shell(['am', 'start', '-W', '--user', str(catalog['userId']), '-a', 'android.intent.action.MAIN',
                             '-c', 'android.intent.category.LAUNCHER', '-n', component])
        if not re.search(r'^Status: ok\s*$', output, re.M):
            raise RuntimeError('Android did not confirm launcher start: ' + output.strip()[:300])
        return {'packageName': package, 'component': component, 'userId': catalog['userId'], 'backend': 'am-start-launcher'}

    def switch_task(self, task_id, fingerprint):
        if type(task_id) is not int or task_id < 0:
            raise ValueError('Invalid task ID')
        before = self.navigation()
        task = next((t for t in before['tasks'] if t['taskId'] == task_id), None)
        if not task or task['fingerprint'] != fingerprint:
            raise AppStateError('STALE_TASK', 'Task identity changed; refresh the task list')
        if not task['switchable'] or before['locked'] is not False:
            raise AppStateError('UNAVAILABLE_TASK', 'Task cannot be focused or phone is locked')
        self.shell(['am', 'task', 'focus', str(task_id)])
        for attempt in range(8):
            after = self.navigation()
            if after['current'] and after['current']['taskId'] == task_id and after['userId'] == before['userId'] and after['locked'] is False:
                return {'taskId': task_id, 'current': after['current'], 'backend': 'am-task-focus'}
            time.sleep(0.1)
        raise AppStateError('TASK_VERIFY_FAILED', 'Android did not resume the requested task; no launcher fallback was attempted')
