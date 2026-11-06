'use client';
import { useState } from 'react';
import { AtharNextProvider, createNextClient } from '@upax-ai/athar/next';
import { folioContext } from '@upax-ai/athar/folio';

export function Analytics({ children }) {
  const [client] = useState(() => createNextClient({
    site: 'public-site-token', host: 'https://collector.example', flushInterval: 0, beforeSend: folioContext(),
  }));
  return <AtharNextProvider client={client}>{children}</AtharNextProvider>;
}
