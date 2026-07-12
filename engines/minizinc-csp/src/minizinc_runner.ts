import { spawn } from 'child_process';
import * as fs from 'fs';

export interface MiniZincStdoutEvent {
  atMs: number;
  text: string;
}

export interface MiniZincRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutEvents: MiniZincStdoutEvent[];
}

export class MiniZincRunner {
  async run(
    solverName: string,
    modelPath: string,
    dznContent: string,
    tmpDir: string,
    extraArgs: string[] = []
  ): Promise<MiniZincRunResult> {
    const args = ['--solver', solverName, ...extraArgs, modelPath, '-'];

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const env = { ...process.env, TMPDIR: tmpDir };
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const minizinc = spawn('minizinc', args, { env });

      let stdout = '';
      let stderr = '';
      const stdoutEvents: MiniZincStdoutEvent[] = [];

      minizinc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        stdoutEvents.push({ atMs: Date.now() - startTime, text });
      });
      minizinc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      minizinc.on('error', (err) => {
        reject(err);
      });

      minizinc.on('close', (code) => {
        const durationMs = Date.now() - startTime;
        resolve({ code, stdout, stderr, durationMs, stdoutEvents });
      });

      minizinc.stdin.write(dznContent);
      minizinc.stdin.end();
    });
  }
}
