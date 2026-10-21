// A stand-in for the `minizinc` and `fzn-gecode` executables, run as REAL child processes by the
// engine's tests (and by `tools/engine_e2e.py --fake-minizinc`). The runner calls it once per phase,
// like the real tools, and the phase is read from the arguments:
//
//   flatten  (`-c ... --fzn F --ozn O`)  writes a trivial FlatZinc and output specification, exits 0;
//                                        in `reject` mode prints a MiniZinc-style rejection and exits 1.
//   render   (`--ozn-file O`)            copies stdin to stdout (the solns2out pass).
//   solve    (anything else: fzn-gecode) behaves as FAKE_MINIZINC_MODE says:
//
//   solve (default)  prints FAKE_MINIZINC_STDOUT_FILE (or a canned incumbent) after
//                    FAKE_MINIZINC_DELAY_MS and exits with FAKE_MINIZINC_EXIT_CODE.
//                    It proves the engine's plumbing, NOT the MiniZinc model.
//   hang             never finishes: it prints a first incumbent, starts a GRANDCHILD in the same
//                    process group (a solver backend such as fzn-gecode) and burns CPU in both.
//
// Switches for `hang`: FAKE_MINIZINC_CPU=0 sleeps instead of burning CPU; FAKE_MINIZINC_IGNORE_TERM=1
// ignores SIGTERM (only SIGKILL stops it; FAKE_MINIZINC_GRANDCHILD_IGNORE_TERM=1 does so for the grandchild
// alone); FAKE_MINIZINC_GRANDCHILD_STDIO=ignore gives the grandchild no
// pipes, so the leader's 'close' fires while the grandchild is still alive; FAKE_MINIZINC_PIDFILE gets
// {"pid","grandchild"} once both run. FAKE_MINIZINC_ARGS_FILE gets one {"phase","argv","stdinBytes",
// "dznBytes","tmpdir"} per invocation, in order (a JSON array). FAKE_MINIZINC_LIFETIME_MS (default
// 120000) bounds the life of a forgotten process.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

const CANNED = 'selected_candidate = array1d(1..1, [1]);\nobjective_value = 0;\n----------\n==========\n';

function argAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function recordArgs(entry) {
  const file = process.env.FAKE_MINIZINC_ARGS_FILE;
  if (!file) return;
  let seen = [];
  try {
    seen = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  } catch {
    seen = [];
  }
  writeJson(file, [...seen, entry]);
}

if (role === 'grandchild') {
  occupy();
} else {
  const argv = process.argv.slice(2);
  const input = await readStdin();
  const phase = argv.includes('-c') ? 'flatten' : argv.includes('--ozn-file') ? 'render' : 'solve';
  let dznBytes = null;
  if (phase === 'flatten') {
    const dzn = argv[argv.indexOf('-c') + 2];
    try { dznBytes = readFileSync(dzn).length; } catch { dznBytes = null; }
  }
  recordArgs({ phase, argv, stdinBytes: input.length, dznBytes, tmpdir: process.env.TMPDIR || null });
  if (phase === 'flatten') {
    if (mode === 'reject') {
      process.stderr.write('Error: the fake solver rejects this model\n');
      process.exit(1);
    }
    writeFileSync(argAfter(argv, '--fzn'), 'array [1..1] of var 1..1: selected_candidate:: output_array([1..1]);\nsolve satisfy;\n');
    writeFileSync(argAfter(argv, '--ozn'), '');
    process.exit(0);
  } else if (phase === 'render') {
    process.stdout.write(input);
    process.exit(0);
  } else if (mode === 'hang') {
    const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, FAKE_MINIZINC_ROLE: 'grandchild' },
      stdio: process.env.FAKE_MINIZINC_GRANDCHILD_STDIO === 'ignore' ? 'ignore' : 'inherit',
    });
    if (process.env.FAKE_MINIZINC_PIDFILE) {
      writeJson(process.env.FAKE_MINIZINC_PIDFILE, { pid: process.pid, grandchild: grandchild.pid });
    }
    process.stdout.write('selected_candidate = array1d(1..1, [1]);\nobjective_value = 1;\n----------\n');
    occupy();
  } else {
    const delay = Number(process.env.FAKE_MINIZINC_DELAY_MS || 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const file = process.env.FAKE_MINIZINC_STDOUT_FILE;
    process.stdout.write(file ? readFileSync(file, 'utf8') : CANNED);
    process.exit(Number(process.env.FAKE_MINIZINC_EXIT_CODE || 0));
  }
}
