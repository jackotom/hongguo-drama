#!/usr/bin/env python3
"""Assert candidate metadata without invoking main, writing files or building."""
import ast
import json
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
build_file = ROOT / 'build.py'
module = runpy.run_path(str(build_file))
tree = ast.parse(build_file.read_text())
main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
sdk_index = next(i for i, node in enumerate(main.body)
                 if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'sdk' for t in node.targets))
preamble = compile(ast.Module(body=main.body[:sdk_index], type_ignores=[]), str(build_file), 'exec')
output_assignment = next(node for node in main.body if isinstance(node, ast.Assign)
                         and any(isinstance(t, ast.Name) and t.id == 'output' for t in node.targets))
receipt = next(node.args[0] for node in ast.walk(main) if isinstance(node, ast.Call)
               and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
               and node.func.value.id == 'json' and node.func.attr == 'dumps')


def metadata(tv, package=None):
    state = {**module, 'BUILD': ROOT / 'build'}
    original_read = Path.read_text

    def read(path, *args, **kwargs):
        if package is not None and path == ROOT / 'package.json':
            return json.dumps(package)
        return original_read(path, *args, **kwargs)

    with patch.object(sys, 'argv', ['metadata-check', *(['--tv'] if tv else [])]), \
         patch.object(Path, 'read_text', read), \
         patch.object(Path, 'mkdir', side_effect=AssertionError('must not write BUILD')), \
         patch.object(Path, 'is_file', side_effect=AssertionError('must validate before SDK checks')):
        exec(preamble, state)
    return state


tv = metadata(True)
assert (tv['version'], tv['version_code'], tv['tv_version']) == ('6.6', 60600, '6.6.0')
assert tv['desktop_version'] == '6.5.0'
assert tv['package_name'] == 'io.github.hongguo.tv'
assert tv['BUILD'] == ROOT / 'build/tv'
previous = 0
for candidate, name, code in [('6.6.0', '6.6', 60600), ('6.6.1', '6.6.1', 60601),
                              ('6.6.99', '6.6.99', 60699), ('6.7.0', '6.7', 60700),
                              ('6.9.9', '6.9.9', 60909), ('7.0.0', '7.0', 70000),
                              ('210000.0.0', '210000.0', 2100000000)]:
    assert module['tv_version_metadata'](candidate) == (name, code)
    assert code > previous
    previous = code

invalid = [None, '', 60600, True, [], {}, '6.6', '6.6.0.0', '06.6.0', '6.06.0', '6.6.00',
           '6.6.-1', '6.6.1.0', '6.6.0-beta', '6.6.0+local', ' 6.6.0', '6.6.0\n', '６.6.0',
           '6.100.0', '6.6.100', '0.0.0', '210000.0.1', '999999.0.0', '1000000.0.0']
for package in [{}, *[{'tvVersion': value} for value in invalid]]:
    try:
        metadata(True, package)
    except SystemExit as error:
        assert 'tvVersion' in str(error) or 'versionCode' in str(error)
    else:
        raise AssertionError(f'invalid TV version accepted: {package!r}')

phone = metadata(False, {'tvVersion': 'invalid'})
assert (phone['version'], phone['version_code'], phone['tv_version']) == ('1.1', 2, None)
assert phone['package_name'] == 'io.github.hongguo.personal'
assert phone['BUILD'] == ROOT / 'build'
for state, filename in [(tv, 'hongguo-downloader-6.6-android-tv-dev.apk'), (phone, 'hongguo-personal-1.1.apk')]:
    output = eval(compile(ast.Expression(output_assignment.value), str(build_file), 'eval'), state)
    assert output.name == filename
    state.update(output=SimpleNamespace(name=output.name, stat=lambda: SimpleNamespace(st_size=123)), checksum='test-only')
    result = eval(compile(ast.Expression(receipt), str(build_file), 'eval'), state)
    assert result['source_version'] == '6.5.0'
    assert result['version'] == state['version'] and result['candidate'] is state['tv']
    assert result['package'] == state['package_name']
    if state['tv']:
        assert (result['tv_version'], result['version_code']) == ('6.6.0', 60600)
    else:
        assert 'tv_version' not in result and 'version_code' not in result

print(f'PASS: TV 6.6/code60600; source 6.5.0; 7 monotonic versions; {len(invalid) + 1} invalid inputs fail before BUILD/SDK; phone 1.1/code2; APK names and receipts; no build')
