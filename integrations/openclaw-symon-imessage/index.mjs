import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { handleMessage, hookTimeoutMs, readBridgeConfig } from './core.mjs';

const contract = defineFeatureContract({
  pluginId: 'symon-imessage-bridge',
  operations: {},
  events: {},
});

export default defineFeaturePlugin({
  contract,
  name: 'Symon iMessage bridge',
  description: 'Routes selected iMessage conversations to the local Symon text endpoint.',
  setup(api) {
    api.on('before_dispatch', async (event, ctx) => {
      const result = await handleMessage(event, ctx, readBridgeConfig());
      return result ?? { handled: false };
    }, { timeoutMs: hookTimeoutMs });
    return {};
  },
});
