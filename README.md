# USD1 Monitor

Monitor the USD1 balance of `0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D` and send a Bark alert when it drops below `6,000,000`.

## Run

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## What it does

- Reads the ERC-20 balance directly from Ethereum mainnet through JSON-RPC
- Shows the latest balance and threshold in a local web UI
- Sends Bark notifications when the balance falls below the threshold
- Sends a recovery notification when the balance rises above the threshold again
- Supports Bark `critical` level, ringtone, call mode, volume, icon and click URL
- Persists your settings in `data/config.json`
