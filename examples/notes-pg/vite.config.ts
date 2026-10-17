import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { openvoid } from '@openvoid/node';

export default defineConfig({
  // openvoid() must come first: it resolves void/db, void/kv and void/storage before
  // Void's Node target would reject them.
  plugins: [openvoid(), voidPlugin()],
});
