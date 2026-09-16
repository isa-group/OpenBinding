"""Materialize explicitly authored shared resources into standalone BIM packages."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[1] / 'examples'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail on divergent generated resources without writing.')
    args = parser.parse_args()
    manifest = json.loads((EXAMPLES / 'library/manifest.json').read_text())
    divergent = []
    count = 0
    for resource in manifest['resources']:
        authored = json.loads((EXAMPLES / resource['source']).read_text())
        for output in resource['outputs']:
            document = {**authored, **({'metadata': output['metadata']} if 'metadata' in output else {})}
            target = EXAMPLES / output['path']
            count += 1
            if args.check:
                if not target.exists() or json.loads(target.read_text()) != document:
                    divergent.append(output['path'])
            else:
                target.write_text(json.dumps(document, indent=2, ensure_ascii=False) + '\n')
    for path in divergent:
        print(f'Divergent generated resource: {path}')
    print(f'Shared examples: {len(manifest["resources"])} authored resources, {count} package uses, {len(divergent)} divergences')
    return bool(divergent)


if __name__ == '__main__':
    raise SystemExit(main())
