import { spawn } from 'child_process';
import * as fs from 'fs';

export interface MiniZincRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class MiniZincRunner {
  async run(
    solverName: string,
    modelPath: string,
    dznContent: string,
    tmpDir: string
  ): Promise<MiniZincRunResult> {
    const args = ['--solver', solverName, modelPath, '-'];

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const env = { ...process.env, TMPDIR: tmpDir };
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const minizinc = spawn('minizinc', args, { env });

      let stdout = '';
      let stderr = '';

      minizinc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      minizinc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      minizinc.on('error', (err) => {
        reject(err);
      });

      minizinc.on('close', (code) => {
        const durationMs = Date.now() - startTime;
        resolve({ code, stdout, stderr, durationMs });
      });

      minizinc.stdin.write(dznContent);
      minizinc.stdin.end();
    });
  }
}
