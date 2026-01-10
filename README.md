# Domain Migrator Chrome Extension

A Chrome extension to help migrate domains between registrars (GoDaddy, Squarespace → Cloudflare).

## Features

- **Overlay UI** on registrar dashboards showing domain info
- **Extract auth codes** from source registrars
- **Get Cloudflare nameservers** and copy them to clipboard
- **Track migration progress** across multiple domains
- **Auto-detect domains** when browsing registrar dashboards

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this folder (`domain-migrator-extension`)

## Usage

### Migrating from GoDaddy to Cloudflare

1. **Add domain to Cloudflare**
   - Go to Cloudflare Dashboard
   - Add your domain
   - The extension will detect and save the assigned nameservers

2. **Get Cloudflare nameservers**
   - On Cloudflare DNS page, click "Get Cloudflare NS" in the overlay
   - Copy the nameservers

3. **Update nameservers at GoDaddy**
   - Go to GoDaddy DNS Management for your domain
   - Click "Change Nameservers"
   - Paste Cloudflare nameservers
   - Save

4. **Get auth code from GoDaddy**
   - Go to Domain Settings → Transfer
   - Click "Get Auth Code" in the overlay
   - The code will be saved and displayed

5. **Initiate transfer at Cloudflare**
   - Go to Cloudflare → Domain Registration → Transfer
   - Enter auth code

### Tracking Progress

Click the extension icon in your toolbar to see:
- All tracked domains
- Migration status for each
- Auth codes and nameservers collected

## Supported Registrars

- **GoDaddy** (source) - Full support
- **Squarespace** (source) - Basic support
- **Cloudflare** (destination) - Full support

## Development

```bash
# Watch for changes and reload
# Just edit files and click "Update" on chrome://extensions/
```

## Files

```
domain-migrator-extension/
├── manifest.json           # Extension config
├── background.js           # Service worker for state management
├── popup/
│   ├── popup.html         # Extension popup UI
│   └── popup.js           # Popup logic
├── content-scripts/
│   ├── godaddy.js         # GoDaddy page integration
│   ├── cloudflare.js      # Cloudflare page integration
│   ├── squarespace.js     # Squarespace page integration
│   └── overlay.css        # Overlay styling
└── icons/
    └── icon*.png          # Extension icons
```

## Privacy

- All data stored locally in Chrome storage
- No data sent to external servers
- Only activates on supported registrar domains
