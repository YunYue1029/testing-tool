// Running a shell command as a flow step. Not everything a feature needs
// proving is HTTP: a row landing in the database, a file appearing on disk, a
// queue draining, a migration applying. Each of those is one `docker exec`
// away, and a flow that can run one between its requests checks the feature
// instead of just its API.
//
// This is not a sandbox, and is not trying to be. The command runs as this
// process with its privileges — the same trust runScript in runner.ts already
// assumes, where a post-response script is the user's own code on the user's
// own machine. It is why the server binds loopback.
import { exec, spawn } from 'node:child_process';
import type { ChildProcessByStdio, ExecException } from 'node:child_process';
import crypto from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { CommandResult } from './types.ts';

// Output past this is neither read by a person nor matched by an assertion.
// Far more than a test command prints, far less than a stray `docker logs`
// needs to wedge the run.
const MAX_OUTPUT = 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 600000;

// A command that never produced a verdict — it could not start, it ran out of
// time, or the run was cancelled. Distinct from a command that ran and exited
// non-zero, which is a result the step gets to assert on.
class CommandError extends Error {
  hint: string | undefined;
  cancelled?: boolean;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

export interface RunCommandArgs {
  command?: string;
  cwd?: string;
  timeout?: number;
  abortSignal?: AbortSignal;
}

// exec reports a failure to start with a string code (ENOENT), which the
// published type does not admit to.
type ExecErr = ExecException & { code?: number | string };

// Run one command through the shell, resolving with its verdict whatever that
// verdict is: a non-zero exit is an outcome, not a failure to run.
function runCommand({ command, cwd, timeout, abortSignal }: RunCommandArgs = {}): Promise<CommandResult> {
  const cmd = String(command || '').trim();
  if (!cmd) return Promise.reject(new CommandError('This step has no command yet'));

  const timeoutMs = Number(timeout) > 0
    ? Math.min(Number(timeout), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  const started = Date.now();
  return new Promise<CommandResult>((resolve, reject) => {
    exec(cmd, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      signal: abortSignal,
      // SIGTERM leaves a wedged child running often enough that a timed-out
      // step would otherwise hold the port it was testing.
      killSignal: 'SIGKILL',
    }, (err: ExecErr | null, stdout, stderr) => {
      const timeMs = Date.now() - started;
      // exec hands stdout/stderr back on the error too — a command that failed
      // usually said why on stderr, and dropping it loses the only explanation.
      const out = String(stdout == null ? '' : stdout);
      const errOut = String(stderr == null ? '' : stderr);

      if (!err) return resolve({ exitCode: 0, stdout: out, stderr: errOut, timeMs });

      if (abortSignal && abortSignal.aborted) {
        const e = new CommandError('Cancelled');
        e.cancelled = true;
        return reject(e);
      }
      if (err.killed) {
        return reject(new CommandError(
          `The command did not finish within ${timeoutMs / 1000}s — it was killed.`,
          'Raise the step timeout if it is simply slow, or check whether the command is waiting on input.',
        ));
      }
      if (/maxBuffer/i.test(err.message || '')) {
        return reject(new CommandError(
          `The command printed more than ${MAX_OUTPUT / 1024 / 1024}MB.`,
          'Narrow what it prints — pipe through head, or select fewer rows.',
        ));
      }
      // A numeric code means the command ran and decided; anything else
      // (ENOENT, EACCES) means it never got that far.
      if (typeof err.code === 'number') {
        return resolve({ exitCode: err.code, stdout: out, stderr: errOut, timeMs });
      }
      return reject(new CommandError(
        `The command could not be run: ${err.code || err.message}`,
        err.code === 'ENOENT' ? 'Check the working directory exists.' : undefined,
      ));
    });
  });
}

// ---- A shell that stays open for a whole run ----
// runCommand above starts a shell, runs one line and lets it exit, so nothing a
// command did to its shell reaches the next one: no cd, no export, no activated
// virtualenv, no function. Plenty of checking is genuinely sequential — cd into
// the checkout, source the env, run the migration, read the result — and saying
// so in one giant `&&` chain is a step nobody can read or assert on halfway
// through. A session is the same sh process for every command in the run, which
// is what a person at a terminal has and keeps expecting to have here.
//
// The protocol is the usual one for driving a shell you cannot see: write the
// command, then write a line printing a nonce nobody could have typed. Output
// before the nonce belongs to the command; the nonce itself carries the exit
// code. It is printed on both streams because they are separate pipes, and a
// command's stderr can still be in flight when its stdout has finished.

// A session needs a POSIX shell to feed, since everything below is sh script.
// Windows has none by default, so a flow there keeps one shell per command
// rather than being handed cmd.exe something it cannot read.
const SESSIONS_SUPPORTED = process.platform !== 'win32';

// Overridable because a session is where the difference between sh and bash
// starts to matter: `source`, arrays and [[ ]] are bash, and a flow that leans
// on them wants to say so once rather than per step.
const SESSION_SHELL = process.env.API_TEST_SHELL || '/bin/sh';

// Wrap a string so the shell reads it as one literal word.
function shq(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// How long to let a session shell leave on its own before it is put down.
const EXIT_GRACE_MS = 300;

// The shell process, with its three pipes known to be there.
type ShellChild = ChildProcessByStdio<Writable, Readable, Readable>;

// One command in flight, and everything needed to decide its verdict.
interface Pending {
  out: string;
  err: string;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  outMark: RegExp;
  errMark: RegExp;
  started: number;
  freshShell: boolean;
  resolve: (r: CommandResult) => void;
  reject: (e: CommandError) => void;
  abortSignal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  timer: NodeJS.Timeout | null;
}

class ShellSession {
  startCwd: string;
  shellPath: string;
  child: ShellChild | null;
  mark: string;
  pending: Pending | null;
  // Whether a shell has been started before, so a command that has to start
  // one can tell "the session began" from "the session was replaced" — the
  // second means the state earlier steps built up is gone, which the run
  // report has to say out loud.
  started: boolean;
  disposed: boolean;

  constructor({ cwd, shell }: { cwd?: string; shell?: string } = {}) {
    this.startCwd = cwd || process.cwd();
    this.shellPath = shell || SESSION_SHELL;
    this.child = null;
    this.mark = '';
    this.pending = null;
    this.started = false;
    this.disposed = false;
  }

  // Bring up a shell to feed. Nothing is run here — the command that needed it
  // is written straight after, and a shell that could not start reports through
  // the same path a command that died does.
  spawnShell(): ShellChild {
    this.mark = `__api_test_${crypto.randomBytes(9).toString('hex')}__`;
    // Its own process group, so a timeout can take down what the command
    // started as well as the command — a wedged grandchild otherwise keeps the
    // port the step was testing.
    const child = spawn(this.shellPath, ['-s'], {
      cwd: this.startCwd,
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      detached: true,
    });
    this.child = child;
    this.started = true;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData('out', d));
    child.stderr.on('data', (d: string) => this.onData('err', d));
    // A dead session's events are none of the live one's business.
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (child === this.child) this.onDeath(err, null);
    });
    child.on('close', (code: number | null) => {
      if (child === this.child) this.onDeath(null, code);
    });
    // Writing to a shell that has already gone lands here rather than as an
    // unhandled EPIPE taking the server down with it.
    child.stdin.on('error', () => {});
    return child;
  }

  // Output arriving from the shell. Everything up to the marker is the running
  // command's; a session with nothing pending is hearing from something a
  // finished command left running in the background, which has no reader.
  onData(which: 'out' | 'err', chunk: string): void {
    const p = this.pending;
    if (!p) return;
    const key = which === 'out' ? 'out' : 'err';
    p[key] += chunk;

    if (key === 'out' && p.exitCode == null) {
      const m = p.outMark.exec(p.out);
      if (m) {
        p.stdout = p.out.slice(0, m.index);
        p.exitCode = Number(m[1]);
      }
    } else if (key === 'err' && p.stderr == null) {
      const m = p.errMark.exec(p.err);
      if (m) p.stderr = p.err.slice(0, m.index);
    }

    // Past this the output is neither read by a person nor matched by an
    // assertion, and the shell cannot be trusted to stop: kill it rather than
    // grow a string until the process dies of it.
    if (p.out.length > MAX_OUTPUT || p.err.length > MAX_OUTPUT) {
      this.fail(new CommandError(
        `The command printed more than ${MAX_OUTPUT / 1024 / 1024}MB.`,
        'Narrow what it prints — pipe through head, or select fewer rows.',
      ));
      return;
    }
    if (p.exitCode != null && p.stderr != null) this.settle();
  }

  // The shell went away while a command was running. Usually the command said
  // `exit`, which is a verdict and not a breakage: report the code it left, and
  // let the next step start a shell of its own.
  onDeath(err: NodeJS.ErrnoException | null, code: number | null): void {
    this.child = null;
    const p = this.pending;
    if (!p) return;
    if (err) {
      this.fail(new CommandError(
        `The command could not be run: ${err.code || err.message}`,
        err.code === 'ENOENT'
          ? `No shell at ${this.shellPath} — set API_TEST_SHELL to one that exists.`
          : undefined,
      ));
      return;
    }
    // Whatever arrived before the shell died is all there is; no marker is
    // coming, so take the streams whole.
    p.stdout = p.stdout == null ? p.out : p.stdout;
    p.stderr = p.stderr == null ? p.err : p.stderr;
    p.exitCode = p.exitCode == null ? (code == null ? 1 : code) : p.exitCode;
    this.settle();
  }

  // Hand the pending command its verdict.
  settle(): void {
    const p = this.pending!;
    this.clearPending();
    p.resolve({
      exitCode: p.exitCode!,
      stdout: p.stdout || '',
      stderr: p.stderr || '',
      timeMs: Date.now() - p.started,
      ...(p.freshShell ? { freshShell: true as const } : {}),
    });
  }

  // No verdict: the command never finished, and the shell it was running in is
  // in a state nobody can reason about, so it goes.
  fail(err: CommandError): void {
    const p = this.pending!;
    this.clearPending();
    this.kill();
    p.reject(err);
  }

  clearPending(): void {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    if (p.onAbort) p.abortSignal!.removeEventListener('abort', p.onAbort);
  }

  // Take down the shell and everything it started, by process group.
  kill(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // Run one command in this session, resolving with the same verdict shape
  // runCommand gives so a step cannot tell which one it got.
  run({ command, cwd, timeout, abortSignal }: RunCommandArgs = {}): Promise<CommandResult> {
    const cmd = String(command || '').trim();
    if (!cmd) return Promise.reject(new CommandError('This step has no command yet'));
    if (this.pending) {
      return Promise.reject(new CommandError('This shell session is already running a command'));
    }
    if (this.disposed) return Promise.reject(new CommandError('This shell session has closed'));
    if (abortSignal && abortSignal.aborted) {
      const e = new CommandError('Cancelled');
      e.cancelled = true;
      return Promise.reject(e);
    }

    const timeoutMs = Number(timeout) > 0
      ? Math.min(Number(timeout), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    // A shell only when there isn't one: the first command of the run starts
    // it, and a later one only after something killed it.
    const replacing = this.started && !this.child;
    if (!this.child) this.spawnShell();
    const mark = this.mark;

    return new Promise<CommandResult>((resolve, reject) => {
      const p: Pending = {
        out: '', err: '',
        stdout: null, stderr: null, exitCode: null,
        // The nonce as it comes back: on stdout with the exit code after it,
        // on stderr alone. The leading newline is printed by us so a command
        // whose output has no final newline still leaves the marker on a line
        // of its own — and slicing at it hands back exactly what the command
        // wrote, our newline included in neither.
        outMark: new RegExp(`\\n${mark} (-?\\d+)\\n`),
        errMark: new RegExp(`\\n${mark}\\n`),
        started: Date.now(),
        freshShell: replacing,
        resolve,
        reject,
        abortSignal,
        onAbort: null,
        timer: null,
      };
      this.pending = p;

      p.timer = setTimeout(() => {
        this.fail(new CommandError(
          `The command did not finish within ${timeoutMs / 1000}s — it was killed.`,
          'Raise the step timeout if it is simply slow, or check whether the command is waiting on input.',
        ));
      }, timeoutMs);

      if (abortSignal) {
        p.onAbort = () => {
          const e = new CommandError('Cancelled');
          e.cancelled = true;
          this.fail(e);
        };
        abortSignal.addEventListener('abort', p.onAbort, { once: true });
      }

      // `cd &&` rather than a cd on its own: a directory that isn't there then
      // fails this step, with cd's own complaint on stderr, instead of running
      // the command somewhere it was never meant to run.
      //
      // </dev/null on the group is what keeps a session usable: this shell's
      // stdin is the pipe the next commands arrive on, and one `cat` without
      // this would eat them. A heredoc still works — its own redirection is
      // inside the group and wins.
      //
      // The braces make the command one unit whatever it is, so a bare `a; b`
      // takes the redirection too. It does mean the command has to be complete
      // sh, and one with an unclosed quote hangs until the timeout above.
      const script = `${cwd ? `cd -- ${shq(cwd)} && ` : ''}{ ${cmd}\n} </dev/null\n`
        // Expanded before printf runs, so "$?" is still the group's.
        + `printf '\\n%s %s\\n' ${shq(mark)} "$?"; printf '\\n%s\\n' ${shq(mark)} >&2\n`;
      try {
        this.child!.stdin.write(script);
      } catch (err) {
        this.fail(new CommandError(
          `The command could not be run: ${(err as Error).message}`,
        ));
      }
    });
  }

  // End of the run. `exit` first, so a shell that is idle goes on its own terms
  // and its children get the usual hangup, then the group by force for one that
  // has something running.
  async dispose(): Promise<void> {
    this.disposed = true;
    // A run that was cancelled mid-command still has one waiting on a verdict
    // it is never going to get.
    if (this.pending) {
      const e = new CommandError('Cancelled');
      e.cancelled = true;
      this.fail(e);
      return;
    }
    const child = this.child;
    if (!child) return;
    await new Promise<void>((done) => {
      const finish = (): void => { clearTimeout(timer); done(); };
      const timer = setTimeout(() => { this.kill(); done(); }, EXIT_GRACE_MS);
      child.once('close', finish);
      try { child.stdin.end('exit\n'); } catch { finish(); }
    });
    this.child = null;
  }
}

export {
  runCommand, CommandError, MAX_OUTPUT, DEFAULT_TIMEOUT_MS,
  ShellSession, SESSIONS_SUPPORTED, SESSION_SHELL,
};
