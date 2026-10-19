declare module '*.svelte' {
  const component: import('svelte').Component<{
    options: import('../src/browser').BrowserOptions;
    ready: (client: import('../src/browser').BrowserClient) => void;
  }>;
  export default component;
}
