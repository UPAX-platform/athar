import { fileURLToPath } from 'node:url';

const dist = name => `../../../dist/${name}.js`;

export default {
  turbopack: {
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    resolveAlias: Object.fromEntries(['browser', 'react', 'next', 'folio'].map(name => [`@upax-ai/athar/${name}`, dist(name)])),
  },
};
