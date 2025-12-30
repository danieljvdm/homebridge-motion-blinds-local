import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { MotionBlindAccessory } from './platformAccessory.js';
import { MotionGateway, DeviceListResponse } from './motionGateway.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

// Device type for blinds (gateway is 02000001)
const BLIND_DEVICE_TYPE = '10000000';

export interface BlindConfig {
  mac: string;
  name: string;
  deviceType?: string;
}

export interface MotionBlindsConfig extends PlatformConfig {
  gatewayIp: string;
  key: string;
  blinds?: BlindConfig[];
  pollingInterval?: number;
}

export class MotionBlindsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly blindAccessories: Map<string, MotionBlindAccessory> = new Map();
  private readonly discoveredCacheUUIDs: string[] = [];

  public gateway: MotionGateway | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const pluginConfig = config as MotionBlindsConfig;

    if (!pluginConfig.gatewayIp || !pluginConfig.key) {
      this.log.error('Missing required configuration: gatewayIp and key are required');
      return;
    }

    this.log.debug('Finished initializing platform:', config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.initializeGateway(pluginConfig);
    });

    this.api.on('shutdown', () => {
      this.log.info('Shutting down Motion Blinds platform');
      if (this.gateway) {
        this.gateway.disconnect();
      }
    });
  }

  private async initializeGateway(config: MotionBlindsConfig): Promise<void> {
    this.gateway = new MotionGateway(config.gatewayIp, config.key, this.log);

    // Listen for blind state updates
    this.gateway.on('blindState', (mac: string, state) => {
      const accessory = this.blindAccessories.get(mac);
      if (accessory) {
        accessory.updateState(state);
      }
    });

    try {
      await this.gateway.connect();
      this.log.info('Connected to Motion Blinds gateway');

      // Get device list to obtain token and discover devices
      const deviceList = await this.gateway.getDeviceList();
      this.log.info(`Gateway firmware: ${deviceList.fwVersion}, protocol: ${deviceList.ProtocolVersion}`);
      this.log.debug(`Discovered ${deviceList.data.length} devices from gateway`);

      // Register blinds (auto-discover if none configured)
      const blinds = this.discoverDevices(config, deviceList);

      // Start status polling
      if (blinds.length > 0) {
        const macs = blinds.map(b => b.mac);
        const interval = config.pollingInterval || 60000;
        this.gateway.startStatusPolling(macs, interval);
        this.log.info(`Status polling started (interval: ${interval}ms)`);
      }
    } catch (e) {
      this.log.error('Failed to initialize gateway:', e);
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private discoverDevices(config: MotionBlindsConfig, deviceList: DeviceListResponse): BlindConfig[] {
    let blinds = config.blinds || [];

    // Auto-discover blinds if none configured
    if (blinds.length === 0) {
      this.log.info('No blinds configured, auto-discovering from gateway...');

      const discoveredBlinds = deviceList.data.filter(d => d.deviceType === BLIND_DEVICE_TYPE);

      if (discoveredBlinds.length === 0) {
        this.log.warn('No blinds found on gateway');
        return [];
      }

      blinds = discoveredBlinds.map((device, index) => ({
        mac: device.mac,
        name: `Blind ${index + 1}`,
        deviceType: device.deviceType,
      }));

      this.log.info(`Auto-discovered ${blinds.length} blind(s): ${blinds.map(b => b.mac).join(', ')}`);
    }

    for (const blind of blinds) {
      const uuid = this.api.hap.uuid.generate(blind.mac);

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // Update context with latest config
        existingAccessory.context.device = blind;
        this.api.updatePlatformAccessories([existingAccessory]);

        const accessory = new MotionBlindAccessory(this, existingAccessory);
        this.blindAccessories.set(blind.mac, accessory);
      } else {
        this.log.info('Adding new accessory:', blind.name);

        const accessory = new this.api.platformAccessory(blind.name, uuid);
        accessory.context.device = blind;

        const blindAccessory = new MotionBlindAccessory(this, accessory);
        this.blindAccessories.set(blind.mac, blindAccessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.discoveredCacheUUIDs.push(uuid);
    }

    // Remove accessories that are no longer present
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing accessory no longer present:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Initial status fetch for all blinds
    this.fetchInitialStatus(blinds);

    return blinds;
  }

  private async fetchInitialStatus(blinds: BlindConfig[]): Promise<void> {
    if (!this.gateway) {
      return;
    }

    // Wait a bit for everything to settle
    await new Promise(resolve => setTimeout(resolve, 1000));

    for (const blind of blinds) {
      try {
        this.log.debug(`Fetching initial status for ${blind.name} (${blind.mac})`);
        await this.gateway.getStatus(blind.mac);
      } catch (e) {
        this.log.warn(`Failed to get initial status for ${blind.name}:`, e);
      }
    }
  }
}
