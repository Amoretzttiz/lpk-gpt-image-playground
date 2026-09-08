#!/usr/bin/env python3
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
commit = (root / 'UPSTREAM_COMMIT').read_text(encoding='ascii').strip()
repository = os.environ.get(
    'UPSTREAM_REPOSITORY',
    'https://github.com/CookSleep/gpt_image_playground.git',
)

with tempfile.TemporaryDirectory() as temp:
    checkout = Path(temp) / 'repo'
    subprocess.run(['git', 'init', '-q', str(checkout)], check=True)
    subprocess.run(
        ['git', '-C', str(checkout), 'fetch', '-q', '--depth=1', repository, commit],
        check=True,
    )
    raw = subprocess.check_output(
        ['git', '-C', str(checkout), 'ls-tree', '-rz', commit]
    )

expected = {}
for entry in raw.rstrip(b'\0').split(b'\0'):
    metadata, path = entry.split(b'\t', 1)
    mode, kind, blob = metadata.split(b' ')
    if kind != b'blob':
        raise SystemExit(f'Unexpected upstream tree entry type: {kind.decode()}')
    expected[path.decode('utf-8')] = (mode.decode('ascii'), blob.decode('ascii'))

raw = subprocess.check_output(
    ['git', '-C', str(root), 'ls-files', '-s', '--', 'upstream']
)
tracked = {}
for line in raw.decode('utf-8').splitlines():
    metadata, path = line.split('\t', 1)
    mode, blob, stage = metadata.split(' ')
    if stage != '0':
        raise SystemExit(f'Unmerged upstream path: {path}')
    tracked[path.removeprefix('upstream/')] = (mode, blob)

if expected.keys() != tracked.keys():
    missing = sorted(expected.keys() - tracked.keys())
    added = sorted(tracked.keys() - expected.keys())
    raise SystemExit(f'Upstream tracked path mismatch; missing={missing}, added={added}')

for path, (expected_mode, expected_blob) in expected.items():
    tracked_mode, tracked_blob = tracked[path]
    if (tracked_mode, tracked_blob) != (expected_mode, expected_blob):
        raise SystemExit(f'Upstream index mismatch: {path}')
    data = (root / 'upstream' / path).read_bytes()
    actual_blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    if actual_blob != expected_blob:
        raise SystemExit(f'Upstream working-tree content mismatch: {path}')

print(
    f'Verified {len(expected)} tracked upstream files, modes, index blobs, and '
    f'working-tree bytes against CookSleep/gpt_image_playground commit {commit}'
)
