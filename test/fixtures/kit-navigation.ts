/** Test-only stand-in for SvelteKit's virtual module, replaced in the lifecycle tests. */
export function afterNavigate(_callback: () => void): void {
  throw new Error('SvelteKit navigation must be supplied by its runtime');
}
