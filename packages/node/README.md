# @openvoid/node

Run Void apps on Node.js with your own database, key-value store and object storage.

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { openvoid } from '@openvoid/node';

export default defineConfig({
  plugins: [openvoid(), voidPlugin()],
});
```

Documentation, recipes and configuration: https://github.com/blbaker/openvoid
