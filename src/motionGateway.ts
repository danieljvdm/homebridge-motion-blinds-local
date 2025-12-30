import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logging } from 'homebridge';
import { UDP_PORT, MULTICAST_ADDRESS } from './settings.js';

export enum Operation {
  Close = 0,
  Open = 1,
  Stop = 2,
  StatusQuery = 5,
}

export interface BlindState {
  type: number;
  operation: number;
  currentPosition: number;
  currentAngle: number;
  currentState: number;
  voltageMode: number;
  batteryLevel: number;
  chargingState: number;
  wirelessMode: number;
  RSSI: number;
}

export interface DeviceInfo {
  mac: string;
  deviceType: string;
}

export interface MotionMessage {
  msgType: string;
  msgID: string;
  AccessToken?: string;
  mac?: string;
  deviceType?: string;
  data?: Record<string, unknown>;
}

export interface DeviceListResponse {
  msgType: string;
  mac: string;
  deviceType: string;
  fwVersion: string;
  ProtocolVersion: string;
  token: string;
  data: DeviceInfo[];
}

export interface WriteDeviceResponse {
  msgType: string;
  mac: string;
  deviceType: string;
  msgID: string;
  data: BlindState;
}

function getAccessToken(key: string, token: string): string {
  // AccessToken = AES-128-ECB(key_utf8, token_utf8)
  // Key must be exactly 16 bytes for AES-128
  const keyBuffer = Buffer.from(key, 'utf-8').subarray(0, 16);
  // Pad key if necessary
  const paddedKey = Buffer.alloc(16);
  keyBuffer.copy(paddedKey);

  const tokenBuffer = Buffer.from(token, 'utf-8');
  // Pad token to 16 bytes if necessary
  const paddedToken = Buffer.alloc(16);
  tokenBuffer.copy(paddedToken);

  const cipher = crypto.createCipheriv('aes-128-ecb', paddedKey, null);
  cipher.setAutoPadding(false);

  const encrypted = Buffer.concat([cipher.update(paddedToken), cipher.final()]);
  return encrypted.toString('hex').toUpperCase();
}

function generateMsgID(): string {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

export class MotionGateway extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private token: string = '';
  private accessToken: string = '';
  private responseHandlers: Map<string, (msg: Record<string, unknown>) => void> = new Map();
  private isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusPollingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gatewayIP: string,
    private readonly key: string,
    private readonly log: Logging,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.on('error', (err) => {
        this.log.error('Socket error:', err.message);
        this.isConnected = false;
        this.scheduleReconnect();
      });

      this.socket.on('close', () => {
        this.log.debug('Socket closed');
        this.isConnected = false;
      });

      this.socket.bind(() => {
        this.log.info('Motion Gateway controller started');
        try {
          this.socket!.addMembership(MULTICAST_ADDRESS);
          this.log.debug(`Joined multicast group ${MULTICAST_ADDRESS}`);
        } catch (e) {
          this.log.debug(`Could not join multicast: ${e}`);
        }
        this.isConnected = true;
        resolve();
      });

      // Timeout for connection
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const response = JSON.parse(msg.toString()) as Record<string, unknown>;
      this.log.debug(`Response from ${rinfo.address}:`, JSON.stringify(response));

      // Store token from gateway responses
      if (response.token) {
        this.token = response.token as string;
        this.accessToken = getAccessToken(this.key, this.token);
        this.log.debug(`Token updated: ${this.token}`);
      }

      // Handle pending response by msgType
      const msgType = response.msgType as string;
      if (msgType) {
        // Emit events for state updates
        if (msgType === 'WriteDeviceAck' || msgType === 'ReadDeviceAck') {
          const mac = response.mac as string;
          const data = response.data as BlindState;
          if (mac && data) {
            this.emit('blindState', mac, data);
          }
        }

        // Handle response handlers
        if (this.responseHandlers.has(msgType)) {
          const handler = this.responseHandlers.get(msgType);
          handler?.(response);
        }
      }
    } catch (e) {
      this.log.debug(`Failed to parse message: ${msg.toString()}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        await this.getDeviceList();
      } catch (e) {
        this.log.error('Reconnection failed:', e);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.statusPollingTimer) {
      clearInterval(this.statusPollingTimer);
      this.statusPollingTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  }

  private async send(message: MotionMessage): Promise<Record<string, unknown>> {
    if (!this.socket || !this.isConnected) {
      throw new Error('Not connected to gateway');
    }

    return new Promise((resolve, reject) => {
      const msgStr = JSON.stringify(message);
      this.log.debug(`Sending to ${this.gatewayIP}:${UDP_PORT}:`, msgStr);

      const expectedResponse = message.msgType + 'Ack';
      const timeout = setTimeout(() => {
        this.responseHandlers.delete(expectedResponse);
        reject(new Error(`Timeout waiting for response to ${message.msgType}`));
      }, 5000);

      this.responseHandlers.set(expectedResponse, (response) => {
        clearTimeout(timeout);
        this.responseHandlers.delete(expectedResponse);
        resolve(response);
      });

      this.socket!.send(msgStr, UDP_PORT, this.gatewayIP, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.responseHandlers.delete(expectedResponse);
          reject(err);
        }
      });
    });
  }

  async getDeviceList(): Promise<DeviceListResponse> {
    const message: MotionMessage = {
      msgType: 'GetDeviceList',
      msgID: generateMsgID(),
    };
    const response = await this.send(message);
    return response as unknown as DeviceListResponse;
  }

  async readDevice(mac: string, deviceType: string = '10000000'): Promise<WriteDeviceResponse> {
    const message: MotionMessage = {
      msgType: 'ReadDevice',
      msgID: generateMsgID(),
      mac,
      deviceType,
      AccessToken: this.accessToken,
    };
    const response = await this.send(message);
    return response as unknown as WriteDeviceResponse;
  }

  async writeDevice(
    mac: string,
    operation: Operation,
    targetPosition?: number,
    deviceType: string = '10000000',
  ): Promise<WriteDeviceResponse> {
    const data: Record<string, unknown> = { operation };

    if (targetPosition !== undefined) {
      data.targetPosition = Math.max(0, Math.min(100, targetPosition));
    }

    const message: MotionMessage = {
      msgType: 'WriteDevice',
      msgID: generateMsgID(),
      mac,
      deviceType,
      AccessToken: this.accessToken,
      data,
    };
    const response = await this.send(message);
    return response as unknown as WriteDeviceResponse;
  }

  async open(mac: string): Promise<WriteDeviceResponse> {
    return this.writeDevice(mac, Operation.Open);
  }

  async close(mac: string): Promise<WriteDeviceResponse> {
    return this.writeDevice(mac, Operation.Close);
  }

  async stop(mac: string): Promise<WriteDeviceResponse> {
    return this.writeDevice(mac, Operation.Stop);
  }

  async setPosition(mac: string, position: number): Promise<WriteDeviceResponse> {
    // Protocol: 0 = fully open, 100 = fully closed
    // We pass targetPosition with operation Close
    return this.writeDevice(mac, Operation.Close, position);
  }

  async getStatus(mac: string): Promise<WriteDeviceResponse> {
    return this.writeDevice(mac, Operation.StatusQuery);
  }

  hasValidToken(): boolean {
    return this.accessToken.length > 0;
  }

  startStatusPolling(macs: string[], intervalMs: number = 60000): void {
    if (this.statusPollingTimer) {
      clearInterval(this.statusPollingTimer);
    }

    this.statusPollingTimer = setInterval(async () => {
      for (const mac of macs) {
        try {
          await this.getStatus(mac);
        } catch (e) {
          this.log.debug(`Failed to poll status for ${mac}:`, e);
        }
      }
    }, intervalMs);
  }
}
