"""Run acceptance against an explicit newly built Electron executable."""
import argparse
import base64
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument('--electron', required=True, type=Path)
parser.add_argument('--output', type=Path, default=Path(__file__).with_name('native-panels-results.json'))
parser.add_argument('--timeout', type=int, default=240)
args = parser.parse_args()
binary = args.electron.resolve(strict=True)
probe = Path(__file__).with_name('native-panels.cjs')
env = dict(os.environ)
env.pop('ELECTRON_RUN_AS_NODE', None)
env['NATIVE_PANELS_REPORT'] = str(args.output.resolve())
env['NATIVE_PANELS_PYTHON'] = os.sys.executable
env['NATIVE_PANELS_BINARY_SHA256'] = hashlib.file_digest(binary.open('rb'), 'sha256').hexdigest()
env['NATIVE_PANELS_STARTED_UTC'] = datetime.now(timezone.utc).isoformat()
log_path = args.output.with_suffix('.log')


def native(request):
    encoded = base64.b64encode(json.dumps({'pid': os.getpid(), **request}).encode()).decode()
    result = subprocess.run([os.sys.executable, str(probe.with_name('native-panels-win.py')), encoded],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def run_probe(script, log_file, environment, timeout):
    with log_file.open('w', encoding='utf-8') as log:
        process = subprocess.Popen([str(binary), str(script), '--force-renderer-accessibility'],
                                   env=environment, stdout=log, stderr=subprocess.STDOUT)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                           capture_output=True, check=False)
            return 124


args.output.parent.mkdir(parents=True, exist_ok=True)
if args.output.exists():
    args.output.unlink()
desktop = native({'action': 'windows'})
edge_report = args.output.with_name(args.output.stem + '-page-info-edges.json')
edge_log = edge_report.with_suffix('.log')
if edge_report.exists():
    edge_report.unlink()
try:
    status = run_probe(probe, log_path, env, args.timeout)
    edge_env = {**env, 'NATIVE_PAGE_INFO_REPORT': str(edge_report.resolve())}
    edge_status = run_probe(probe.with_name('page-info-snapshot-edges.cjs'), edge_log, edge_env, 60)
finally:
    native({'action': 'restore', 'foreground': desktop['foreground'], 'cursor': desktop['cursor']})
if not args.output.exists():
    args.output.write_text(json.dumps({
        'suite': 'native-panels', 'executable': str(binary),
        'executableSha256': env['NATIVE_PANELS_BINARY_SHA256'],
        'startedAtUtc': env['NATIVE_PANELS_STARTED_UTC'],
        'completedAtUtc': datetime.now(timezone.utc).isoformat(),
        'summary': {'total': 1, 'passed': 0, 'failed': 1},
        'results': [{'name': 'Electron process completed', 'ok': False,
                     'error': f'Probe exited without writing a report (exit {status}); inspect {log_path}'}]
    }, indent=2), encoding='utf-8')
report = json.loads(args.output.read_text(encoding='utf-8'))
if edge_report.exists():
    edges = json.loads(edge_report.read_text(encoding='utf-8'))
    report['results'].extend([{**item, 'name': 'PageInfo edge: ' + item['name']} for item in edges['results']])
    report['supplementary'] = {'pageInfoSnapshotEdges': {'report': str(edge_report), 'summary': edges['summary'], 'exitCode': edge_status}}
else:
    report['results'].append({'name': 'PageInfo edge process completed', 'ok': False,
                              'error': f'No supplemental report (exit {edge_status}); inspect {edge_log}'})
failed = sum(not item['ok'] for item in report['results'])
report['summary'] = {'total': len(report['results']), 'passed': len(report['results']) - failed, 'failed': failed}
report['completedAtUtc'] = datetime.now(timezone.utc).isoformat()
args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
status = status or edge_status or (1 if failed else 0)
print(f'Acceptance exit: {status}; report: {args.output}; log: {log_path}; edge log: {edge_log}')
print(json.dumps(report['summary'], ensure_ascii=False))
raise SystemExit(status)
