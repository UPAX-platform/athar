export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Properties = Record<string, Json>;
export type Consent = 'unknown' | 'granted' | 'denied';

/** Public collector event contract. Timestamps are Unix milliseconds. */
export interface AnalyticsEvent {
  id: string;
  ts: number;
  name: string;
  url?: string;
  ref?: string;
  sid?: string;
  vid?: string;
  utm?: Record<string, string>;
  props: Properties;
}

export interface EventContext {
  url?: string;
  referrer?: string;
  sessionId?: string;
  visitorId?: string;
  timestamp?: number;
  utm?: Record<string, string>;
}

export interface Identity {
  email?: string;
  external_id?: string;
}

export interface ClientOptions {
  /** Public site token; never use an administrative credential. */
  site: string;
  /** Collector base URL, explicitly supplied by the consumer. */
  host: string;
  fetch?: typeof globalThis.fetch;
  batchSize?: number;
  maxQueueSize?: number;
  flushInterval?: number;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  /** Return null to discard an event. Runs before payload validation. */
  beforeSend?: (event: AnalyticsEvent) => AnalyticsEvent | null;
  onError?: (error: Error) => void;
}

export interface AnalyticsClient {
  /** Returns false when an event is invalid, filtered, or the queue is full. */
  track(name: string, props?: Properties, context?: EventContext): boolean;
  page(context?: EventContext, props?: Properties): boolean;
  /** Resolves on HTTP acknowledgement; rejects on delivery failure. */
  identify(identity: Identity, context: EventContext): Promise<void>;
  flush(): Promise<void>;
  /** Stops accepting events and drains the existing queue. May be retried. */
  shutdown(): Promise<void>;
}
