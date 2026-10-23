"""从 Git 提交生成程序包，排除测试、项目文档和私有运行文件。"""

from pathlib import Path, PurePosixPath
import argparse
import io
import json
import re
import subprocess
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRS = {
    '.git', '.runtime', 'node_modules', '.hvigor', '.hvigor-home', 'oh_modules',
    '__pycache__', '.idea', 'build', 'dist', 'validation', 'screenshots',
    'reports', 'backups', 'archive', 'test', 'tests', 'e2e', 'fixtures',
    'test-results', 'playwright-report', 'docs',
}
EXCLUDED_FILES = {'playwright.config.mjs', 'ui-test.cmd', '.gitignore', '.gitattributes'}
LICENSES = {
    'public/vendor/lottie-LICENSE.md',
    'licenses/opening_hours-LGPL-3.0-only.txt',
    'scripts/lib/UNISREC_LICENSE.txt',
}


def included(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Archive path is outside the project: ' + name)
    if name in LICENSES:
        return True
    if any(part in EXCLUDED_DIRS for part in path.parts) or path.name in EXCLUDED_FILES:
        return False
    if path.name.startswith('.env') and path.name != '.env.example':
        return False
    if path.suffix.lower() in {'.md', '.pdf', '.docx', '.pem', '.p12', '.pfx', '.key', '.dump', '.jks', '.keystore', '.pyc'}:
        return False
    if re.search(r'(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)', path.name, re.I):
        return False
    if path.parts[0] in {'scripts', 'deploy'} and re.match(r'(?:check|verify|ui-test)[_-]', path.name):
        return False
    return True


def snapshot(commit):
    raw = subprocess.check_output(['git', '-C', str(ROOT), 'archive', '--format=tar', commit])
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive:
            if item.isdir():
                continue
            if not item.isfile():
                raise ValueError('Unsupported archive entry: ' + item.name)
            if included(item.name):
                files[item.name] = archive.extractfile(item).read()
    return files


def prepare_manifest(files):
    package = json.loads(files['package.json'])
    package['scripts'] = {
        name: command for name, command in package['scripts'].items()
        if name != 'test' and not name.startswith(('test:', 'verify:', 'providers:'))
    }
    files['package.json'] = (json.dumps(package, ensure_ascii=False, indent=2) + '\n').encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', default='HEAD')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    commit = subprocess.check_output([
        'git', '-C', str(ROOT), 'rev-parse', '--verify', args.commit + '^{commit}'
    ], text=True).strip()
    files = snapshot(commit)
    prepare_manifest(files)
    for required in ['server/index.mjs', 'server/frontend.mjs', 'public/index.html',
                     'scripts/local.mjs', 'dev-local.cmd', 'package-lock.json',
                     'data/geonames/cities15000.txt', *LICENSES]:
        if required not in files:
            raise ValueError('Required package file is missing: ' + required)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.comment = ('seatraces source commit ' + commit).encode('ascii')
        for name, raw in sorted(files.items()):
            item = zipfile.ZipInfo('seatraces/' + name, (2026, 1, 1, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = (0o100755 if name.endswith('.sh') else 0o100644) << 16
            archive.writestr(item, raw)
    print(json.dumps({'commit': commit, 'files': len(files), 'output': str(args.output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
