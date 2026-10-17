import { defineEnv, string } from 'void/env';

export default defineEnv({
  APP_NAME: string().default('OpenVoid notes'),
});
