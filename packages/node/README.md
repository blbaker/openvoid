# @blbaker/openvoid

Run Void apps on Node.js with your own database, key-value store and object storage.

```sh
npm install -D @blbaker/openvoid
npm install @hono/node-server
```

Then put OpenVoid in front of Void's plugin in `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { openvoid } from '@blbaker/openvoid';

export default defineConfig({
  plugins: [openvoid(), voidPlugin()],
});
```

Documentation, recipes and configuration: https://github.com/blbaker/openvoid
