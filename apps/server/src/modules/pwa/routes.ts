import fastifyStatic from '@fastify/static';
import fp from 'fastify-plugin';

export default fp<{ root: string }>(
  async (app, { root }) => {
    await app.register(fastifyStatic, {
      root,
      wildcard: true,
      index: ['index.html'],
      setHeaders(res, filePath) {
        if (/(?:^|[\\/])(?:index\.html|sw\.js|manifest\.json)$/.test(filePath)) {
          res.header('Cache-Control', 'no-cache');
        } else if (filePath.includes('_expo')) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'public, max-age=3600');
        }
      },
    });

    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0]!;
      const clientRoute = !path.startsWith('/v1/') && path !== '/health' && !path.split('/').at(-1)?.includes('.');
      if ((req.method === 'GET' || req.method === 'HEAD') && clientRoute) await reply.sendFile('index.html');
    });
  },
  { name: 'pwa' },
);
