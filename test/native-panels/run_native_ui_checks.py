"""Run scoped native UI checks; reserve the complete preview for explicit requests."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


SCOPES = {
    'focus': '^focus ring:',
    'menu': '^(menu|default menu|locale menu)',
    'textarea': '^textarea:',
    'scrollbars': '^(scrollbars:|scrollbar placement:)',
    'material': '^acrylic',
    'page-info': '^PageInfo:',
    'all': '',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--electron', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--scope', choices=SCOPES, default=None,
                           help='Defaults to focus; all runs the complete preview')
    selection.add_argument('--case', help='Exact failed case name to rerun')
    parser.add_argument('--lang', default='zh-CN')
    parser.add_argument('--timeout', default=300, type=int)
    parser.add_argument('--dry-run', action='store_true', help='Print the selected command without opening UI')
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    if args.case is not None:
        if not args.case:
            parser.error('--case must be a nonempty case name')
        # Escape a literal name for JavaScript RegExp, including line separators.
        escaped = ''.join('\\' + char if char in r'\^$.*+?()[]{}|' else char for char in args.case)
        pattern = '^' + escaped.replace('\n', r'\n').replace('\r', r'\r') + '$'
    else:
        pattern = SCOPES[args.scope or 'focus']
    command = [sys.executable, str(Path(__file__).with_name('run_native_ui_preview.py')),
               '--electron', str(args.electron), '--output', str(args.output),
               '--lang', args.lang, '--timeout', str(args.timeout), '--filter', pattern]
    if args.dry_run:
        print(subprocess.list2cmdline(command))
        return 0
    status = subprocess.call(command)
    if status == 0:
        report = args.output / 'results.json'
        if not report.is_file() or json.loads(report.read_text(encoding='utf-8-sig'))['summary']['total'] == 0:
            print('No matching UI cases were verified; check --scope or --case.', file=sys.stderr)
            return 2
    return status


if __name__ == '__main__':
    raise SystemExit(main())
