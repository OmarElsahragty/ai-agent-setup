// Stock (pre-P6/P7/P8) CloudCLI package for apply tests. The live install under
// node_modules is already patched, so it cannot serve as the "unpatched" fixture.
// Override with CLOUDCLI_STOCK_SRC=<package dir>.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TGZ = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cloudcli-stock-pre-p678.tgz');

export function stockSrc() {
    if (process.env.CLOUDCLI_STOCK_SRC) return process.env.CLOUDCLI_STOCK_SRC;
    const dir = `/var/tmp/claude/cloudcli-stock-${process.pid}`;
    const pkg = path.join(dir, 'cloudcli');
    if (!fs.existsSync(path.join(pkg, 'package.json'))) {
        fs.mkdirSync(dir, { recursive: true });
        const r = spawnSync('tar', ['-xzf', TGZ, '-C', dir], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`stock fixture extract failed: ${r.stderr}`);
        process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    }
    return pkg;
}
