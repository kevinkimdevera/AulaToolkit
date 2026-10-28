// Device manager: enumerates HID devices, attaches a driver per model, polls status, keeps a packet log.
import { EventEmitter } from 'node:events';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { Device } from 'node-hid';
import { MODELS } from '@shared/models';
import type { DeviceModel, DeviceStatus, LogEntry } from '@shared/types';
import { listDevices } from './transport';
import type { Driver } from './drivers/types';
import { Aula04Driver } from './drivers/aula04Driver';
import { IncottDriver } from './drivers/incottDriver';
import { G5kbDriver } from './drivers/g5kbDriver';
import { SimDriver } from './drivers/simDriver';
import type { DriverEvent } from './drivers/types';

const SCAN_MS = 2000;
const STATUS_MS = 30000;
const LOG_MAX = 2000;

export class DeviceManager extends EventEmitter {
  private drivers = new Map<string, Driver>();
  private statuses = new Map<string, DeviceStatus>();
  private log: LogEntry[] = [];
  private scanning = false;
  /** Whether a window that shows live lighting is on screen; drivers poll faster while it is. */
  liveViewActive: () => boolean = () => true;
  private scanTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastSignature = '';
  private failedSignatures = new Map<string, number>();
  private warnedAccess = new Set<string>();

  start(): void {
    for (const id of (process.env.AULA_SIM ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const model = MODELS.find((m) => m.id === id);
      if (!model || this.drivers.has(`${id}:sim`)) continue;
      const drv = new SimDriver(model, { log: (dir, text) => this.addLog(dir, text, model.id), onStatus: () => void this.refresh(`${id}:sim`) });
      this.drivers.set(drv.key, drv);
      this.statuses.set(drv.key, { key: drv.key, modelId: model.id, link: 'usb', productName: drv.productName, battery: null, charging: false });
      void this.refresh(drv.key);
    }
    this.emitDevices();
    if (process.env.AULA_SIM_ONLY) return; // screenshots / demos: simulated devices only
    void this.scan(true);
    this.scanTimer = setInterval(() => void this.scan(false), SCAN_MS);
    this.statusTimer = setInterval(() => void this.refreshAll(), STATUS_MS);
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    await Promise.all([...this.drivers.values()].map((d) => d.close()));
    this.drivers.clear();
  }

  private logPath: string | null = null;
  private appendFile(e: LogEntry): void {
    try {
      if (!this.logPath) {
        const dir = join(app.getPath('userData'), 'logs');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        this.logPath = join(dir, `hid-${new Date().toISOString().slice(0, 10)}.log`);
      }
      appendFileSync(this.logPath, `${new Date(e.t).toISOString()} ${e.device ?? '-'} ${e.dir} ${e.text}\n`);
    } catch { /* logging must never break the app */ }
  }

  getStatuses(): DeviceStatus[] { return [...this.statuses.values()]; }
  getLog(): LogEntry[] { return this.log; }
  clearLog(): void { this.log = []; }

  addLog(dir: LogEntry['dir'], text: string, device?: string): void {
    const e: LogEntry = { t: Date.now(), dir, text, device };
    if (process.env.AULA_DEBUG) console.log(`[hid] ${device ?? ''} ${dir} ${text}`);
    this.appendFile(e);
    this.log.push(e);
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    this.emit('log', e);
  }

  async call(key: string, method: string, args: unknown[]): Promise<unknown> {
    const d = this.drivers.get(key);
    if (!d) throw new Error('Device not connected');
    try {
      return await d.call(method, args);
    } catch (e) {
      this.addLog('!', `${method}: ${(e as Error).message}`, key);
      throw e;
    }
  }

  async rescan(): Promise<void> { this.lastSignature = ''; this.failedSignatures.clear(); await this.scan(true); }

  private groups(devices: Device[]): Map<string, { model: DeviceModel; devices: Device[] }> {
    const out = new Map<string, { model: DeviceModel; devices: Device[] }>();
    for (const model of MODELS) {
      const mine = devices.filter((d) => model.usb.some((u) => u.vendorId === d.vendorId && u.productId === d.productId));
      if (mine.length) out.set(model.id, { model, devices: mine });
    }
    return out;
  }

  private async scan(force: boolean): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const devices = listDevices();
      const signature = devices.map((d) => d.path).sort().join('|');
      if (!force && signature === this.lastSignature) return;
      this.lastSignature = signature;
      const groups = this.groups(devices);

      // Detach drivers whose model is gone or whose ports vanished.
      for (const [key, drv] of [...this.drivers]) {
        if (key.endsWith(':sim')) continue; // simulated devices have no USB port
        const g = groups.get(drv.model.id);
        const stillThere = g && g.devices.some((d) => devices.some((x) => x.path === d.path));
        if (!stillThere) {
          await drv.close();
          this.drivers.delete(key);
          this.statuses.delete(key);
          this.addLog('i', `${drv.model.name} disconnected`);
          this.emitDevices();
        }
      }

      // Attach drivers for new groups (one driver per model; USB preferred over the dongle).
      for (const [modelId, g] of groups) {
        const existing = [...this.drivers.values()].find((d) => d.model.id === modelId);
        const gsig = modelId + ':' + g.devices.map((d) => d.path).sort().join('|');
        if (existing) {
          // Re-attach when a USB link appears while we are on the dongle.
          const hasUsb = g.devices.some((d) => g.model.usb.some((u) => u.role === 'usb' && u.vendorId === d.vendorId && u.productId === d.productId));
          if (!(existing.link === '2.4g' && hasUsb)) continue;
          await existing.close();
          this.drivers.delete(existing.key);
          this.statuses.delete(existing.key);
        }
        const lastFail = this.failedSignatures.get(gsig) ?? 0;
        if (!force && Date.now() - lastFail < 15000) continue;
        const drv = await this.attach(g.model, g.devices);
        if (!drv) { this.failedSignatures.set(gsig, Date.now()); this.checkAccess(g.model, g.devices); continue; }
        this.failedSignatures.delete(gsig);
        this.drivers.set(drv.key, drv);
        this.statuses.set(drv.key, { key: drv.key, modelId: drv.model.id, link: drv.link, productName: drv.productName, battery: null, charging: false });
        this.emitDevices();
        this.emit('attached', drv.key);
        void this.refresh(drv.key);
      }
    } catch (e) {
      this.addLog('!', `scan failed: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  /** Linux: hidraw nodes are root-only unless a udev rule hands them to the logged-in user. */
  private checkAccess(model: DeviceModel, devices: Device[]): void {
    if (process.platform !== 'linux') return;
    const denied = [...new Set(devices.map((d) => d.path ?? ''))].filter((p) => {
      try { accessSync(p, constants.R_OK | constants.W_OK); return false; } catch { return true; }
    });
    const key = denied.join('|');
    if (!denied.length || this.warnedAccess.has(key)) return;
    this.warnedAccess.add(key);
    this.addLog('!', `${model.name}: no permission to open ${denied.join(', ')}; install the udev rule (see README, "Linux") and reconnect the device`);
  }

  private attach(model: DeviceModel, devices: Device[]): Promise<Driver | null> {
    const ctx = {
      log: (dir: LogEntry['dir'], text: string) => this.addLog(dir, text, model.id),
      onStatus: () => void this.refresh(`${model.id}:usb`, `${model.id}:2.4g`),
      onEvent: (e: DriverEvent) => this.emit('hw-event', { ...e, modelId: model.id }),
      onLiveLight: (colors: Record<number, [number, number, number]>) => this.emit('live-light', { modelId: model.id, colors, t: Date.now() }),
      liveViewActive: () => this.liveViewActive(),
    };
    switch (model.protocol) {
      case 'aula04': return Aula04Driver.attach(model, devices, ctx);
      case 'incott': return IncottDriver.attach(model, devices, ctx);
      case 'g5kb': return G5kbDriver.attach(model, devices, ctx);
      default: return Promise.resolve(null);
    }
  }

  async refresh(...keys: string[]): Promise<void> {
    for (const key of keys) {
      const d = this.drivers.get(key);
      if (!d) continue;
      try {
        const s = await d.status();
        this.statuses.set(key, s);
        this.emitDevices();
      } catch (e) {
        this.addLog('!', `status: ${(e as Error).message}`, key);
      }
    }
  }

  private async refreshAll(): Promise<void> { await this.refresh(...this.drivers.keys()); }

  private emitDevices(): void { this.emit('devices', this.getStatuses()); }
}
