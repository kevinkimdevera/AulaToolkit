// Command-line control (`aula …`), in the spirit of Legion Toolkit's llt.exe.
//
// The running app listens on a per-user named pipe; the thin `aula` script (resources/cli/aula.js,
// launched by resources/bin/aula.cmd or resources/bin/aula) sends one JSON request per invocation and prints the reply.
// Read-only commands are answered here; anything that changes a profile is forwarded to the renderer,
// which owns the profiles, so the UI, the saved files and the device always stay in sync.
import { rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { MODELS } from '@shared/models';
import type { DeviceStatus } from '@shared/types';
import type { CliRequest, CliResult } from '@shared/ipc';

export const pipeName = (): string => {
  const user = os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_');
  return process.platform === 'win32' ? `\\\\.\\pipe\\aula-toolkit-${user}` : join(os.tmpdir(), `aula-toolkit-${user}.sock`);
};

export interface CliContext {
  statuses(): DeviceStatus[];
  version(): string;
  showWindow(): void;
  hideWindow(): void;
  /** Runs a profile-changing command in the renderer. */
  forward(req: CliRequest): Promise<CliResult>;
}

const HELP = `AULA Toolkit command-line control

Usage: aula <command> [arguments] [-d <device>]

  status                     List connected devices (add --json for machine output)
  profile list               List the profiles of a device
  profile set <name>         Switch to a profile
  dpi                        Show the DPI stages of the mouse
  dpi stage <n>              Activate DPI stage n (1-based)
  dpi <value>                Set the active stage to <value> DPI
  polling <hz>               Set the mouse polling rate (125 … 8000)
  light <effect>             Set the keyboard effect; options: --color #rrggbb --brightness n --speed n
  light list                 List the keyboard's effects
  brightness <n>             Set the keyboard lighting brightness
  osd on|off                 Turn the on-screen display on or off
  show | hide                Show or hide the AULA Toolkit window
  version                    Print the app version

-d, --device <id|name>       Pick a device when several are connected (s75pro, sc900, f75 …)`;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function parse(argv: string[]): { cmd: string; device?: string; args: string[]; opts: Record<string, string> } {
  const args: string[] = [];
  const opts: Record<string, string> = {};
  let device: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-d' || a === '--device') { device = argv[++i]; continue; }
    if (a === '-h' || a === '--help') { args.unshift('help'); continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : 'true');
      continue;
    }
    args.push(a);
  }
  return { cmd: (args.shift() ?? 'help').toLowerCase(), device, args, opts };
}

/** Finds the target device: the one named with -d, or the only connected device of the needed kind. */
function resolve(statuses: DeviceStatus[], device: string | undefined, kind?: 'mouse' | 'keyboard'): { modelId: string } | { error: string } {
  const connected = [...new Set(statuses.map((s) => s.modelId))];
  if (device) {
    const m = MODELS.find((x) => norm(x.id) === norm(device) || norm(x.name) === norm(device));
    if (!m) return { error: `Unknown device "${device}". Known: ${MODELS.map((x) => x.id).join(', ')}` };
    if (!connected.includes(m.id)) return { error: `${m.name} is not connected.` };
    if (kind && m.kind !== kind) return { error: `${m.name} is not a ${kind}.` };
    return { modelId: m.id };
  }
  const cands = connected.filter((id) => !kind || MODELS.find((m) => m.id === id)?.kind === kind);
  if (cands.length === 1) return { modelId: cands[0] };
  if (!cands.length) return { error: kind ? `No ${kind} is connected.` : 'No device is connected.' };
  return { error: `Several devices are connected; pick one with -d (${cands.join(', ')}).` };
}

function status(statuses: DeviceStatus[], json: boolean): CliResult {
  const rows = statuses.map((s) => {
    const m = MODELS.find((x) => x.id === s.modelId);
    const live = (s.live ?? {}) as { dpiStages?: number[]; dpiActive?: number; polling?: number };
    const dpi = live.dpiStages && live.dpiActive != null ? live.dpiStages[live.dpiActive] : undefined;
    return { id: s.modelId, name: m?.name ?? s.productName, kind: m?.kind ?? 'device', link: s.link, battery: s.battery ?? null, charging: s.charging, dpi: dpi ?? null, polling: live.polling ?? null };
  });
  if (json) return { ok: true, out: JSON.stringify(rows, null, 2) };
  if (!rows.length) return { ok: true, out: 'No supported device is connected.' };
  const link = (l: string): string => (l === 'usb' ? 'USB' : l === '2.4g' ? '2.4 GHz' : l);
  const lines = rows.map((r) => {
    const bits = [link(r.link)];
    if (r.battery != null) bits.push(`battery ${r.battery}%${r.charging ? ' (charging)' : ''}`);
    if (r.dpi != null) bits.push(`${r.dpi} DPI`);
    if (r.polling != null) bits.push(`${r.polling} Hz`);
    return `  ${r.name.padEnd(12)} ${r.id.padEnd(8)} ${bits.join('  ·  ')}`;
  });
  return { ok: true, out: ['Connected devices:', ...lines].join('\n') };
}

export async function handle(ctx: CliContext, argv: string[]): Promise<CliResult> {
  const { cmd, device, args, opts } = parse(argv);
  const statuses = ctx.statuses();
  switch (cmd) {
    case 'help': return { ok: true, out: HELP };
    case 'version': return { ok: true, out: `AULA Toolkit ${ctx.version()}` };
    case 'status': case 'devices': case 'list': return status(statuses, opts.json === 'true');
    case 'show': ctx.showWindow(); return { ok: true, out: 'Window shown.' };
    case 'hide': ctx.hideWindow(); return { ok: true, out: 'Window hidden.' };
    case 'osd': {
      const v = (args[0] ?? '').toLowerCase();
      if (v !== 'on' && v !== 'off') return { ok: false, out: 'Usage: aula osd on|off' };
      return ctx.forward({ cmd, modelId: '', args: [v], opts });
    }
  }
  const kind = cmd === 'dpi' || cmd === 'polling' ? 'mouse' : cmd === 'light' || cmd === 'brightness' ? 'keyboard' : cmd === 'profile' ? undefined : null;
  if (kind === null) return { ok: false, out: `Unknown command "${cmd}". Run "aula help".` };
  const target = resolve(statuses, device, kind);
  if ('error' in target) return { ok: false, out: target.error };
  return ctx.forward({ cmd, modelId: target.modelId, args, opts });
}

/** Starts the per-user pipe server. One newline-terminated JSON request per connection. */
export function startCliServer(ctx: CliContext, log: (msg: string) => void): void {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let argv: string[] = [];
      try { const req = JSON.parse(line) as { argv?: unknown }; argv = Array.isArray(req.argv) ? req.argv.map(String) : []; } catch {
        sock.end(`${JSON.stringify({ ok: false, out: 'Malformed request.' })}\n`);
        return;
      }
      void handle(ctx, argv)
        .catch((e: Error): CliResult => ({ ok: false, out: e.message }))
        .then((res) => sock.end(`${JSON.stringify(res)}\n`));
    });
    sock.on('error', () => undefined);
  });
  server.on('error', (e) => log(`CLI server unavailable: ${e.message}`));
  // A Unix socket outlives a crashed app; the single-instance lock means a leftover one is stale.
  if (process.platform !== 'win32') rmSync(pipeName(), { force: true });
  server.listen(pipeName(), () => log(`CLI listening on ${pipeName()}`));
}
