import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLI_VERSION = '0.163.0';
export const restrictedConfig = {
  'features.shell_tool': false, 'features.unified_exec': false,
  'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false,
  'features.browser_use': false, 'features.computer_use': false,
  'features.in_app_browser': false, 'features.image_generation': false,
  'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.skill_search': false, 'features.skip_host_skill_discovery': true,
  'features.hooks': false, 'features.memories': false,
  'features.code_mode': false, 'features.code_mode_host': false,
  'features.view_image': false, 'tools.view_image': false,
  web_search: 'disabled', project_doc_max_bytes: 0,
};

export class CodexClient extends EventEmitter {
  constructor({ command = 'codex', rpcTimeout = 15000, spawnProcess = spawn, checkVersion = true, profile = 'instructions' } = {}) {
    super();
    if (!['instructions', 'images'].includes(profile)) throw new Error('INVALID_PROFILE');
    Object.assign(this, { command, rpcTimeout, spawnProcess, checkVersion, profile });
    this.config = { ...restrictedConfig, 'features.image_generation': profile === 'images' };
    this.pending = new Map(); this.seq = 0; this.available = false;
  }
  async start() {
    if (this.checkVersion) {
      const version = execFileSync(this.command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (version !== `codex-cli ${CLI_VERSION}`) throw new Error(`CLI_VERSION: codex ${CLI_VERSION} が必要です`);
    }
    this.cwd = await mkdtemp(join(tmpdir(), 'mindmap-codex-'));
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(this.config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    this.proc = this.spawnProcess(this.command, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    // Do not forward stderr: upstream diagnostics may contain map text or credentials.
    this.proc.stderr.resume();
    this.proc.stdin.on('error', () => this.fail(new Error('CODEX_STOPPED')));
    this.proc.once('error', () => this.fail(new Error('CODEX_STOPPED')));
    this.proc.once('exit', () => this.fail(new Error('CODEX_STOPPED')));
    this.lines = createInterface({ input: this.proc.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { this.fail(new Error('INVALID_PROTOCOL')); this.proc.kill(); }
    });
    await this.rpc('initialize', { clientInfo: { name: 'mindmap_prompt', title: 'Mindmap', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
    const { config } = await this.rpc('config/read', { includeLayers: false });
    this.threadConfig = { ...this.config };
    // Table overrides merge, so disable each inherited MCP entry explicitly.
    for (const name of Object.keys(config?.mcp_servers || {})) this.threadConfig[`mcp_servers.${name}.enabled`] = false;
    const skills = await this.rpc('skills/list', { cwds: [this.cwd] });
    this.threadConfig['skills.config'] = (skills.data || []).flatMap(d => d.skills || []).map(s => ({ path: s.path, enabled: false }));
    this.available = true;
  }
  async status() {
    if (!this.available) return { available: false, reason: 'Codexに接続できません。中継サーバーを再起動してください。' };
    const result = await this.rpc('account/read', { refreshToken: false });
    const authenticated = !!result.account;
    return { available: authenticated, reason: authenticated ? '' : 'Macのターミナルで codex login を実行してください。' };
  }
  send(message) { this.proc.stdin.write(JSON.stringify(message) + '\n'); }
  rpc(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RPC_TIMEOUT')); this.fail(new Error('RPC_TIMEOUT')); this.proc?.kill(); }, this.rpcTimeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  receive(message) {
    if (message.method && message.id !== undefined) {
      this.send({ id: message.id, error: { code: -32601, message: 'Requests are not allowed by this client' } });
      this.fail(new Error('UNEXPECTED_SERVER_REQUEST')); this.proc.kill(); return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) {
        // Preserve only protocol metadata. Upstream messages/data may contain secrets.
        const error = new Error('RPC_ERROR'); error.method = pending.method;
        error.rpcCode = Number.isInteger(message.error.code) ? message.error.code : null;
        pending.reject(error);
      } else pending.resolve(message.result);
    } else if (message.method) this.emit('notification', message.method, message.params);
  }
  fail(error) {
    this.available = false;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  async close() {
    this.fail(new Error('CODEX_STOPPED')); this.lines?.close(); this.proc?.kill();
    if (this.cwd) await rm(this.cwd, { recursive: true, force: true });
  }
}
