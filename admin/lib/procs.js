import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 1200;
const MAX_LINE_CHARS = 4000;

export class ManagedProcess {
  constructor(name, opts) {
    this.name = name;
    this.opts = opts;
    this.child = null;
    this.state = 'stopped';
    this.ring = [];
    this.listeners = new Set();
    this.desired = false;
    this.timer = null;
    this.restartDelay = 2000;
    this.startedAt = null;
    this.lastExit = null;
    this.logStream = null;
    this.pending = { stdout: '', stderr: '' };
    this.spawnError = null;
  }

  _line(stream, raw) {
    const line = String(raw).slice(0, MAX_LINE_CHARS);
    if (!line) return;
    const entry = { t: Date.now(), stream, line };
    this.ring.push(entry);
    if (this.ring.length > MAX_LINES) this.ring.splice(0, this.ring.length - MAX_LINES);
    if (this.logStream) {
      this.logStream.write(`[${new Date(entry.t).toISOString()}] [${stream}] ${line}\n`);
    }
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        // 订阅者异常不影响主流程
      }
    }
  }

  _onData(stream, chunk) {
    const text = this.pending[stream] + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    this.pending[stream] = parts.pop() ?? '';
    for (const part of parts) this._line(stream, part);
  }

  _flush() {
    for (const stream of ['stdout', 'stderr']) {
      if (this.pending[stream]) {
        this._line(stream, this.pending[stream]);
        this.pending[stream] = '';
      }
    }
  }

  _openLog() {
    if (!this.opts.logFile) return;
    fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
    try {
      if (fs.statSync(this.opts.logFile).size > 20 * 1024 * 1024) {
        fs.truncateSync(this.opts.logFile, 0);
      }
    } catch {
      // 文件不存在
    }
    this.logStream = fs.createWriteStream(this.opts.logFile, { flags: 'a' });
  }

  _closeLog() {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  // t3 的 npm 包只是启动器，会再 spawn 真正的二进制；
  // 必须按进程组发信号，否则重启后旧服务仍占着端口。
  _killGroup(signal, pid = this.child?.pid) {
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // 进程已退出
      }
    }
  }

  _scheduleRestart() {
    if (!this.desired || this.opts.restart === false) return;
    const delay = Math.min(this.restartDelay, 30000);
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  start() {
    this.desired = true;
    if (this.child) return false;

    clearTimeout(this.timer);
    this.timer = null;
    this.spawnError = null;
    this._openLog();
    this.state = 'starting';
    this._line('admin', `starting: ${this.opts.cmd} ${this.opts.args.join(' ')}`);

    let child;
    try {
      child = spawn(this.opts.cmd, this.opts.args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      this.spawnError = err.message;
      this.state = 'error';
      this._line('stderr', `spawn error: ${err.message}`);
      this._closeLog();
      this._scheduleRestart();
      return false;
    }

    this.child = child;
    this.startedAt = Date.now();
    this.restartDelay = 2000;

    child.stdout.on('data', (chunk) => this._onData('stdout', chunk));
    child.stderr.on('data', (chunk) => this._onData('stderr', chunk));

    child.on('error', (err) => {
      if (this.child !== child) return;
      this.spawnError = err.message;
      this.state = 'error';
      this.child = null;
      this._line('stderr', `spawn error: ${err.message}`);
      this._closeLog();
      this._scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this._flush();
      this.child = null;
      this.lastExit = { code, signal, at: Date.now() };
      this.state = code === 0 ? 'exited' : 'crashed';
      this._line('admin', `exited: code=${code} signal=${signal ?? 'none'}`);
      this._closeLog();
      // 启动器退出后，清理同组残留进程，避免下一次启动端口被占
      this._killGroup('SIGTERM', child.pid);
      this._scheduleRestart();
    });

    this.state = 'running';
    return true;
  }

  async stop() {
    this.desired = false;
    clearTimeout(this.timer);
    this.timer = null;

    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return;
    }

    await new Promise((resolve) => {
      const pid = child.pid;
      const timer = setTimeout(() => {
        this._killGroup('SIGKILL', pid);
        resolve();
      }, 8000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this._killGroup('SIGTERM', pid);
    });
    this.state = 'stopped';
  }

  async restart() {
    await this.stop();
    this.desired = true;
    this.start();
  }

  isRunning() {
    return Boolean(this.child);
  }

  tail(count = 200) {
    return this.ring.slice(-Math.max(1, Math.min(count, MAX_LINES)));
  }

  status() {
    return {
      name: this.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt && this.child ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      lastExit: this.lastExit,
      spawnError: this.spawnError,
    };
  }
}