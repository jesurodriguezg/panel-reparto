import { EventEmitter } from 'node:events';
import { getStore, getDeployStore } from '@netlify/blobs';
import serverAppModule from '../../server/app.js';

const { createServerApp } = serverAppModule;

const STORE_NAME = 'panel-reparto-data';
const STATE_KEY = 'state';

function resolveBlobStore(context) {
  const deployCtx = context?.deploy?.context;
  // Aislamiento: Deploy Previews y branch deploys usan store por deploy para nunca alterar producción
  if (deployCtx && deployCtx !== 'production') {
    return getDeployStore({ name: STORE_NAME, consistency: 'strong' });
  }
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

let cachedApp = null;

function getServerApp() {
  if (!cachedApp) {
    cachedApp = createServerApp({
      host: '0.0.0.0',
      disablePolling: true,
      forcePure: true,
      memoryOnly: true
    });
  }
  return cachedApp;
}

async function invokeNodeHandler(handler, request, context) {
  const urlObj = new URL(request.url);
  const req = new EventEmitter();
  req.method = request.method;
  req.url = `${urlObj.pathname}${urlObj.search}`;
  req.headers = {};
  for (const [k, v] of request.headers.entries()) {
    req.headers[k.toLowerCase()] = v;
  }
  if (!req.headers.host) {
    req.headers.host = urlObj.host;
  }
  if (!req.headers['x-forwarded-proto']) {
    req.headers['x-forwarded-proto'] = urlObj.protocol.replace(':', '');
  }
  req.socket = {
    remoteAddress: context?.ip || req.headers['x-nf-client-connection-ip'] || '127.0.0.1',
    encrypted: urlObj.protocol === 'https:'
  };

  let bodyBuf = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const arrBuf = await request.arrayBuffer();
    if (arrBuf && arrBuf.byteLength > 0) {
      bodyBuf = Buffer.from(arrBuf);
    }
  }

  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const responseHeaders = new Headers();
    const chunks = [];

    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) {
          if (v === undefined || v === null) continue;
          if (Array.isArray(v)) {
            for (const item of v) responseHeaders.append(k, String(item));
          } else {
            responseHeaders.append(k, String(v));
          }
        }
        return this;
      },
      write(chunk) {
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const finalBuf = Buffer.concat(chunks);
        resolve(
          new Response(finalBuf.length > 0 ? finalBuf : null, {
            status: statusCode,
            headers: responseHeaders
          })
        );
      }
    };

    Promise.resolve(handler(req, res)).catch(reject);

    process.nextTick(() => {
      if (bodyBuf) {
        req.emit('data', bodyBuf);
      }
      req.emit('end');
    });
  });
}

export default async (request, context) => {
  const store = resolveBlobStore(context);
  const app = getServerApp();

  // 1. Cargar estado más reciente desde Netlify Blobs (consistencia fuerte)
  const storedState = await store.get(STATE_KEY, { type: 'json', consistency: 'strong' });
  if (storedState && typeof storedState === 'object') {
    app.appDb.importStateSnapshot(storedState);
  }
  app.appDb.resetDirty();

  // 2. Ejecutar ruta API existente
  const response = await invokeNodeHandler(app.handleRequest, request, context);

  // 3. Persistir en Netlify Blobs únicamente si hubo escrituras
  if (app.appDb.isDirty()) {
    await store.setJSON(STATE_KEY, app.appDb.exportStateSnapshot());
    app.appDb.resetDirty();
  }

  return response;
};

export const config = {
  path: '/api/*'
};
