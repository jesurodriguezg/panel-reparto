import { getStore } from '@netlify/blobs';
import serverAppModule from '../../server/app.js';

const { createServerApp } = serverAppModule;

const STORE_NAME = 'panel-reparto-data';
const STATE_KEY = 'state';

export default async () => {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const storedState = await store.get(STATE_KEY, { type: 'json', consistency: 'strong' });
  if (!storedState || typeof storedState !== 'object') {
    return;
  }

  const app = createServerApp({
    host: '0.0.0.0',
    disablePolling: true,
    forcePure: true,
    memoryOnly: true
  });
  app.appDb.importStateSnapshot(storedState);
  app.appDb.resetDirty();

  const settings = app.appDb.getRawSettings();
  if (!settings.auto_assign_enabled) {
    return;
  }

  await app.refreshBoardState({ forceRefresh: true });
  await app.runAutoAssign();

  if (app.appDb.isDirty()) {
    await store.setJSON(STATE_KEY, app.appDb.exportStateSnapshot());
    app.appDb.resetDirty();
  }
};

export const config = {
  // Ejecuta cada minuto (UTC) solo en deploys publicados de producción
  schedule: '* * * * *'
};
