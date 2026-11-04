"""Compile-independent native preview runner. Never publishes or changes a mirror."""
import argparse
import base64
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

parser = argparse.ArgumentParser()
parser.add_argument('--electron', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--lang', default='zh-CN')
parser.add_argument('--filter', default='')
parser.add_argument('--force-high-contrast', action='store_true',
                    help='Force Chromium high contrast in this test process without changing Windows settings')
parser.add_argument('--timeout', default=300, type=int,
                    help='Maximum runtime in seconds; only the test process tree is stopped on expiry')
args = parser.parse_args()
if args.timeout <= 0:
    parser.error('--timeout must be a positive integer')
binary = args.electron.resolve(strict=True)
args.output.mkdir(parents=True, exist_ok=True)
report = args.output / 'results.json'
report.unlink(missing_ok=True)
started_utc = datetime.now(timezone.utc).isoformat()
binary_sha256 = hashlib.file_digest(binary.open('rb'), 'sha256').hexdigest()
env = {key.upper(): value for key, value in os.environ.items()}
env.pop('ELECTRON_RUN_AS_NODE', None)
env.update(NATIVE_UI_OUTPUT=str(args.output.resolve()), NATIVE_UI_LANG=args.lang,
           NATIVE_UI_PYTHON=sys.executable, NATIVE_UI_FILTER=args.filter, PYTHONIOENCODING='utf-8',
           NATIVE_UI_FORCE_HIGH_CONTRAST='1' if args.force_high_contrast else '0')
helper = Path(__file__).with_name('native-panels-win.py')


def native(request):
    encoded = base64.b64encode(json.dumps({'pid': os.getpid(), **request}).encode()).decode()
    result = subprocess.run([sys.executable, str(helper), encoded], capture_output=True,
                            text=True, encoding='utf-8', check=True)
    return json.loads(result.stdout)


desktop = native({'action': 'windows'})
try:
    with (args.output / 'run.log').open('w', encoding='utf-8') as log:
        command = [str(binary), str(Path(__file__).with_name('native-ui-preview.cjs')),
                   '--force-renderer-accessibility']
        if args.force_high_contrast:
            command.append('--force-high-contrast')
        process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            status = process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'], capture_output=True, check=False)
            status = 124
finally:
    native({'action': 'restore', 'foreground': desktop['foreground'], 'cursor': desktop['cursor']})
if report.exists():
    data = json.loads(report.read_text(encoding='utf-8'))
    data.update(executableSha256=binary_sha256, startedUtc=started_utc,
                fixtureSha256=hashlib.file_digest(Path(__file__).with_name('native-ui-preview.cjs').open('rb'), 'sha256').hexdigest(),
                helperSha256=hashlib.file_digest(helper.open('rb'), 'sha256').hexdigest(),
                runnerSha256=hashlib.file_digest(Path(__file__).open('rb'), 'sha256').hexdigest(),
                filter=args.filter, language=args.lang, forceHighContrast=args.force_high_contrast)
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'summary': data['summary'], 'failures': [r for r in data['results'] if not r['ok']]}, ensure_ascii=False))
else:
    print(f'No report. Exit {status}; inspect {args.output / "run.log"}')
raise SystemExit(status)
