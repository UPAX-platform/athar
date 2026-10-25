"use client";

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { BrowserClient } from '@upax-ai/athar/browser';

const AtharContext = createContext<BrowserClient | null>(null);

/** Create the client once outside render. This provider owns its start/stop lifecycle. */
export function AtharProvider({ client, children }: { client: BrowserClient; children?: ReactNode }) {
  useEffect(() => {
    client.start();
    return () => { client.stop(); void client.flush().catch(() => {}); };
  }, [client]);
  return <AtharContext.Provider value={client}>{children}</AtharContext.Provider>;
}

export function useAthar(): BrowserClient {
  const client = useContext(AtharContext);
  if (!client) throw new Error('useAthar must be used within AtharProvider');
  return client;
}
