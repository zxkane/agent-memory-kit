import { execFileSync } from 'node:child_process';

// The notes clone must behave the same on every machine, so settings from the user's global
// configuration that change what is committed or how are overridden for every call. The global
// configuration itself stays in effect: the credential helper lives there.
const FIXED_CONFIG = [
  '-c', 'core.excludesFile=/dev/null',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'gc.autoDetach=false',
  '-c', 'core.quotePath=false',
];

// Built per call so that a change to process.env (tests) is seen. Pathspecs are literal:
// a note named `[ab].md` names that file and nothing else.
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1' });

export class GitError extends Error {
  constructor(args, result) {
    super(firstErrorLine(result.stderr) || `git ${args[0]} exited with ${result.code}`);
    this.name = 'GitError';
    this.result = result;
  }
}

// The most informative single line of Git's stderr: the first fatal/error line, else the first line.
export function firstErrorLine(stderr) {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? '';
}

// Exit code reported when git is killed for exceeding timeoutMs (as timeout(1) does).
export const TIMEOUT_CODE = 124;

// Runs git in repoDir. Throws GitError on a non-zero exit unless allowFail.
// `buffer: true` returns stdout as a Buffer (for blob contents).
// `timeoutMs` kills git after that long; the run then fails with TIMEOUT_CODE.
// `input` is written to git's stdin (for --batch commands).
export function git(repoDir, args, opts = {}) {
  const encoding = opts.buffer ? 'buffer' : 'utf8';
  let result;
  try {
    const stdout = execFileSync('git', ['-C', repoDir, ...FIXED_CONFIG, ...args], {
      env: gitEnv(), encoding, maxBuffer: 64 * 1024 * 1024,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // A string is encoded by execFileSync with the `encoding` option, which is 'buffer' here.
      input: opts.buffer && typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : opts.input,
      timeout: opts.timeoutMs ?? 0,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const timedOut = err.code === 'ETIMEDOUT';
    if (typeof err.status !== 'number' && !timedOut) throw err;
    const command = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? 'git';
    result = {
      code: timedOut ? TIMEOUT_CODE : err.status,
      stdout: err.stdout ?? (opts.buffer ? Buffer.alloc(0) : ''),
      stderr: timedOut
        ? `fatal: git ${command} timed out after ${opts.timeoutMs} ms\n${err.stderr ?? ''}`
        : String(err.stderr ?? ''),
    };
  }
  if (opts.allowFail) return result;
  throw new GitError(args, result);
}
