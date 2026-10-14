// A stand-in for the `minizinc` executable, run as a REAL child process by the engine's tests
// (and by `tools/engine_e2e.py --fake-minizinc`). It reads the model data on stdin like MiniZinc,
// then behaves as FAKE_MINIZINC_MODE says:
//
//   solve (default)  prints FAKE_MINIZINC_STDOUT_FILE (or a canned incumbent) after
//                    FAKE_MINIZINC_DELAY_MS and exits with FAKE_MINIZINC_EXIT_CODE.
//                    It proves the engine's plumbing, NOT the MiniZinc model.
//   hang             never finishes: it prints a first incumbent, starts a GRANDCHILD in the same
//                    process group (a solver backend such as fzn-gecode) and burns CPU in both.
//   reject           prints a MiniZinc-style rejection on stderr and exits 1.
//
// Switches for `hang`: FAKE_MINIZINC_CPU=0 sleeps instead of burning CPU; FAKE_MINIZINC_IGNORE_TERM=1
// ignores SIGTERM (only SIGKILL stops it; FAKE_MINIZINC_GRANDCHILD_IGNORE_TERM=1 does so for the grandchild
// alone); FAKE_MINIZINC_GRANDCHILD_STDIO=ignore gives the grandchild no
// pipes, so the leader's 'close' fires while the grandchild is still alive; FAKE_MINIZINC_PIDFILE gets
// {"pid","grandchild"} once both run; FAKE_MINIZINC_ARGS_FILE gets {"argv","stdinBytes","tmpdir"};
// FAKE_MINIZINC_LIFETIME_MS (default 120000) bounds the life of a forgotten process.
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const role = process.env.FAKE_MINIZINC_ROLE || 'leader';
const mode = process.env.FAKE_MINIZINC_MODE || 'solve';
const lifetimeMs = Number(process.env.FAKE_MINIZINC_LIFETIME_MS || 120000);
const startedAt = Date.now();

if (process.env.FAKE_MINIZINC_IGNORE_TERM === '1'
    || (role === 'grandchild' && process.env.FAKE_MINIZINC_GRANDCHILD_IGNORE_TERM === '1')) {
  process.on('SIGTERM', () => {});
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function occupy() {
  if (process.env.FAKE_MINIZINC_CPU === '0') {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(3), lifetimeMs);
    return;
  }
  for (;;) {
    let x = 0;
    for (let i = 0; i < 5e6; i += 1) x += Math.sqrt(i);
    if (x < 0 || Date.now() - startedAt > lifetimeMs) process.exit(3);
  }
}

if (role === 'grandchild') {
  occupy();
} else {
  const input = await readStdin();
  if (process.env.FAKE_MINIZINC_ARGS_FILE) {
    writeJson(process.env.FAKE_MINIZINC_ARGS_FILE, {
      argv: process.argv.slice(2), stdinBytes: input.length, tmpdir: process.env.TMPDIR || null,
    });
  }
  if (mode === 'hang') {
    const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, FAKE_MINIZINC_ROLE: 'grandchild' },
      stdio: process.env.FAKE_MINIZINC_GRANDCHILD_STDIO === 'ignore' ? 'ignore' : 'inherit',
    });
    if (process.env.FAKE_MINIZINC_PIDFILE) {
      writeJson(process.env.FAKE_MINIZINC_PIDFILE, { pid: process.pid, grandchild: grandchild.pid });
    }
    process.stdout.write('{"selected_cand":[1],"objective_value":1}\n----------\n');
    occupy();
  } else if (mode === 'reject') {
    process.stderr.write('Error: the fake solver rejects this model\n');
    process.exit(1);
  } else {
    const delay = Number(process.env.FAKE_MINIZINC_DELAY_MS || 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const file = process.env.FAKE_MINIZINC_STDOUT_FILE;
    process.stdout.write(file
      ? readFileSync(file, 'utf8')
      : '{"selected_cand":[1],"objective_value":0}\n----------\n==========\n');
    process.exit(Number(process.env.FAKE_MINIZINC_EXIT_CODE || 0));
  }
}
