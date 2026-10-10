import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'bridge'))
from app_state import AppState, parse_navigation, parse_processes


RECENTS = '''ACTIVITY MANAGER RECENT TASKS (dumpsys activity recents)
  * Recent #0: Task{first #12 type=standard U=0 sz=2}
    userId=0
    intent={cmp=app.one/.Main}
    Activities=[ActivityRecord{root u0 app.one/.Main t12}, ActivityRecord{top u0 app.two/.Detail t12}]
    inRecents=true isAvailable=true
  * Recent #1: Task{second #13 type=standard U=0 sz=0}
    userId=0
    intent={cmp=app.one/.Main}
    Activities=[]
    inRecents=true isAvailable=true
  * Recent #2: Task{work #99 type=standard U=10 sz=1}
    userId=10
    intent={cmp=app.work/.Main}
    Activities=[ActivityRecord{workroot u10 app.work/.Main t99}]
    inRecents=true isAvailable=true
'''
ACTIVITIES = '''ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
    * Hist #1: ActivityRecord{top u0 app.two/.Detail t12}
       state=RESUMED stopped=false
    * Hist #0: ActivityRecord{root u0 app.one/.Main t12}
       state=STOPPED stopped=true
  ResumedActivity: ActivityRecord{top u0 app.two/.Detail t12}
'''


class AppStateTests(unittest.TestCase):
    def test_tasks_preserve_cross_package_top_and_exclude_other_users(self):
        nav = parse_navigation(RECENTS, ACTIVITIES, 0)
        self.assertEqual([t['taskId'] for t in nav['tasks']], [12, 13])
        task = nav['tasks'][0]
        self.assertEqual(task['topComponent'], 'app.two/.Detail')
        self.assertEqual(task['activities'][0]['state'], 'STOPPED')
        self.assertEqual(nav['current']['taskId'], 12)
        self.assertEqual(nav['internalStack'], 'unknown')

    def test_empty_history_is_not_a_switchable_running_task(self):
        tasks = parse_navigation(RECENTS, ACTIVITIES, 0)['tasks']
        self.assertFalse(tasks[1]['switchable'])
        self.assertNotEqual(tasks[0]['fingerprint'], tasks[1]['fingerprint'])

    def test_task_identity_is_stable_across_front_state_changes_but_not_id_reuse(self):
        first = parse_navigation(RECENTS, ACTIVITIES, 0)['tasks'][0]
        paused = parse_navigation(RECENTS, ACTIVITIES.replace('RESUMED', 'STOPPED'), 0)['tasks'][0]
        reused = parse_navigation(RECENTS.replace('Task{first', 'Task{reused'), ACTIVITIES, 0)['tasks'][0]
        self.assertEqual(first['fingerprint'], paused['fingerprint'])
        self.assertNotEqual(first['fingerprint'], reused['fingerprint'])

    def test_invalid_dump_is_not_reported_as_an_empty_valid_list(self):
        with self.assertRaises(RuntimeError):
            parse_navigation('Permission Denial', ACTIVITIES, 0)

    def test_process_mapping_includes_subprocess_but_excludes_other_users_and_unknown_names(self):
        output = 'PID UID NAME\n1 10234 app.one\n2 10234 app.one:worker\n3 1010234 app.one\n4 10234 custom.worker\n'
        processes = parse_processes(output, {'app.one'}, 0)
        self.assertEqual([p['pid'] for p in processes['app.one']], [1, 2])

    def fixture(self):
        state = AppState(lambda: None)
        nav = parse_navigation(RECENTS, ACTIVITIES, 0)
        nav['locked'] = False
        state.navigation = lambda: nav
        state.commands = []
        state.shell = lambda args: state.commands.append(args) or 'Status: ok\n'
        state.catalog = lambda refresh=False: {'userId': 0, 'apps': [
            {'packageName': 'app.one', 'launchers': ['app.one/.Main']},
            {'packageName': 'app.service', 'launchers': []}]}
        return state, nav

    def test_stale_task_does_not_send_focus_or_launcher(self):
        state, nav = self.fixture()
        with self.assertRaises(RuntimeError):
            state.switch_task(12, 'stale')
        self.assertEqual(state.commands, [])

    def test_switch_uses_task_focus_without_relaunching(self):
        state, nav = self.fixture()
        result = state.switch_task(12, nav['tasks'][0]['fingerprint'])
        self.assertEqual(state.commands, [['am', 'task', 'focus', '12']])
        self.assertEqual(result['taskId'], 12)

    def test_launch_rejects_no_entry_and_foreign_component_without_starting(self):
        state, _ = self.fixture()
        with self.assertRaises(RuntimeError):
            state.open_app('app.service')
        with self.assertRaises(RuntimeError):
            state.open_app('app.one', 'app.two/.Other')
        self.assertEqual(state.commands, [])

    def test_launch_does_not_force_stop_or_accept_shell_text(self):
        state, _ = self.fixture()
        state.open_app('app.one', 'app.one/.Main')
        self.assertNotIn('-S', state.commands[-1])
        with self.assertRaises(ValueError):
            state.open_app('app.one; reboot', 'app.one/.Main')


if __name__ == '__main__':
    unittest.main()
