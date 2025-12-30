# Homebridge Motion Blinds Local

Local UDP control for Motion Blinds and compatible devices (Bliss, Brel, etc.) via Homebridge.

## Features

- **100% Local Control** - No cloud services, all communication stays on your network
- **Auto-Discovery** - Blinds are automatically discovered from your gateway
- **Real-time Status** - Responsive position tracking during blind movement
- **HomeKit Integration** - Control blinds via Home app, Siri, and automations

## Installation

### Via Homebridge UI

Search for `homebridge-motion-blinds-local` in the Homebridge UI plugins tab.

### Via Command Line

```bash
npm install -g homebridge-motion-blinds-local
```

## Configuration

### Required Settings

| Setting | Description |
|---------|-------------|
| Gateway IP | The IP address of your Motion Blinds gateway |
| API Key | A 16-character authentication key from your app (see below) |

### Finding Your API Key

The API key is required for authentication with your gateway. Here's how to find it:

#### Motion Blinds App
1. Open the Motion Blinds app
2. Tap the **Settings** (gear icon)
3. Tap **About**
4. The API key is displayed on this screen

#### Bliss App (and other white-label apps)
1. Open the sidebar menu
2. Tap on your **user photo/profile**
3. Tap **About**
4. **Tap 5 times quickly** on the About screen
5. The API key will be revealed

### Finding Your Gateway IP

You can find the gateway IP address by:
- Checking your router's connected devices list
- Looking in the Motion Blinds / Bliss app settings
- The gateway usually has a hostname like `motion-gateway` or similar

### Optional Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Blinds | Auto-discovered | Manually specify blinds if you want custom names |
| Polling Interval | 60000ms | How often to poll status when idle |

## Example Configuration

```json
{
  "platforms": [
    {
      "platform": "MotionBlindsLocal",
      "name": "Motion Blinds",
      "gatewayIp": "192.168.1.187",
      "key": "xxxxxxxx-xxxx-xx"
    }
  ]
}
```

With manual blind configuration (for custom names):

```json
{
  "platforms": [
    {
      "platform": "MotionBlindsLocal",
      "name": "Motion Blinds",
      "gatewayIp": "192.168.1.187",
      "key": "xxxxxxxx-xxxx-xx",
      "blinds": [
        {
          "mac": "4c7525178bf70001",
          "name": "Living Room Left"
        },
        {
          "mac": "4c7525178bf70002",
          "name": "Living Room Right"
        }
      ]
    }
  ]
}
```

## Compatible Devices

This plugin works with devices using the Motion Blinds UDP protocol, including:

- Motion Blinds
- Bliss Blinds
- Brel Home
- Other white-label Motion Blinds products

## Troubleshooting

### "Gateway not connected" error
- Verify the gateway IP address is correct
- Ensure Homebridge can reach the gateway on UDP port 32100
- Check that no firewall is blocking UDP traffic

### Commands not working
- Verify your API key is correct (16 characters)
- Check the Homebridge logs for authentication errors

### Blinds not discovered
- Ensure your blinds are paired with the gateway via the official app first
- Try restarting Homebridge after the gateway is online

## License

Apache-2.0
