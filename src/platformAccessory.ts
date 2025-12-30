import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { MotionBlindsPlatform, BlindConfig } from './platform.js';
import type { BlindState } from './motionGateway.js';

// Position tolerance for considering target reached
const POSITION_TOLERANCE = 2;

// Maximum time to wait for blind to reach target (ms) - fail-safe
const MAX_MOVEMENT_TIMEOUT = 90000;

// Polling intervals after command (ms) - very aggressive for responsive UI
const POLL_INTERVALS = [
  300, 300, 300, 300, 300, 300, 300,  // Every 300ms for first 2.1s
  500, 500, 500, 500, 500, 500,        // Every 500ms for next 3s
  1000, 1000, 1000, 1000, 1000,        // Every 1s for next 5s
  2000, 2000, 2000, 2000, 2000,        // Every 2s for next 10s
  5000, 5000, 5000, 5000, 5000, 5000,  // Every 5s for next 30s
];

// HomeKit position states
const POSITION_STATE = {
  DECREASING: 0, // closing
  INCREASING: 1, // opening
  STOPPED: 2,
};

/**
 * Motion Blind Accessory
 * Implements WindowCovering service for HomeKit
 *
 * Uses an internal state machine to track blind movement since the gateway
 * often reports incorrect "stopped" state during movement.
 */
export class MotionBlindAccessory {
  private service: Service;

  // Confirmed state (from gateway when idle)
  private confirmedPosition: number = 0;

  // Display state (what we show to HomeKit)
  private displayPosition: number = 0;
  private displayTargetPosition: number = 0;
  private displayPositionState: number = POSITION_STATE.STOPPED;

  // Command tracking
  private commandInProgress: boolean = false;
  private commandTarget: number = 0;
  private commandDirection: number = POSITION_STATE.STOPPED;
  private commandTimeoutTimer: NodeJS.Timeout | null = null;

  // Polling
  private pollTimers: NodeJS.Timeout[] = [];

  private readonly device: BlindConfig;

  constructor(
    private readonly platform: MotionBlindsPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as BlindConfig;

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Motion')
      .setCharacteristic(this.platform.Characteristic.Model, 'Motion Blind')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.mac);

    // Get or create WindowCovering service
    this.service = this.accessory.getService(this.platform.Service.WindowCovering)
      || this.accessory.addService(this.platform.Service.WindowCovering);

    // Set the service name
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    // Register handlers
    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(() => this.displayPosition);

    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(() => this.displayTargetPosition)
      .onSet(this.setTargetPosition.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(() => this.displayPositionState);
  }

  /**
   * Convert protocol position to HomeKit position
   * Protocol: 0 = fully open, 100 = fully closed
   * HomeKit: 0 = fully closed, 100 = fully open
   */
  private protocolToHomeKit(protocolPosition: number): number {
    return 100 - protocolPosition;
  }

  private homeKitToProtocol(homeKitPosition: number): number {
    return 100 - homeKitPosition;
  }

  /**
   * Check if position has reached target
   */
  private hasReachedTarget(position: number): boolean {
    return Math.abs(position - this.commandTarget) <= POSITION_TOLERANCE;
  }

  /**
   * Cancel any in-progress command and clean up
   */
  private cancelCurrentCommand(): void {
    this.commandInProgress = false;
    this.clearCommandTimeout();
    this.cancelPolling();
  }

  /**
   * Complete the current command - blind has reached target
   */
  private completeCommand(finalPosition: number): void {
    this.platform.log.info(
      `${this.device.name} reached target: ${finalPosition}%`,
    );

    this.commandInProgress = false;
    this.confirmedPosition = finalPosition;
    this.displayPosition = finalPosition;
    this.displayTargetPosition = finalPosition;
    this.displayPositionState = POSITION_STATE.STOPPED;

    this.clearCommandTimeout();
    this.cancelPolling();

    this.pushStateToHomeKit();
  }

  /**
   * Handle command timeout - blind didn't reach target in time
   */
  private handleCommandTimeout(): void {
    this.platform.log.warn(
      `${this.device.name} movement timeout - blind may not have reached target ${this.commandTarget}%`,
    );

    // Use last known position
    this.commandInProgress = false;
    this.displayPositionState = POSITION_STATE.STOPPED;
    this.displayTargetPosition = this.displayPosition;

    this.cancelPolling();
    this.pushStateToHomeKit();

    // Request fresh status
    this.platform.gateway?.getStatus(this.device.mac).catch(() => {});
  }

  /**
   * Update state from gateway response
   */
  updateState(state: BlindState): void {
    const gatewayPosition = this.protocolToHomeKit(state.currentPosition);

    this.platform.log.debug(
      `${this.device.name} gateway: position=${gatewayPosition}%, ` +
      `commandInProgress=${this.commandInProgress}, target=${this.commandTarget}%`,
    );

    if (!this.commandInProgress) {
      // No command in progress - trust gateway completely
      this.confirmedPosition = gatewayPosition;
      this.displayPosition = gatewayPosition;
      this.displayTargetPosition = gatewayPosition;
      this.displayPositionState = POSITION_STATE.STOPPED;
      this.pushStateToHomeKit();
      return;
    }

    // Command in progress - check if we've reached target
    if (this.hasReachedTarget(gatewayPosition)) {
      this.completeCommand(gatewayPosition);
      return;
    }

    // Still moving - update position if it's progressing toward target
    const isProgressing = this.commandDirection === POSITION_STATE.INCREASING
      ? gatewayPosition > this.displayPosition
      : gatewayPosition < this.displayPosition;

    if (isProgressing) {
      this.displayPosition = gatewayPosition;
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentPosition,
        this.displayPosition,
      );
      this.platform.log.debug(
        `${this.device.name} progress: ${this.displayPosition}% -> ${this.commandTarget}%`,
      );
    }

    // Keep showing movement state (don't trust gateway's "stopped" until target reached)
  }

  /**
   * Handle SET TargetPosition from HomeKit
   */
  async setTargetPosition(value: CharacteristicValue): Promise<void> {
    const targetPosition = value as number;

    if (!this.platform.gateway) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    // Get current position for comparison
    const currentPos = this.commandInProgress ? this.displayPosition : this.confirmedPosition;

    // Check if this is a "stop" command (target ≈ current while moving)
    // This happens when user taps again to stop a moving blind
    if (this.commandInProgress && Math.abs(targetPosition - currentPos) <= POSITION_TOLERANCE) {
      this.platform.log.info(`${this.device.name} STOP command (target=${targetPosition}%, current=${currentPos}%)`);

      // Cancel current command tracking
      this.cancelCurrentCommand();

      // Send stop command to blind
      try {
        await this.platform.gateway.stop(this.device.mac);
      } catch (e) {
        this.platform.log.debug(`${this.device.name} stop command failed:`, e);
      }

      // Update state to stopped at current position
      this.displayTargetPosition = currentPos;
      this.displayPositionState = POSITION_STATE.STOPPED;
      this.pushStateToHomeKit();

      // Poll to get actual position after stop
      setTimeout(async () => {
        try {
          await this.platform.gateway?.getStatus(this.device.mac);
        } catch (e) { /* ignore */ }
      }, 500);

      return;
    }

    // Check if already at target (no movement needed)
    if (Math.abs(targetPosition - currentPos) <= POSITION_TOLERANCE) {
      this.platform.log.debug(`${this.device.name} already at target position`);
      this.displayTargetPosition = targetPosition;
      this.pushStateToHomeKit();
      return;
    }

    // New movement command - cancel any existing command first
    if (this.commandInProgress) {
      this.platform.log.info(`${this.device.name} canceling previous command, new target: ${targetPosition}%`);
      this.cancelCurrentCommand();

      // Send stop first to interrupt current movement
      try {
        await this.platform.gateway.stop(this.device.mac);
      } catch (e) {
        this.platform.log.debug(`${this.device.name} stop before new command failed:`, e);
      }
    }

    this.platform.log.info(`${this.device.name} command: move to ${targetPosition}%`);

    // Set up command tracking
    this.commandInProgress = true;
    this.commandTarget = targetPosition;
    this.commandDirection = targetPosition > currentPos
      ? POSITION_STATE.INCREASING
      : POSITION_STATE.DECREASING;

    // Update display state immediately
    this.displayTargetPosition = targetPosition;
    this.displayPositionState = this.commandDirection;
    this.pushStateToHomeKit();

    // Set up timeout fail-safe
    this.clearCommandTimeout();
    this.commandTimeoutTimer = setTimeout(() => {
      if (this.commandInProgress) {
        this.handleCommandTimeout();
      }
    }, MAX_MOVEMENT_TIMEOUT);

    // Send command to blind
    try {
      const protocolPosition = this.homeKitToProtocol(targetPosition);
      await this.platform.gateway.setPosition(this.device.mac, protocolPosition);
      this.platform.log.debug(`${this.device.name} command sent successfully`);

      // Start polling for status updates
      this.schedulePolling();
    } catch (e) {
      this.platform.log.error(`${this.device.name} command failed:`, e);

      // Revert state
      this.commandInProgress = false;
      this.displayPositionState = POSITION_STATE.STOPPED;
      this.displayTargetPosition = this.displayPosition;
      this.clearCommandTimeout();
      this.pushStateToHomeKit();

      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /**
   * Push current display state to HomeKit
   */
  private pushStateToHomeKit(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentPosition,
      this.displayPosition,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetPosition,
      this.displayTargetPosition,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.PositionState,
      this.displayPositionState,
    );
  }

  /**
   * Schedule polling to check for target reached
   */
  private schedulePolling(): void {
    this.cancelPolling();

    let cumulativeDelay = 0;
    for (const interval of POLL_INTERVALS) {
      cumulativeDelay += interval;
      const timer = setTimeout(async () => {
        if (!this.commandInProgress) {
          return;
        }
        try {
          await this.platform.gateway?.getStatus(this.device.mac);
        } catch (e) {
          this.platform.log.debug(`${this.device.name} poll failed:`, e);
        }
      }, cumulativeDelay);

      this.pollTimers.push(timer);
    }
  }

  private cancelPolling(): void {
    for (const timer of this.pollTimers) {
      clearTimeout(timer);
    }
    this.pollTimers = [];
  }

  private clearCommandTimeout(): void {
    if (this.commandTimeoutTimer) {
      clearTimeout(this.commandTimeoutTimer);
      this.commandTimeoutTimer = null;
    }
  }
}
