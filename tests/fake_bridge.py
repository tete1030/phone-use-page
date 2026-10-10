import json
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    time.sleep(request.get('params', {}).get('delay', 0) / 1000)
    print(json.dumps({'id': request['id'], 'ok': True, 'result': request['method']}), flush=True)
